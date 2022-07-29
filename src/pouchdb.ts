const pouchdb_src = require("pouchdb-core")
    .plugin(require("pouchdb-find"))
    .plugin(require("pouchdb-adapter-leveldb"))
    .plugin(require("pouchdb-adapter-http"))
    .plugin(require("pouchdb-mapreduce"))
    .plugin(require("pouchdb-replication"))
    .plugin(require("transform-pouch"));
const PouchDB: PouchDB.Static<{}> = pouchdb_src;
/**
 * @type {PouchDB.Static<>}
 */
export { PouchDB };
