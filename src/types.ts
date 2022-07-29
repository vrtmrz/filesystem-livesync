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
    initialScan: boolean;

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
    sync_on_connect: boolean;
    deleteMetadataOfDeletedFiles?: boolean;
}

export interface configFile {
    [key: string]: eachConf;
}
export interface connectConfig {
    syncKey: string;
    fromDB: PouchDB.Database;
    fromPrefix: string;
    passphrase: string;
    deleteMetadataOfDeletedFiles: boolean;
}


export type TransferEntry = PouchDB.Core.ExistingDocument<PouchDB.Core.ChangesMeta> & {
    children?: string[];
    type?: string;
    mtime?: number;
    deleted?: boolean;
};
