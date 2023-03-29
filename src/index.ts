import chokidar from "chokidar";
import * as fs from "fs/promises";
import * as path from "path";
import * as util from "util";
import { exec } from "child_process";
import { Stats } from "fs";

import { Logger } from "./lib/src/logger";

//@ts-ignore
import { PouchDB as PouchDB_src } from "./pouchdb.js";

import { configFile, connectConfig, eachConf } from "./types.js";
import { addKnownFile, addTouchedFile, calcDateDiff, DATEDIFF_EVEN, DATEDIFF_NEWER_A, DATEDIFF_OLDER_A, isKnownFile, isPlainText, isTouchedFile, path2unix } from "./util.js";
import { EntryDoc, Entry, EntryLeaf, LoadedEntry, NewEntry, PlainEntry, LOG_LEVEL, MAX_DOC_SIZE, MAX_DOC_SIZE_BIN, } from "./lib/src/types.js";
import { DBFunctionEnvironment, getDBEntry, putDBEntry } from "./lib/src/LiveSyncDBFunctions.js";
import { LRUCache } from "./lib/src/LRUCache.js";
import { enableEncryption } from "./lib/src/utils_couchdb.js";
import { id2path_base, path2id_base } from "./lib/src/path.js";
import { getDocData, getDocDataAsArray } from "./lib/src/utils.js";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./lib/src/strbin.js";
import { logStore } from "./lib/src/stores";

const xxhash = require("xxhash-wasm");

const PouchDB: PouchDB.Static<{}> = PouchDB_src;

const statFile = "./dat/stat.json";

let running: { [key: string]: boolean } = {};

let h32Raw: (inputBuffer: Uint8Array, seed?: number | undefined) => number;
let h32: (input: string, seed?: number) => string;

let syncStat: { [key: string]: string };
let saveStatTimer: NodeJS.Timeout | undefined = undefined;
let saveStatCount: 0;

function log(log: any) {
    Logger(log, LOG_LEVEL.INFO);
}

logStore.subscribe((e) => {
    const message = e.message;
    const timestamp = new Date().toLocaleString();
    const messagecontent = typeof message == "string" ? message : message instanceof Error ? `${message.name}:${message.message}` : JSON.stringify(message, null, 2);
    const newmessage = timestamp + "->" + messagecontent;
    console.log(newmessage);
});

function delay(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(() => res(), ms));
}

async function saveStat() {
    await fs.writeFile(statFile, JSON.stringify(syncStat));
}
function triggerSaveStat() {
    if (saveStatTimer == undefined) clearTimeout(saveStatTimer);
    if (saveStatCount > 25) {
        saveStatTimer = undefined;
        saveStatCount = 0;
        saveStat();
    } else {
        saveStatCount++;
        saveStatTimer = setTimeout(() => {
            saveStat();
        }, 500);
    }
}

let processorTimer: NodeJS.Timeout | undefined = undefined;
async function runEngine() {
    let processors = [...waitingProcessorList];
    waitingProcessorList = [];
    log("Run external commands.");
    const execPromise = util.promisify(exec);
    const procs = processors.map((e) => execPromise(e));
    let results = await Promise.allSettled(procs);
    for (const result of results) {
        if (result.status == "rejected") {
            log(`Failed! Reason:${result.reason}`);
        } else {
            log(`OK: stdout:${result.value.stdout}`);
            log(`OK: stderr:${result.value.stderr}`);
        }
    }
}
let waitingProcessorList: string[] = [];
function triggerProcessor(procs: string) {
    if (procs == "") return;
    waitingProcessorList = Array.from(new Set([...waitingProcessorList, procs]));
    if (processorTimer == undefined) clearTimeout(processorTimer);
    processorTimer = setTimeout(() => {
        runEngine();
    }, 500);
}

