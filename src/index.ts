import { decrypt, encrypt } from "./e2ee.js";
import chokidar from "chokidar";
//@ts-ignore
import { PouchDB as PouchDB_src } from "./pouchdb.js";
import * as fs from "fs/promises";
import * as path from "path";
import * as util from "util";
import { exec } from "child_process";

import { Logger } from "./logger.js";
import { configFile, connectConfig, eachConf, Entry, EntryLeaf, LoadedEntry, LOG_LEVEL, MAX_DOC_SIZE, MAX_DOC_SIZE_BIN, NewEntry, PlainEntry } from "./types.js";
import { Stats } from "fs";
import { addTouchedFile, isKnownFile, isPlainText, isTouchedFile, path2unix } from "./util.js";

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

async function main() {
    log("LiveSync-classroom starting up.");
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

    for (const conf of Object.entries(config)) {
        setTimeout(() => eachProc(conf[0], conf[1]), 100);
    }
}

let hashCache: {
    [key: string]: string;
} = {};
let hashCacheRev: {
    [key: string]: string;
} = {};

// putDBEntry:COPIED FROM obsidian-livesync
async function putDBEntry(note: LoadedEntry, passphrase: string, database: PouchDB.Database<NewEntry | PlainEntry | Entry | EntryLeaf>) {
    let leftData = note.data;
    const savenNotes = [];
    let processed = 0;
    let made = 0;
    let skiped = 0;
    let pieceSize = MAX_DOC_SIZE_BIN;
    let plainSplit = false;
    let cacheUsed = 0;
    const userpasswordHash = h32Raw(new TextEncoder().encode(passphrase));
    if (isPlainText(note._id)) {
        pieceSize = MAX_DOC_SIZE;
        plainSplit = true;
    }
    const newLeafs: EntryLeaf[] = [];
    do {
        // To keep low bandwith and database size,
        // Dedup pieces on database.
        // from 0.1.10, for best performance. we use markdown delimiters
        // 1. \n[^\n]{longLineThreshold}[^\n]*\n -> long sentence shuld break.
        // 2. \n\n shold break
        // 3. \r\n\r\n should break
        // 4. \n# should break.
        let cPieceSize = pieceSize;
        if (plainSplit) {
            let minimumChunkSize = 20; //default
            if (minimumChunkSize < 10) minimumChunkSize = 10;
            let longLineThreshold = 250; //default
            if (longLineThreshold < 100) longLineThreshold = 100;
            cPieceSize = 0;
            // lookup for next splittion .
            // we're standing on "\n"
            do {
                const n1 = leftData.indexOf("\n", cPieceSize + 1);
                const n2 = leftData.indexOf("\n\n", cPieceSize + 1);
                const n3 = leftData.indexOf("\r\n\r\n", cPieceSize + 1);
                const n4 = leftData.indexOf("\n#", cPieceSize + 1);
                if (n1 == -1 && n2 == -1 && n3 == -1 && n4 == -1) {
                    cPieceSize = MAX_DOC_SIZE;
                    break;
                }

                if (n1 > longLineThreshold) {
                    // long sentence is an established piece
                    cPieceSize = n1;
                } else {
                    // cPieceSize = Math.min.apply([n2, n3, n4].filter((e) => e > 1));
                    // ^ heavy.
                    if (n1 > 0 && cPieceSize < n1) cPieceSize = n1;
                    if (n2 > 0 && cPieceSize < n2) cPieceSize = n2 + 1;
                    if (n3 > 0 && cPieceSize < n3) cPieceSize = n3 + 3;
                    // Choose shorter, empty line and \n#
                    if (n4 > 0 && cPieceSize > n4) cPieceSize = n4 + 0;
                    cPieceSize++;
                }
            } while (cPieceSize < minimumChunkSize);
        }

        // piece size determined.
        const piece = leftData.substring(0, cPieceSize);
        leftData = leftData.substring(cPieceSize);
        processed++;
        let leafid = "";
        // Get hash of piece.
        let hashedPiece = "";
        let needMake = true;
        if (typeof hashCache[piece] !== "undefined") {
            hashedPiece = "";
            leafid = hashCache[piece];
            needMake = false;
            skiped++;
            cacheUsed++;
        } else {
            if (passphrase != "") {
                // When encryption has been enabled, make hash to be different between each passphrase to avoid inferring password.
                hashedPiece = "+" + (h32Raw(new TextEncoder().encode(piece)) ^ userpasswordHash).toString(16);
            } else {
                hashedPiece = h32(piece);
            }
            leafid = "h:" + hashedPiece;

            //have to make
            const savePiece = await encrypt(piece, passphrase);

            const d: EntryLeaf = {
                _id: leafid,
                data: savePiece,
                type: "leaf",
            };
            newLeafs.push(d);
            hashCache[piece] = leafid;
            hashCacheRev[leafid] = piece;
            made++;
        }
        savenNotes.push(leafid);
    } while (leftData != "");
    let saved = true;
    if (newLeafs.length > 0) {
        try {
            const result = await database.bulkDocs(newLeafs);
            for (const item of result) {
                if ((item as any).ok) {
                    Logger(`save ok:id:${item.id} rev:${item.rev}`, LOG_LEVEL.VERBOSE);
                } else {
                    if ((item as any).status && (item as any).status == 409) {
                        // conflicted, but it would be ok in childrens.
                    } else {
                        Logger(`save failed:id:${item.id} rev:${item.rev}`, LOG_LEVEL.NOTICE);
                        Logger(item);
                        // this.disposeHashCache();
                        saved = false;
                    }
                }
            }
        } catch (ex) {
            Logger("ERROR ON SAVING LEAVES:", LOG_LEVEL.NOTICE);
            Logger(ex, LOG_LEVEL.NOTICE);
            saved = false;
        }
    }
    if (saved) {
        Logger(`note content saven, pieces:${processed} new:${made}, skip:${skiped}, cache:${cacheUsed}`);
        const newDoc: PlainEntry | NewEntry = {
            NewNote: true,
            children: savenNotes,
            _id: note._id,
            ctime: note.ctime,
            mtime: note.mtime,
            size: note.size,
            type: plainSplit ? "plain" : "newnote",
        };
        // Here for upsert logic,
        try {
            const old = await database.get(newDoc._id);
            if (!old.type || old.type == "notes" || old.type == "newnote" || old.type == "plain") {
                // simple use rev for new doc
                newDoc._rev = old._rev;
            }
        } catch (ex: any) {
            if (ex.status && ex.status == 404) {
                // NO OP/
            } else {
                throw ex;
            }
        }
        const r = await database.put(newDoc, { force: true });
        Logger(`note saved:${newDoc._id}:${r.rev}`);
    } else {
        Logger(`note coud not saved:${note._id}`);
    }
}
async function eachProc(syncKey: string, config: eachConf) {
    log(`${syncKey} started`);

    const serverURI = config.server.uri;
    const serverAuth = config.server.auth;
    const serverPath = config.server.path;

    const exportPath = config.local?.path ?? "";
    const processor = config.local?.processor ?? "";

    const remote = new PouchDB(serverURI, { auth: serverAuth });

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
    log("Start Database watching");

    function openConnection(e: connectConfig, auto_reconnect: boolean) {
        Logger(`Connecting ${e.syncKey} with auto_reconnect:${auto_reconnect}`);
        e.fromDB
            .changes({
                live: true,
                include_docs: true,
                style: "all_docs",
                since: syncStat[syncKey],
                filter: (doc, _) => {
                    return doc._id.startsWith(e.fromPrefix) && isVaildDoc(doc._id);
                },
            })
            .on("change", async function (change) {
                if (change.doc?._id.startsWith(e.fromPrefix) && isVaildDoc(change.doc._id)) {
                    let x = await transferDoc(e.syncKey, e.fromDB, change.doc, e.fromPrefix, e.passphrase, exportPath);
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
    const watcher = chokidar.watch(config.local.path, { ignoreInitial: !config.local.initialScan });
    const vaultPath = path.posix.normalize(config.local.path);

    const db_add = async (pathSrc: string, stat: Stats) => {
        const id = serverPath + path2unix(path.relative(path.resolve(vaultPath), path.resolve(pathSrc)));
        const docId = id.startsWith("_") ? "/" + id : id;
        try {
            let doc = (await remote.get(docId)) as NewEntry;
            if (doc.mtime) {
                const mtime_srv = ~~(doc.mtime / 1000);
                const mtime_loc = ~~(stat.mtime.getTime() / 1000);
                if (mtime_loc == mtime_srv) {
                    log(`Should be not modified on ${pathSrc}`);
                    return;
                }
            }
        } catch (ex: any) {
            if (ex.status && ex.status == 404) {
                // NO OP.
            } else {
                throw ex;
            }
        }
        let content = "";
        let datatype: "newnote" | "plain" = "newnote";
        const d = await fs.readFile(pathSrc);
        if (!isPlainText(pathSrc)) {
            // const contentBin = await this.app.vault.readBinary(file);
            // content = await arrayBufferToBase64(contentBin);
            content = d.toString("base64");
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
            // type: "plain",
        };
        await putDBEntry(newNote, conf.passphrase, remote as PouchDB.Database<NewEntry | PlainEntry | Entry | EntryLeaf>);
    };
    const db_delete = async (pathSrc: string) => {
        const id = serverPath + path2unix(path.relative(path.resolve(vaultPath), path.resolve(pathSrc)));
        const docId = id.startsWith("_") ? "/" + id : id;
        try {
            let oldNote: any = await remote.get(docId);
            oldNote._deleted = true;
            await remote.put(oldNote);
            addTouchedFile(pathSrc, 0);
        } catch (ex: any) {
            if (ex.status && ex.status == 404) {
                // NO OP.
            } else {
                throw ex;
            }
        }
    };
    watcher.on("change", async (pathSrc: string, stat: Stats) => {
        const filePath = pathSrc;
        log(`Detected:change:${filePath}`);
        const mtime = ~~(stat.mtime.getTime() / 1000);
        if (isTouchedFile(filePath, mtime)) {
            log("Self-detect");
            return;
        }
        addTouchedFile(pathSrc, mtime);
        await db_add(pathSrc, stat);
    });
    watcher.on("unlink", async (pathSrc: string, stat: Stats) => {
        const filePath = pathSrc;
        log(`Detected:delete:${filePath}`);
        if (isTouchedFile(filePath, 0)) {
            log("self-detect");
        }
        await db_delete(pathSrc);
    });
    watcher.on("add", async (pathSrc: string, stat: Stats) => {
        const filePath = pathSrc;
        log(`Detected:created:${filePath}`);
        const mtime = ~~(stat.mtime.getTime() / 1000);
        if (isTouchedFile(filePath, mtime)) {
            log("Self-detect");
            return;
        }
        addTouchedFile(pathSrc, mtime);
        await db_add(pathSrc, stat);

        // this.watchVaultChange(path, stat);
    });
    let conf: connectConfig = {
        syncKey: syncKey,
        fromDB: remote,
        fromPrefix: serverPath,
        passphrase: serverAuth.passphrase,
    };
    openConnection(conf, config.auto_reconnect ?? false);
}

async function getChildren(children: string[], db: PouchDB.Database) {
    let items = await db.allDocs({ include_docs: true, keys: [...children] });
    return items.rows.map((e) => e.doc);
}

function isVaildDoc(id: string): boolean {
    if (id == "obsydian_livesync_version") return false;
    if (id.indexOf(":") !== -1) return false;
    return true;
}

async function transferDoc(syncKey: string, fromDB: PouchDB.Database, fromDoc: PouchDB.Core.ExistingDocument<PouchDB.Core.ChangesMeta>, fromPrefix: string, passphrase: string, exportPath: string): Promise<boolean> {
    const docKey = `${syncKey}: ${fromDoc._id} (${fromDoc._rev})`;
    while (running[syncKey]) {
        await delay(100);
    }
    try {
        running[syncKey] = true;
        if (isKnownFile(syncKey, fromDoc._id, fromDoc._rev)) {
            return true;
        }
        log(`doc:${docKey} begin Transfer`);
        let continue_count = 3;
        try {
            const docName = fromDoc._id.substring(fromPrefix.length);
            let sendDoc: PouchDB.Core.ExistingDocument<PouchDB.Core.ChangesMeta> & { children?: string[]; type?: string; mtime?: number } = { ...fromDoc, _id: docName.startsWith("_") ? "/" + docName : docName };
            let retry = false;
            const userpasswordHash = h32Raw(new TextEncoder().encode(passphrase));
            do {
                if (retry) {
                    continue_count--;
                    if (continue_count == 0) {
                        log(`doc:${docKey} retry failed`);
                        return false;
                    }
                    await delay(1500);
                }
                if (sendDoc._deleted && exportPath != "") {
                    const writePath = path.join(exportPath, docName);
                    log(`doc:${docKey}: Deleted, so delete from ${writePath}`);
                    addTouchedFile(writePath, 0);
                    await fs.unlink(writePath);
                }
                retry = false;
                if (!sendDoc.children) {
                    log(`doc:${docKey}: Warning! document doesn't have chunks, skipped`);
                    return false;
                }
                let cx = sendDoc.children;
                let children = await getChildren(cx, fromDB);

                if (children.includes(undefined)) {
                    log(`doc:${docKey}: Warning! there's missing chunks, skipped`);
                    return false;
                } else {
                    children = children.filter((e) => !!e);
                    for (const v of children) {
                        delete (v as any)?._rev;
                    }

                    let decrypted_children =
                        passphrase == ""
                            ? children
                            : (
                                  await Promise.allSettled(
                                      children.map(async (e: any) => {
                                          e.data = await decrypt(e.data, passphrase);
                                          return e;
                                      })
                                  )
                              ).map((e) => (e.status == "fulfilled" ? e.value : null));
                    // If exporting is enabled, write contents to the real file.
                    if (exportPath != "" && !sendDoc._deleted) {
                        const writePath = path.join(exportPath, docName);
                        const dirName = path.dirname(writePath);
                        log(`doc:${docKey}: Exporting to ${writePath}`);
                        await fs.mkdir(dirName, { recursive: true });
                        const dt_plain = decrypted_children.map((e) => e.data).join("");
                        const mtime = sendDoc.mtime ?? new Date().getTime();
                        const tmtime = ~~(mtime / 1000);
                        addTouchedFile(writePath, tmtime);
                        if (sendDoc.type == "plain") {
                            await fs.writeFile(writePath, dt_plain);
                            await fs.utimes(writePath, tmtime, tmtime);
                        } else {
                            const dt_bin = Buffer.from(dt_plain, "base64");
                            await fs.writeFile(writePath, dt_bin, { encoding: "binary" });
                            await fs.utimes(writePath, tmtime, tmtime);
                        }
                    }
                }
            } while (retry);
        } catch (ex) {
            log("Exception on transfer doc");
            log(ex);
        }
    } finally {
        running[syncKey] = false;
    }
    return false;
}

main().then((_) => {});
