'use strict';
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

function atomicWrite(file, bytes) {
  const temporary = file + '.tmp-' + process.pid;
  let fd;
  try {
    fd = fs.openSync(temporary, 'w', 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

async function encode(data) {
  const blobs = [], seen = new WeakMap();
  async function copy(value, parts) {
    if (value instanceof Blob) { blobs.push({ path: parts, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) }); return null; }
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof Map || value instanceof Set) return value;
    const target = Array.isArray(value) ? [] : {}; seen.set(value, target);
    for (const key of Object.keys(value)) target[key] = await copy(value[key], parts.concat(key));
    return target;
  }
  return v8.serialize({ schema: 'tm-terminal-database/1', data: await copy(data, []), blobs });
}
function decode(bytes) {
  const envelope = v8.deserialize(bytes);
  if (envelope.schema !== 'tm-terminal-database/1' || !Array.isArray(envelope.data)) throw new Error('终端数据库格式不受支持。');
  for (const record of envelope.blobs) {
    let parent = envelope.data;
    for (const key of record.path.slice(0, -1)) parent = parent[key];
    parent[record.path[record.path.length - 1]] = new Blob([record.bytes], { type: record.type });
  }
  return envelope.data;
}
const completed = tx => new Promise((resolve, reject) => {
  tx.addEventListener('complete', resolve, { once: true });
  tx.addEventListener('abort', () => reject(tx.error || new Error('数据库事务被中止')), { once: true });
});
const requested = request => new Promise((resolve, reject) => {
  request.addEventListener('success', () => resolve(request.result), { once: true });
  request.addEventListener('error', () => reject(request.error), { once: true });
});

class Storage {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'node-database.bin');
    this.settingsFile = path.join(dataDir, 'node-settings.json');
    this.factory = new IDBFactory();
    this.revision = 0; this.persisted = 0; this.queue = Promise.resolve();
    this.observed = new WeakSet(); this.ready = false;
    const open = this.factory.open.bind(this.factory);
    this.factory.open = (...args) => {
      const request = open(...args);
      request.addEventListener('success', () => this.observe(request.result), { once: true });
      return request;
    };
  }
  observe(db) {
    if (this.observed.has(db)) return;
    this.observed.add(db);
    const transaction = db.transaction.bind(db);
    db.transaction = (...args) => {
      const tx = transaction(...args);
      if (tx.mode === 'readwrite') tx.addEventListener('complete', () => {
        this.revision++;
        if (this.ready && !this.timer) this.timer = setTimeout(() => {
          this.timer = undefined; this.flush().catch(() => {});
        }, 25);
      });
      return tx;
    };
  }
  async restore() {
    if (fs.existsSync(this.file)) {
      let rows;
      try { rows = decode(fs.readFileSync(this.file)); }
      catch (error) { throw new Error('终端数据库无法读取，原文件已保留：' + error.message); }
      for (const row of rows) {
        const request = this.factory.open(row.name, row.version);
        request.onupgradeneeded = () => {
          for (const store of row.stores) {
            const created = request.result.createObjectStore(store.name, { keyPath: store.keyPath, autoIncrement: store.autoIncrement });
            for (const index of store.indexes) created.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
          }
        };
        const db = await requested(request);
        if (row.stores.length) {
          const tx = db.transaction(row.stores.map(store => store.name), 'readwrite');
          const done = completed(tx);
          for (const store of row.stores) {
            const target = tx.objectStore(store.name);
            store.values.forEach((value, i) => { if (store.keyPath === null) target.put(value, store.keys[i]); else target.put(value); });
          }
          await done;
        }
        db.close();
      }
    }
    this.persisted = this.revision; this.ready = true;
  }
  mount(window) {
    window.indexedDB = this.factory; window.IDBKeyRange = IDBKeyRange;
    let settings = {};
    if (fs.existsSync(this.settingsFile)) {
      try { settings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); }
      catch (error) { throw new Error('终端设置文件无法读取，原文件已保留：' + error.message); }
    }
    for (const [key, value] of Object.entries(settings)) window.localStorage.setItem(key, value);
    const storage = window.localStorage, prototype = window.Storage.prototype;
    const persist = () => {
      const values = {}; for (let i = 0; i < storage.length; i++) { const key = storage.key(i); values[key] = storage.getItem(key); }
      atomicWrite(this.settingsFile, JSON.stringify(values));
    };
    for (const name of ['setItem', 'removeItem', 'clear']) {
      const original = prototype[name];
      prototype[name] = function (...args) { const result = original.apply(this, args); if (this === storage) persist(); return result; };
    }
  }
  async snapshot() {
    const result = [];
    for (const info of await this.factory.databases()) {
      const db = await requested(this.factory.open(info.name));
      const names = Array.from(db.objectStoreNames), row = { name: info.name, version: db.version, stores: [] };
      if (names.length) {
        const tx = db.transaction(names, 'readonly'), done = completed(tx);
        const pending = names.map(name => {
          const store = tx.objectStore(name);
          const metadata = { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: Array.from(store.indexNames).map(indexName => {
            const index = store.index(indexName); return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
          }) };
          return Promise.all([requested(store.getAllKeys()), requested(store.getAll())]).then(([keys, values]) => Object.assign(metadata, { keys, values }));
        });
        row.stores = await Promise.all(pending); await done;
      }
      db.close(); result.push(row);
    }
    return result;
  }
  flush() {
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (!this.ready) return;
      try {
        while (this.persisted !== this.revision) {
          const revision = this.revision, snapshot = await this.snapshot();
          atomicWrite(this.file, await encode(snapshot)); this.persisted = revision;
        }
        this.error = undefined;
      } catch (error) {
        this.error = Object.assign(new Error('终端存档未确认写入磁盘：' + error.message), { code: 'SAVE_WRITE_UNCONFIRMED' });
        throw this.error;
      }
    });
    return this.queue;
  }
  bindGame(window) {
    const db = window.TM_SaveDB, self = this;
    const assertWritable = db.assertWritable;
    db.assertWritable = function (...args) { if (self.error) throw self.error; return assertWritable.apply(this, args); };
    for (const name of ['save', 'saveManyAtomic', 'clearPendingTurnDataPublishAtomic', 'saveChronicleRecord', 'saveTurnPublishReceipt', 'deleteTurnPublishReceipt', 'saveProject', 'delete', 'pruneChronicleRecords', 'importQuarantinedChronicleRecord']) {
      const original = db[name]; if (!original) continue;
      db[name] = async function (...args) { if (self.error) throw self.error; const result = await original.apply(this, args); await self.flush(); return result; };
    }
  }
  async close() { if (this.timer) clearTimeout(this.timer); await this.flush(); }
}
module.exports = { Storage, atomicWrite, encode, decode };