const hashCaches = new LRUCache();
// Run synchronization for each config
async function eachProc(syncKey: string, config: eachConf) {
    log(`${syncKey} started`);

    const serverURI = config.server.uri;
    const serverAuth = config.server.auth;
    const serverPath = config.server.path ?? "";

    const exportPath = config.local?.path ?? "";
    const processor = config.local?.processor ?? "";
    const deleteMetadataOfDeletedFiles = config.deleteMetadataOfDeletedFiles ?? false;
    const customChunkSize = config.server.customChunkSize ?? 0;

    const remote = new PouchDB(serverURI, { auth: serverAuth });
    if (serverAuth.passphrase != "") {
        enableEncryption(remote as PouchDB.Database<EntryDoc>, serverAuth.passphrase, false);
    }

    async function sanityCheck() {
        let mr = await remote.info();
        log("Main Remote Database");
        log(mr);
    }

    if (!(syncKey in syncStat)) {
        syncStat[syncKey] = "now";
    }

    try {
        await sanityCheck();
    } catch (ex) {
        log("Error on checking database");
        log(ex);
        process.exit(-1);
    }

    const storagePathRoot = path.resolve(exportPath);
    let conf: connectConfig = {
        syncKey: syncKey,
        fromDB: remote,
        fromPrefix: serverPath,
        passphrase: serverAuth.passphrase,
        deleteMetadataOfDeletedFiles: deleteMetadataOfDeletedFiles,
        customChunkSize: customChunkSize
    };


    const env: DBFunctionEnvironment = {
        localDatabase: remote as PouchDB.Database<NewEntry | PlainEntry | EntryLeaf>,
        id2path: function (filename: string): string {
            return id2path_base(filename);
        },
        path2id: function (filename: string): string {
            return path2id_base(filename);
        },
        isTargetFile: function (file: string): boolean {
            if (file.includes(":")) return false;
            return true;
        },
        settings: {
            customChunkSize: customChunkSize,
            deleteMetadataOfDeletedFiles: false,
            encrypt: conf.passphrase.trim() != "",
            passphrase: conf.passphrase,
            minimumChunkSize: 20,
            readChunksOnline: true,
        },
        corruptedEntries: {},
        CollectChunks: async function (ids: string[], showResult?: boolean, waitForReady?: boolean): Promise<false | EntryLeaf[]> {
            const allDocs = async function* () {
                const limit = Math.max(10, Math.min(4000 / (conf.customChunkSize), 25));
                const reqIds = [...ids];
                do {
                    try {
                        const reqKeys = reqIds.splice(0, limit);
                        // console.log(`requesting (${reqKeys.length} / ${reqIds.length})`);
                        const chunks = await env.localDatabase.allDocs({ keys: reqKeys, include_docs: true });
                        yield chunks.rows
                    } catch (ex) {
                        return;
                    }
                } while (reqIds.length > 0);
                return;
            }();

            const chunkDocs = [];
            for await (const v of allDocs) {
                chunkDocs.push(...v);
            }
            const ret = [];
            if (chunkDocs.some(e => "error" in e)) {
                const missingChunks = chunkDocs.filter(e => "error" in e).map(e => e.id).join(", ");
                Logger(`Could not retrieve chunks. Chunks are missing:${missingChunks}`, LOG_LEVEL.NOTICE);
                return false;
            }
            if (chunkDocs.some(e => e.doc && e.doc.type != "leaf")) {
                const missingChunks = chunkDocs.filter(e => e.doc && e.doc.type != "leaf").map(e => e.id).join(", ");
                Logger(`Could not retrieve chunks. corrupted chunks::${missingChunks}`, LOG_LEVEL.NOTICE);
                return false;
            }
            return chunkDocs.map(e => e.doc as EntryLeaf);
            // throw new Error("Not implemented and not be called");

        },
        getDBLeaf(id: string, waitForReady: boolean): Promise<string> {
            throw new Error("Not implemented and not be called (GetDBLeaf)");
        },
        hashCaches: hashCaches,
        h32: function (input: string, seed?: number): string {
            return h32(input, seed);
        },
        h32Raw: function (input: Uint8Array, seed?: number): number {
            return h32Raw(input, seed);
        }
    };

    function openConnection(e: connectConfig, auto_reconnect: boolean) {
        Logger(`Connecting ${e.syncKey} with auto_reconnect:${auto_reconnect}`);
        e.fromDB
            .changes({
                live: true,
                include_docs: true,
                // style: "all_docs",
                since: syncStat[syncKey],
                filter: (doc, _) => {
                    return doc._id.startsWith(e.fromPrefix) && isVaildDoc(doc._id);
                },
            })
            .on("change", async function (change) {
                if (change.doc?._id.indexOf(":") == -1 && change.doc?._id.startsWith(e.fromPrefix) && isVaildDoc(change.doc._id)) {
                    let x = await transferDoc(e.syncKey, change.doc, e.fromPrefix, e.passphrase, exportPath, deleteMetadataOfDeletedFiles);
                    if (x) {
                        syncStat[syncKey] = change.seq + "";
                        triggerSaveStat();
                        triggerProcessor(processor);
                    }
                }
            })
            .on("error", function (err) {
                Logger("Error");
                Logger(err);
                if (auto_reconnect) {
                    Logger("Performing auto_reconnect");
                    setTimeout(() => {
                        openConnection(e, auto_reconnect);
                    }, 1000);
                }
            })
            .on("complete", (result) => {
                Logger("Connection completed");
                Logger(result);
                if (auto_reconnect) {
                    Logger("Performing auto_reconnect");
                    setTimeout(() => {
                        openConnection(e, auto_reconnect);
                    }, 10000);
                }
            });
    }

    log("start vault watching");


    function storagePathToVaultPath(strStoragePath: string) {
        const rel = path.relative(storagePathRoot, strStoragePath);
        return path2unix(rel);
    }
    function vaultPathToStroageABSPath(strVaultPath: string) {
        const filePath = path.resolve(path.join(storagePathRoot, strVaultPath));
        return filePath;
    }

    const pushFile = async (pathSrc: string, stat: Stats, saveAsBigChunk: boolean) => {
        const id = serverPath + storagePathToVaultPath(pathSrc);
        const docId = id.startsWith("_") ? "/" + id : id;
        try {
            let doc = (await remote.get(docId)) as NewEntry;
            if (doc.mtime) {
                if (calcDateDiff(doc.mtime, stat.mtime) == DATEDIFF_EVEN) {
                    return;
                }
            }
        } catch (ex: any) {
            if (ex.status && ex.status == 404) {
                // NO OP.
                log(`${id} -> maybe new`);
            } else {
                throw ex;
            }
        }
        let content: string | string[] = "";
        let datatype: "newnote" | "plain" = "newnote";
        const d = await fs.readFile(pathSrc);
        if (!isPlainText(pathSrc)) {
            const uint8arr = new Uint8Array(d.byteLength);
            d.copy(uint8arr, 0, 0, d.byteLength);
            content = await arrayBufferToBase64(uint8arr.buffer);
            datatype = "newnote";
        } else {
            content = d.toString();
            datatype = "plain";
        }
        const newNote: LoadedEntry = {
            _id: docId,
            children: [],
            ctime: stat.ctime.getTime(),
            mtime: stat.mtime.getTime(),
            size: stat.size,
            datatype: datatype,
            data: content,
            type: datatype,
        };
        let ret = await putDBEntry(env, newNote, saveAsBigChunk);
        if (ret) {
            addTouchedFile(pathSrc, 0);
            addKnownFile(conf.syncKey, ret.id, ret.rev);
        }
    };
    const unlinkFile = async (pathSrc: string) => {
        const id = serverPath + storagePathToVaultPath(pathSrc);
        const docId = id.startsWith("_") ? "/" + id : id;
        try {
            let oldNote: any = await remote.get(docId);
            if (deleteMetadataOfDeletedFiles) {
                oldNote._deleted = true;
            } else {
                oldNote.deleted = true;
                oldNote.mtime = Date.now();
            }
            let ret = await remote.put(oldNote);
            addKnownFile(conf.syncKey, ret.id, ret.rev);
            addTouchedFile(pathSrc, 0);
        } catch (ex: any) {
            if (ex.status && ex.status == 404) {
                // NO OP.
            } else {
                throw ex;
            }
        }
    };
    // check the document is under the [vault]/[configured_dir]..
    function isTargetFile(pathSrc: string): boolean {
        if (pathSrc.startsWith(serverPath)) {
            return true;
        } else {
            return false;
        }
    }
    async function pullFile(id: string, serverPath: string, localPath: string, deleteMetadataOfDeletedFiles: boolean) {
        const fromDoc = await getDBEntry(env, env.path2id(id), undefined, false, false, true);
        if (!fromDoc) {
            log(`Failed to read file from database:${localPath}`);
            return false;
        }
        const docName = fromDoc._id.substring(serverPath.length);
        const sendDoc: LoadedEntry = {
            ...fromDoc,
            _id: docName.startsWith("_") ? "/" + docName : docName
        }

        if (await exportDoc(env, sendDoc, docName, exportPath)) {
            return true;
        } else {
            log(`Failed:${localPath}`);
            return false;
        }
    }
    async function transferDoc(syncKey: string, fromDoc: PouchDB.Core.ExistingDocument<PouchDB.Core.ChangesMeta>, fromPrefix: string, passphrase: string, exportPath: string, deleteMetadataOfDeletedFiles: boolean): Promise<boolean> {
        const docKey = `${syncKey}: ${fromDoc._id} (${fromDoc._rev})`;
        while (running[syncKey]) {
            await delay(100);
        }
        let result = true;
        try {
            running[syncKey] = true;
            if (isKnownFile(syncKey, fromDoc._id, fromDoc._rev)) {
                return true;
            }
            log(`doc:${docKey} begin Transfer`);
            let continue_count = 3;
            try {

                // const docName = fromDoc._id.substring(fromPrefix.length);
                // let sendDoc: PouchDB.Core.ExistingDocument<PouchDB.Core.ChangesMeta> & { children?: string[]; type?: string; mtime?: number, deleted?: boolean } = { ...fromDoc, _id: docName.startsWith("_") ? "/" + docName : docName };
                let retry = false;
                do {
                    if (retry) {
                        continue_count--;
                        if (continue_count == 0) {
                            log(`doc:${docKey} retry failed`);
                            return false;
                        }
                        await delay(1500);
                    }
                    retry = !await pullFile(fromDoc._id, fromPrefix, exportPath, false);
                } while (retry);
            } catch (ex) {
                log("Exception on transfer doc");
                log(ex);
                result = false;
            }
        } finally {
            running[syncKey] = false;
        }
        return result;
    }

    if (config.sync_on_connect || config.server.initialScan) {
        const dbfiles = await remote.find({ limit: 999999999, selector: { $or: [{ type: "plain" }, { type: "newnote" }] }, fields: ["_id", "mtime"] });

        log(`Waiting for initial sync(Database to storage)`);
        if (dbfiles.docs) {
            for (const doc of dbfiles.docs) {
                if (doc._id.indexOf(":") !== -1) continue;
                const fn = doc._id.startsWith("/") ? doc._id.substring(1) : doc._id;
                if (!isTargetFile(fn)) {
                    continue;
                }

                const localPath = fn.substring(serverPath.length);
                const storageNewFilePath = vaultPathToStroageABSPath(localPath);
                // log(`Checking initial file:${localPath}`);
                // log(`--> file:${storageNewFilePath}`);
                const mtime: number = (doc as any).mtime;
                try {
                    const stat = await fs.stat(storageNewFilePath);
                    const diff = calcDateDiff(stat.mtime, mtime);

                    if (diff == DATEDIFF_NEWER_A) {
                        log(`--> ${localPath}`);
                        await pushFile(storageNewFilePath, stat, false);
                        // return;
                    } else if (diff == DATEDIFF_OLDER_A) {
                        log(`<-- ${localPath}`);
                        await pullFile(doc._id, serverPath, localPath, deleteMetadataOfDeletedFiles);
                    } else {
                        log(`=== ${localPath}`);
                    }
                } catch (ex: any) {
                    if (ex.code == "ENOENT") {
                        log(`<<- ${localPath}`);
                        await pullFile(doc._id, serverPath, localPath, deleteMetadataOfDeletedFiles);
                        // return;
                        continue;
                    } else {
                        log(`Error on checking file:${localPath}`);
                        log(`Error:${ex}`);
                    }
                }
            }
            log(`Done!`);
        }
    }

    const watcher = chokidar.watch(exportPath, {
        ignoreInitial: !config.local.initialScan && !config.sync_on_connect,
        awaitWriteFinish: {
            stabilityThreshold: 500,
        },
    });

    watcher.on("change", async (pathSrc: string, stat: Stats) => {
        const filePath = pathSrc;

        const mtime = stat.mtime.getTime();
        if (isTouchedFile(filePath, mtime)) {
            // log(`Self-detected::${filePath}`);
            return;
        }
        log(`Detected:change:${filePath}`);
        addTouchedFile(pathSrc, mtime);
        await pushFile(pathSrc, stat, false);
    });
    watcher.on("unlink", async (pathSrc: string, stat: Stats) => {
        const filePath = pathSrc;

        if (isTouchedFile(filePath, 0)) {
            // log(`Self-detected::${filePath}`);
            return;
        }
        log(`Detected:delete:${filePath}`);
        await unlinkFile(pathSrc);
    });
    watcher.on("add", async (pathSrc: string, stat: Stats) => {
        const filePath = pathSrc;
        const mtime = stat.mtime.getTime();
        if (isTouchedFile(filePath, mtime)) {
            // log(`Self-detected::${filePath}`);
            return;
        }
        log(`Detected:created:${filePath}`);
        addTouchedFile(pathSrc, mtime);
        await pushFile(pathSrc, stat, true);

        // watchVaultChange(path, stat);
    });
    log("Start Database watching");
    openConnection(conf, config.auto_reconnect ?? false);
}

