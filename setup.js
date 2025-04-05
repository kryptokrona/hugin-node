

const Hyperschema = require('hyperschema')
const HyperDB = require('hyperdb/builder')

const SCHEMA_DIR = '/spec/hyperschema'
const DB_DIR = './spec/hyperdb'

const schema = Hyperschema.from(SCHEMA_DIR)
const reg = schema.namespace('schema')

reg.register({
  name: 'messages',
  compact: true,
  fields: [
    { name: 'cipher', type: 'string', required: true },
    { name: 'timestamp', type: 'uint', required: true },
    { name: 'pub', type: 'string', required: true },
    { name: 'hash', type: 'string', required: true },
    { name: 'signature', type: 'string', required: true },
  ]
})

Hyperschema.toDisk(schema)

const db = HyperDB.from(SCHEMA_DIR, DB_DIR)
const hyperDB = db.namespace('messages')


hyperDB.collections.register({
  name: 'messages',
  schema: '@messages/messages',
  key: ['timestamp']
})

hyperDB.indexes.register({
  name: 'messages-by-pub',
  collection: '@messages/messages',
  unique: false,
  key: ['pub']
})


HyperDB.toDisk(db)

console.log("DB Setup complete.")
