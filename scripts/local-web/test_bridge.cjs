'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {gunzipSync} = require('node:zlib');
const source = fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8');

function fixture(options = {}) {
  const calls = [], deadlines = [], elements = new Map();
  const root = {
    indexedDB: {cmp: (a, b) => a === b ? 0 : a < b ? -1 : 1},
    crypto: require('node:crypto').webcrypto,
    location: {pathname: '/fixture.html'}, addEventListener() {},
    CompressionStream: options.noCompression ? undefined : CompressionStream
  };
  class XHR {
    open() {}
    send() { this.status = 200; this.responseText = JSON.stringify({datasetId: 'fixture', values: {}, versions: {}, revision: 0, gzipRequests: options.gzip !== false}); }
  }
  const document = {
    body: {appendChild(element) { elements.set(element.id, element); }},
    createElement() { return {setAttribute() {}, style: {}, append() {}}; },
    getElementById: id => elements.get(id), addEventListener() {}
  };
  const context = vm.createContext({window: root, document, XMLHttpRequest: XHR,
    structuredClone, Blob, Response, AbortController, btoa, atob, console,
    setTimeout(callback, ms) { if (ms > 0) deadlines.push(ms); return setTimeout(callback, ms); }, clearTimeout,
    async fetch(url, init) {
      const raw = typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(await init.body.arrayBuffer());
      const data = JSON.parse(init.headers['Content-Encoding'] === 'gzip' ? gunzipSync(raw) : raw);
      const route = url.split('/').at(-1), call = {route, data, raw, payload: init.body, headers: init.headers};
      calls.push(call);
      if (options.handle) { const response = await options.handle(call, calls); if (response) return response; }
      const body = route === 'open' ? {name: 'fixture', version: 1, revision: 0, schema: {rows: {keyPath: null, indexes: {}}}} :
        route === 'begin' ? {version: 1, revision: 0} : route === 'commit' ? {revision: 1} : {committed: false};
      return Response.json(body);
    }
  });
  vm.runInContext(source, context);
  return {root, calls, deadlines, elements};
}

async function open(f) {
  return new Promise((resolve, reject) => { const r = f.root.indexedDB.open('fixture'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
async function write(f, value) {
  const db = await open(f), tx = db.transaction('rows', 'readwrite');
  tx.objectStore('rows').put(value, 'save');
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(tx); tx.onerror = () => reject(tx); tx.onabort = () => reject(tx); });
}

async function main() {
  const text = '案卷·'.repeat(150000), compressed = fixture();
  await write(compressed, text);
  const sent = compressed.calls.find(call => call.route === 'commit');
  assert.equal(sent.headers['Content-Encoding'], 'gzip');
  assert.equal(sent.data.operations[0].value, text);
  assert(sent.raw.length < Buffer.byteLength(JSON.stringify(sent.data)) / 10);
  assert(compressed.deadlines.includes(180000));
  for (const options of [{gzip: false}, {noCompression: true}]) {
    const f = fixture(options); await write(f, text);
    assert.equal(f.calls.find(call => call.route === 'commit').headers['Content-Encoding'], undefined);
  }
  const small = fixture(); await write(small, 'small');
  assert.equal(small.calls.find(call => call.route === 'commit').headers['Content-Encoding'], undefined);
  assert(!small.deadlines.includes(180000));

  let attempts = 0;
  const retried = fixture({handle(call) {
    if (call.route === 'commit' && ++attempts === 1) throw new TypeError('upload interrupted');
  }});
  await write(retried, text);
  const commits = retried.calls.filter(call => call.route === 'commit');
  assert.equal(commits.length, 2);
  assert.equal(commits[0].data.id, commits[1].data.id);
  assert.equal(commits[0].payload, commits[1].payload, 'retry reuses compressed bytes');
  assert.equal(retried.elements.size, 0);

  const lost = fixture({handle(call) {
    if (call.route === 'commit') throw new TypeError('response lost');
    if (call.route === 'outcome') return Response.json({committed: true, revision: 1});
  }});
  await write(lost, text);
  assert.equal(lost.calls.filter(call => call.route === 'commit').length, 1);
  assert.equal(lost.elements.size, 0);

  const unresolved = fixture({handle(call) {
    if (call.route === 'commit') throw new TypeError('connection interrupted');
  }});
  let tx;
  try { await write(unresolved, text); } catch (error) { tx = error; }
  assert.equal(tx.error.name, 'ServerWriteUnconfirmedError');
  assert.equal(tx.phase, 'committing', 'an uncertain commit must not claim rollback');
  assert(unresolved.elements.has('tm-server-storage-error'));
  assert.equal(unresolved.calls.filter(call => call.route === 'commit').length, 2);

  const conflict = fixture({handle(call) {
    if (call.route === 'commit') return Response.json({name: 'ServerConflictError', error: 'another page wrote'}, {status: 409});
  }});
  await assert.rejects(write(conflict, 'small'), tx => tx.error.name === 'ServerConflictError');
  assert.equal(conflict.calls.filter(call => call.route === 'commit').length, 1);
  assert.equal(conflict.calls.filter(call => call.route === 'outcome').length, 0);
  console.log('PASS bridge compression, old-browser/server fallback, deadlines, idempotent retry, lost receipt and uncertainty/conflict handling');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
