'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('./storage.cjs');
const requested = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const committed = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || Error('aborted')); });

async function main() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-node-storage-'));
  let storage, db;
  const rename = fs.renameSync;
  try {
    storage = new Storage(folder); await storage.restore();
    const open = storage.factory.open('fixture', 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('states', { keyPath: 'id' }).createIndex('name', 'name');
      open.result.createObjectStore('metadata', { keyPath: 'id' });
    };
    db = await requested(open);
    let tx = db.transaction(['states', 'metadata'], 'readwrite'), done = committed(tx);
    tx.objectStore('states').put({ id: 'a', name: '中文😀', blob: new Blob(['压缩/二进制存档😀'], { type: 'text/plain' }), vector: new Float32Array([0.25, 1.5]), date: new Date('2026-10-12T00:00:00Z') });
    tx.objectStore('metadata').put({ id: 'a', turn: 1 }); await done;
    await storage.flush(); const original = fs.readFileSync(storage.file);
    tx = db.transaction(['states', 'metadata'], 'readwrite'); done = committed(tx);
    tx.objectStore('metadata').put({ id: 'a', turn: 999 }); tx.objectStore('states').delete('a'); tx.abort();
    await assert.rejects(done); await storage.flush(); assert.deepEqual(fs.readFileSync(storage.file), original);
    db.close(); await storage.close();

    storage = new Storage(folder); await storage.restore(); db = await requested(storage.factory.open('fixture'));
    tx = db.transaction(['states', 'metadata'], 'readonly'); done = committed(tx);
    const state = await requested(tx.objectStore('states').get('a'));
    const metadata = await requested(tx.objectStore('metadata').get('a')); await done;
    assert.equal(metadata.turn, 1); assert.equal(state.name, '中文😀');
    assert.equal(await state.blob.text(), '压缩/二进制存档😀'); assert.equal(state.blob.type, 'text/plain');
    assert.deepEqual(Array.from(state.vector), [0.25, 1.5]); assert.equal(state.date.toISOString(), '2026-10-12T00:00:00.000Z');
    assert.equal(db.transaction('states').objectStore('states').indexNames.contains('name'), true);
    console.log('PASS restart preserves binary data, UTF-8, vectors, dates, indexes and aborted transactions');

    tx = db.transaction('metadata', 'readwrite'); done = committed(tx);
    tx.objectStore('metadata').put({ id: 'a', turn: 2 }); await done;
    fs.renameSync = () => { throw Object.assign(Error('fixture disk replacement failure'), { code: 'EIO' }); };
    await assert.rejects(storage.flush(), error => error.code === 'SAVE_WRITE_UNCONFIRMED');
    assert.deepEqual(fs.readFileSync(storage.file), original);
    await assert.rejects(storage.close(), error => error.code === 'SAVE_WRITE_UNCONFIRMED');
    db.close(); storage = undefined; db = undefined; fs.renameSync = rename;
    console.log('PASS failed disk commit keeps the previous file and reports an unconfirmed write');

    const corrupted = Buffer.from('invalid database bytes'); fs.writeFileSync(path.join(folder, 'node-database.bin'), corrupted);
    storage = new Storage(folder); await assert.rejects(storage.restore(), /原文件已保留/); await storage.close();
    assert.deepEqual(fs.readFileSync(path.join(folder, 'node-database.bin')), corrupted);
    console.log('PASS corrupt database is reported without overwriting the original');
  } finally {
    fs.renameSync = rename; if (db) db.close(); if (storage) await storage.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
