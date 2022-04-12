
const pouchdb_src = require("pouchdb-core").plugin(require("pouchdb-adapter-leveldb")).plugin(require("pouchdb-adapter-http")).plugin(require("pouchdb-mapreduce")).plugin(require("pouchdb-replication"));
const PouchDB = pouchdb_src;
/**
 * @type {PouchDB.Static<>}
 */
export { PouchDB };
