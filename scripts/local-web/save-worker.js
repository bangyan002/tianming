/* Save preparation stays off the UI thread; pending uploads remain durable in IDB. */
'use strict';
importScripts('codec.js');
const codec = self.TMStorageCodec;
function open(name, upgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => { if (upgrade) upgrade(request.result); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
function done(tx) {
  return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new Error('Local save aborted')); });
}
function schemaOf(db, tx) {
  const schema = {};
  for (const name of db.objectStoreNames) {
    const store = tx.objectStore(name), indexes = {};
    for (const key of store.indexNames) { const index = store.index(key);
      indexes[key] = { keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }; }
    schema[name] = { keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes };
  }
  return schema;
}
async function pack(body, gzip) {
  const json = JSON.stringify(body), plain = new Blob([json], { type: 'application/json' }), large = plain.size >= 256 * 1024;
  if (large && gzip && typeof CompressionStream === 'function') {
    try {
      const packed = await new Response(plain.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      if (packed.size < plain.size) return { body: packed, gzip: true, large };
    } catch (_) { /* The original JSON remains valid if compression is unavailable. */ }
  }
  return { body: plain, gzip: false, large };
}
async function journal(prefix, job) {
  const db = await open(prefix + 'upload-journal', db => db.createObjectStore('jobs', { keyPath: 'name' }));
  try {
    if (typeof job === 'string') {
      return await new Promise((resolve, reject) => { const request = db.transaction('jobs').objectStore('jobs').get(job);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    }
    const tx = db.transaction('jobs', 'readwrite'), settled = done(tx); tx.objectStore('jobs').put(job); await settled;
  } finally { db.close(); }
}
async function stage(prefix, job, gzip) {
  if (!job.payload) {
    job.payload = await pack(job.body, gzip);
    // Store the compressed Blob plus identity, rather than a second huge object graph.
    job.body = { id: job.body.id, name: job.body.name, revision: job.body.revision };
    await journal(prefix, job);
  }
  return job;
}
async function snapshot(data) {
  const { prefix, name, token, revision, id, deleted, gzip } = data;
  const body = { id, name, revision, version: 0, schema: {}, operations: [] };
  if (!deleted) {
    const db = await open(prefix + 'db:' + name), names = Array.from(db.objectStoreNames), records = [];
    try {
      body.version = db.version;
      if (names.length) {
        const tx = db.transaction(names), settled = done(tx); body.schema = schemaOf(db, tx);
        // One readonly transaction supplies a consistent multi-store snapshot.
        for (const store of names) {
          const request = tx.objectStore(store).openCursor();
          request.onsuccess = () => { const cursor = request.result;
            if (cursor) { records.push({ store, key: cursor.primaryKey, value: cursor.value }); cursor.continue(); } };
        }
        await settled;
      }
      body.operations = names.map(store => ({ type: 'clear', store }));
      for (const record of records) body.operations.push({ type: 'put', store: record.store, key: codec.key(record.key),
        value: await codec.encode(record.value), indexes: codec.indexes(record.value, body.schema[record.store]) });
    } finally { db.close(); }
  }
  return stage(prefix, { name, token, body }, gzip);
}
async function project(data) {
  const db = await open(data.prefix + 'db:tianming_db');
  try {
    const tx = db.transaction('projects', 'readwrite'), settled = done(tx);
    tx.objectStore('projects').put({ id: 'current_project', timestamp: Date.now(), data: data.project });
    await settled; return true;
  } finally { db.close(); }
}
async function canonical(data) {
  // postMessage already froze the caller's state synchronously before this task.
  const json = JSON.stringify(data.state);
  if (typeof json !== 'string') throw new Error('canonical world state is not serializable');
  const bytes = new TextEncoder().encode(json);
  let checksum;
  if (data.sha256) {
    if (!self.crypto || !self.crypto.subtle) throw new Error('SHA-256 unavailable in save worker');
    const digest = await self.crypto.subtle.digest('SHA-256', bytes);
    checksum = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } else {
    let hash = 2166136261;
    for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 16777619);
    checksum = 'fnv1a-' + (hash >>> 0).toString(16).padStart(8, '0');
  }
  let compressed = json;
  if (data.compress && typeof CompressionStream === 'function') {
    try { compressed = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).blob(); }
    catch (_) { /* Keep the original string, matching SaveCompression's fallback. */ }
  }
  return { json, jsonByteLength: bytes.length, checksum, compressed,
    compressedByteLength: typeof compressed === 'string' ? bytes.length : compressed.size };
}
self.onmessage = async event => {
  const { requestId, task, data } = event.data;
  try {
    let result;
    if (task === 'snapshot') result = await snapshot(data);
    else if (task === 'recover') { const old = await journal(data.prefix, data.name); result = old ? await stage(data.prefix, old, data.gzip) : null; }
    else if (task === 'project') result = await project(data);
    else if (task === 'canonical') result = await canonical(data);
    else if (task === 'pack') result = await pack(data.body, data.gzip);
    else throw new Error('Unknown save worker task');
    self.postMessage({ requestId, result });
  } catch (error) {
    self.postMessage({ requestId, error: { name: error.name, message: error.message, code: error.code } });
  }
};
