export const LOG_LEVEL = {
    VERBOSE: 1,
    INFO: 10,
    NOTICE: 100,
    URGENT: 1000,
} as const;
export type LOG_LEVEL = typeof LOG_LEVEL[keyof typeof LOG_LEVEL];

export interface config {
    uri: string;
    auth: {
        username: string;
        password: string;
        passphrase: string;
    };
    path: string;
}
export interface localConfig {
    path: string;
    initialScan: boolean;
    processor: string;
}

export interface eachConf {
    server: config;
    local: localConfig;
    auto_reconnect?: boolean;
}

export interface configFile {
    [key: string]: eachConf;
}
export interface connectConfig {
    syncKey: string;
    fromDB: PouchDB.Database;
    fromPrefix: string;
    passphrase: string;
}

//---LiveSync's data

export const MAX_DOC_SIZE = 1000; // for .md file, but if delimiters exists. use that before.
export const MAX_DOC_SIZE_BIN = 102400; // 100kb

export interface EntryLeaf {
    _id: string;
    data: string;
    _deleted?: boolean;
    type: "leaf";
    _rev?: string;
}

export interface Entry {
    _id: string;
    data: string;
    _rev?: string;
    ctime: number;
    mtime: number;
    size: number;
    _deleted?: boolean;
    _conflicts?: string[];
    type?: "notes";
}

export interface NewEntry {
    _id: string;
    children: string[];
    _rev?: string;
    ctime: number;
    mtime: number;
    size: number;
    _deleted?: boolean;
    _conflicts?: string[];
    NewNote: true;
    type: "newnote";
}
export interface PlainEntry {
    _id: string;
    children: string[];
    _rev?: string;
    ctime: number;
    mtime: number;
    size: number;
    _deleted?: boolean;
    NewNote: true;
    _conflicts?: string[];
    type: "plain";
}

export type LoadedEntry = Entry & {
    children: string[];
    datatype: "plain" | "newnote";
};