function isVaildDoc(id: string): boolean {
    if (id == "obsydian_livesync_version") return false;
    if (id.indexOf(":") !== -1) return false;
    return true;
}

async function exportDoc(env: DBFunctionEnvironment, sendDoc: LoadedEntry, docName: string, exportPath: string) {
    const writePath = path.join(exportPath, docName);
    if (sendDoc._deleted || sendDoc.deleted) {


        try {
            addTouchedFile(writePath, 0);
            await fs.unlink(writePath);
            log(`doc:${docName}: Deleted, so delete from ${writePath}`);
        } catch (ex: any) {
            if (ex.code == "ENOENT") {
                log(`doc:${docName}: Deleted, but already not exists on ${writePath}`);
                //NO OP
            } else {
                throw ex;
            }
        }
        return true;
    }

    try {
        const stat_init = await fs.stat(writePath);
        const mtime = sendDoc.mtime ?? new Date().getTime();
        const diff = calcDateDiff(mtime, stat_init.mtime);
        if (diff == DATEDIFF_EVEN) {
            log(`doc:${docName}: Up to date`);
            return true;
        }
    } catch (ex: any) {
        // WRAP IT
        if (ex.code != "ENOENT") {
            log(ex);
        }
    }

    const dirName = path.dirname(writePath);
    log(`doc:${docName}: Exporting to ${writePath}`);
    await fs.mkdir(dirName, { recursive: true });

    const mtime = sendDoc.mtime ?? new Date().getTime();

    addTouchedFile(writePath, mtime);

    const tmtime = ~~(mtime / 1000);
    if (sendDoc.type == "plain") {
        await fs.writeFile(writePath, getDocData(sendDoc.data));
        await fs.utimes(writePath, tmtime, tmtime);
    } else {
        const buf = base64ToArrayBuffer(sendDoc.data)
        const dt_bin = Buffer.from(buf) //new DataView(base64ToArrayBuffer(sendDoc.data));
        await fs.writeFile(writePath, dt_bin, { encoding: "binary" });
        await fs.utimes(writePath, tmtime, tmtime);
    }
    log(`doc:${docName}: Exported`);
    return true;
}


async function main() {
    log("FileSystem-Livesync starting up.");
    let xx = await xxhash();
    h32Raw = xx.h32Raw;
    h32 = xx.h32ToString;
    let config: configFile = JSON.parse((await fs.readFile("./dat/config.json")) + "");

    try {
        syncStat = JSON.parse((await fs.readFile(statFile)) + "");
    } catch (ex) {
        log("could not read pervious sync status, initialized.");
        syncStat = {};
    }

    // Run each processes
    for (const conf of Object.entries(config)) {
        setTimeout(() => eachProc(conf[0], conf[1]), 100);
    }
}

main().then((_) => { });
