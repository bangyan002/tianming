/* Local server persistence adapter. Injected by local_web.py before every HTML page's scripts.
 * No persistent browser cache: localStorage lives in memory, IDB records live in SQLite.
 * Implements the IDB operations used by the game, editors, audio, snapshots and semantic index.
 */
(function (root) {
  'use strict';
  const API = '/__tm_storage__/', nativeDB = root.indexedDB;
  const states = new Map();
  const pendingWrites = new Set();
  let blocked = null, projectRestorePending = false, datasetId = null, gzipRequests = false;
  function projectRestoreError() { return fault('ServerProjectRestorePending', '现有项目尚未恢复，未用启动默认值覆盖服务器数据'); }
  function fault(name, message) { const e = new Error(message); e.name = name; return e; }
  function report(error) {
    blocked = error;
    function show() {
      if (document.getElementById('tm-server-storage-error')) return;
      const box = document.createElement('section'); box.id = 'tm-server-storage-error';
      box.setAttribute('role', 'alert');
      box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff8e6;color:#302619;padding:10vh 8vw;font:18px sans-serif;';
      const title = document.createElement('h2'); title.textContent = '服务端存储暂时无法使用';
      const text = document.createElement('p'); text.textContent = error.message + '。已暂停本页写入，请重新打开页面并核对存档。';
      const button = document.createElement('button'); button.textContent = '重新加载'; button.onclick = function () { root.location.reload(); };
      box.append(title, text, button); document.body.appendChild(box);
    }
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
  }
  function writable() { if (blocked) throw blocked; }
  function response(xhr) {
    let data; try { data = JSON.parse(xhr.responseText); } catch (_) { throw fault('NetworkError', '服务端未返回有效数据'); }
    if (xhr.status < 200 || xhr.status >= 300) throw fault(data.name || 'NetworkError', data.error || '存储请求失败');
    return data;
  }
  function sync(path, body) {
    const xhr = new XMLHttpRequest(); xhr.open(body === undefined ? 'GET' : 'POST', API + path, false);
    if (body !== undefined) {
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('X-TM-Storage-ID', datasetId);
    }
    xhr.send(body === undefined ? null : JSON.stringify(body)); return response(xhr);
  }
  async function payloadFor(body) {
    const text = JSON.stringify(body), large = text.length >= 256 * 1024;
    if (large && gzipRequests && typeof root.CompressionStream === 'function') {
      try {
        const plain = new Blob([text]);
        const packed = await new Response(plain.stream().pipeThrough(new root.CompressionStream('gzip'))).blob();
        if (packed.size < plain.size) return { body: packed, gzip: true, large };
      } catch (_) { /* Older browsers may expose CompressionStream without supporting gzip. */ }
    }
    return { body: text, gzip: false, large };
  }
  async function remote(path, body, timeout, prepared) {
    // Serialization/compression is preparation, not part of the network deadline.
    const payload = prepared || await payloadFor(body);
    const headers = { 'Content-Type': 'application/json', 'X-TM-Storage-ID': datasetId };
    if (payload.gzip) headers['Content-Encoding'] = 'gzip';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout || (path === 'commit' && payload.large ? 180000 : 45000));
    try {
      const result = await fetch(API + path, { method: 'POST', headers,
        body: payload.body, signal: controller.signal, cache: 'no-store' });
      const data = await result.json();
      if (!result.ok) {
        const error = fault(data.name || 'NetworkError', data.error || '存储请求失败');
        if (error.name === 'ServerResetError') report(error);
        throw error;
      }
      return data;
    } finally { clearTimeout(timer); }
  }
  async function commitWithReceipt(body) {
    const payload = await payloadFor(body);
    // SQLite checks the same id both before preparing data and under its writer
    // lock. A retry can safely meet an original request still finishing there.
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await remote('commit', body, undefined, payload); }
      catch (error) {
        if (['ServerConflictError', 'ConstraintError', 'DataError', 'ServerResetError'].includes(error.name)) throw error;
        try {
          const outcome = await remote('outcome', { id: body.id }, 5000);
          if (outcome.committed) return outcome;
        } catch (checkError) {
          if (checkError.name === 'ServerResetError') throw checkError;
          return null;
        }
      }
    }
    return null;
  }
  const clone = value => structuredClone(value);
  function base64(bytes) {
    let text = ''; for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 16384));
    return btoa(text);
  }
  function bytes(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
  async function encode(value, seen) {
    seen = seen || new Map();
    if (value === undefined) return ['undefined'];
    if (typeof value === 'bigint') return ['bigint', String(value)];
    if (typeof value === 'number' && !Number.isFinite(value)) return ['number', String(value)];
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return ['ref', seen.get(value)];
    const id = seen.size; seen.set(value, id);
    if (value instanceof Date) return ['date', id, value.getTime()];
    if (value instanceof RegExp) return ['regexp', id, value.source, value.flags];
    if (value instanceof Blob) return [typeof File !== 'undefined' && value instanceof File ? 'file' : 'blob', id,
      value.type, base64(new Uint8Array(await value.arrayBuffer())), value.name, value.lastModified];
    if (value instanceof ArrayBuffer) return ['buffer', id, base64(new Uint8Array(value))];
    if (ArrayBuffer.isView(value)) return ['view', id, value.constructor.name, await encode(value.buffer, seen),
      value.byteOffset, value instanceof DataView ? value.byteLength : value.length];
    if (Array.isArray(value)) {
      const items = []; for (const v of value) items.push(await encode(v, seen)); return ['array', id, items];
    }
    if (value instanceof Map) {
      const items = []; for (const [k, v] of value) items.push([await encode(k, seen), await encode(v, seen)]); return ['map', id, items];
    }
    if (value instanceof Set) {
      const items = []; for (const v of value) items.push(await encode(v, seen)); return ['set', id, items];
    }
    const items = []; for (const k of Object.keys(value)) items.push([k, await encode(value[k], seen)]);
    return ['object', id, items];
  }
  function decode(value, seen) {
    seen = seen || new Map();
    if (!Array.isArray(value)) return value;
    const [tag, id, body] = value;
    if (tag === 'ref') return seen.get(id);
    if (tag === 'undefined') return undefined;
    if (tag === 'bigint') return BigInt(id);
    if (tag === 'number') return Number(id);
    let out;
    if (tag === 'date') out = new Date(body);
    else if (tag === 'regexp') out = new RegExp(body, value[3]);
    else if (tag === 'blob') out = new Blob([bytes(value[3])], { type: body });
    else if (tag === 'file') out = new File([bytes(value[3])], value[4], { type: body, lastModified: value[5] });
    else if (tag === 'buffer') out = bytes(body).buffer;
    else if (tag === 'view') out = new root[body](decode(value[3], seen), value[4], value[5]);
    else if (tag === 'array') out = [];
    else if (tag === 'map') out = new Map();
    else if (tag === 'set') out = new Set();
    else if (tag === 'object') out = {};
    else throw fault('DataError', '未知的存储数据类型');
    seen.set(id, out);
    if (tag === 'array') body.forEach(v => out.push(decode(v, seen)));
    if (tag === 'map') body.forEach(([k, v]) => out.set(decode(k, seen), decode(v, seen)));
    if (tag === 'set') body.forEach(v => out.add(decode(v, seen)));
    if (tag === 'object') body.forEach(([k, v]) => Object.defineProperty(out, k, { value: decode(v, seen), writable: true, enumerable: true, configurable: true }));
    return out;
  }
  function key(value) {
    nativeDB.cmp(value, value); // Let the browser enforce IndexedDB key validity.
    if (value instanceof Date) return { date: value.getTime() };
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      return { binary: base64(value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    }
    return Array.isArray(value) ? value.map(key) : value;
  }
  function unkey(value) {
    if (Array.isArray(value)) return value.map(unkey);
    if (value && typeof value === 'object') return 'date' in value ? new Date(value.date) : bytes(value.binary).buffer;
    return value;
  }
  function cmp(a, b) { return nativeDB.cmp(unkey(a), unkey(b)); }
  function range(query) {
    if (query === undefined || query === null) return null;
    if (query instanceof root.IDBKeyRange) {
      const r = { lowerOpen: query.lowerOpen, upperOpen: query.upperOpen };
      if (query.lower !== undefined) r.lower = key(query.lower);
      if (query.upper !== undefined) r.upper = key(query.upper);
      return r;
    }
    return { lower: key(query), upper: key(query) };
  }
  function matches(k, q) {
    return !q || ((!('lower' in q) || cmp(k, q.lower) > (q.lowerOpen ? 0 : -1)) &&
      (!('upper' in q) || cmp(k, q.upper) < (q.upperOpen ? 0 : 1)));
  }
  function path(value, spec) {
    if (Array.isArray(spec)) { const values = spec.map(p => path(value, p)); return values.some(v => v === undefined) ? undefined : values; }
    if (spec === '') return value;
    return String(spec).split('.').reduce((v, k) => v == null ? undefined : v[k], value);
  }
  function indexes(value, schema) {
    const result = {};
    Object.entries(schema.indexes || {}).forEach(([name, spec]) => {
      const v = path(value, spec.keyPath), values = spec.multiEntry && Array.isArray(v) ? v : [v];
      result[name] = [];
      values.forEach(item => { try { const k = key(item); if (!result[name].some(p => cmp(p, k) === 0)) result[name].push(k); } catch (_) {} });
    });
    return result;
  }
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, fn, options) { const items = this.listeners.get(type) || []; items.push({ fn, once: options && options.once }); this.listeners.set(type, items); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(x => x.fn !== fn)); }
    emit(type, fields) {
      const event = Object.assign({ type, target: this, currentTarget: this, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, fields);
      if (typeof this['on' + type] === 'function') this['on' + type](event);
      for (const item of [...(this.listeners.get(type) || [])]) {
        if (item.once) this.removeEventListener(type, item.fn);
        if (typeof item.fn === 'function') item.fn.call(this, event); else item.fn.handleEvent(event);
      }
      return event;
    }
  }
  class Request extends Events {
    constructor(source, tx) { super(); this.source = source || null; this.transaction = tx || null; this.readyState = 'pending'; this.result = undefined; this.error = null; }
    success(result, extra) { this.result = result; this.readyState = 'done'; this.emit('success', extra); }
    fail(error) { this.error = error; this.readyState = 'done'; return this.emit('error'); }
  }
  function names(values) { const arr = [...values].sort(); arr.contains = name => arr.includes(String(name)); arr.item = n => arr[n] || null; return arr; }
  class Database extends Events {
    constructor(state) { super(); this.state = state; this.name = state.name; this.closed = false; state.connections.add(this); }
    get version() { return this.state.version; }
    get objectStoreNames() { return names(Object.keys(this.state.schema)); }
    createObjectStore(name, options) {
      const tx = this.upgrade; if (!tx) throw fault('InvalidStateError', '只能在升级事务中创建表');
      if (this.state.schema[name]) throw fault('ConstraintError', '存储表已存在');
      options = options || {};
      this.state.schema[name] = { keyPath: options.keyPath === undefined ? null : options.keyPath, autoIncrement: !!options.autoIncrement, indexes: {} };
      tx.scope.add(name); return tx.objectStore(name);
    }
    deleteObjectStore(name) {
      if (!this.upgrade) throw fault('InvalidStateError', '只能在升级事务中删除表');
      delete this.state.schema[name]; this.upgrade.scope.delete(name);
    }
    transaction(stores, mode) {
      if (this.closed) throw fault('InvalidStateError', '数据库连接已关闭');
      const scope = typeof stores === 'string' ? [stores] : Array.from(stores);
      if (!scope.length || scope.some(n => !this.state.schema[n])) throw fault('NotFoundError', '存储表不存在');
      if (projectRestorePending && this.name === 'tianming_db' && scope.includes('projects') && mode === 'readwrite') throw projectRestoreError();
      if (mode && !['readonly', 'readwrite'].includes(mode)) throw new TypeError('无效的事务模式');
      return new Transaction(this, scope, mode || 'readonly');
    }
    close() { this.closed = true; this.state.connections.delete(this); }
  }
  class Transaction extends Events {
    constructor(db, scope, mode, upgrade) {
      super(); this.db = db; this.mode = mode; this.scope = new Set(scope); this.error = null;
      this.operations = []; this.queue = []; this.phase = 'pending'; this.request = upgrade || null;
      this.originalSchema = clone(db.state.schema); this.originalVersion = db.state.version;
      let release;
      const finished = new Promise(resolve => { release = resolve; });
      if (mode !== 'readonly') pendingWrites.add(this);
      this.release = () => { pendingWrites.delete(this); release(); };
      const previous = db.state.tail; db.state.tail = finished;
      previous.then(() => this.start()).catch(error => this.fail(error));
    }
    get objectStoreNames() { return names(this.scope); }
    objectStore(name) {
      if (!this.scope.has(name) || !this.db.state.schema[name]) throw fault('NotFoundError', '存储表不存在');
      return new Store(this, name);
    }
    add(source, action) {
      if (['committing', 'done', 'aborted'].includes(this.phase)) throw fault('TransactionInactiveError', '事务已结束');
      const request = new Request(source, this); this.queue.push({ request, action }); return request;
    }
    abort() {
      if (['committing', 'done', 'aborted'].includes(this.phase)) throw fault('InvalidStateError', '事务已提交或提交结果等待确认');
      this.fail(fault('AbortError', '事务已中止'), true);
    }
    commit() { /* Automatic commit waits for the queued requests and the server receipt. */ }
    fail(error, manual) {
      if (['done', 'aborted'].includes(this.phase)) return;
      this.phase = 'aborted'; this.error = error;
      if (this.request) { this.db.state.schema = this.originalSchema; this.db.state.version = this.originalVersion; this.db.upgrade = null; }
      setTimeout(() => {
        try { if (!manual) this.emit('error'); this.emit('abort'); if (this.request) this.request.fail(error); }
        finally { this.release(); }
      }, 0);
    }
    async start() {
      if (this.phase === 'aborted') return;
      this.phase = 'active';
      try {
        if (this.mode !== 'readonly') writable();
        const meta = await remote('begin', { name: this.db.name, mode: this.mode, revision: this.db.state.revision });
        if (this.phase === 'aborted') return;
        this.revision = meta.revision;
        if (this.request) {
          this.db.upgrade = this; this.db.state.version = this.request.version;
          this.request.result = this.db; this.request.transaction = this;
          this.request.emit('upgradeneeded', { oldVersion: meta.version, newVersion: this.request.version });
          // Adding indexes to an existing store must also index its existing rows.
          for (const name of Object.keys(this.originalSchema)) {
            const current = this.db.state.schema[name];
            if (current && JSON.stringify(current.indexes) !== JSON.stringify(this.originalSchema[name].indexes)) {
              const store = this.objectStore(name), r = store.openCursor();
              r.onsuccess = () => { if (r.result) { store.put(r.result.value, store.keyPath === null ? r.result.primaryKey : undefined); r.result.continue(); } };
            }
          }
        }
        // All initial requests and requests enqueued by success callbacks run in order.
        await new Promise(resolve => setTimeout(resolve, 0));
        while (this.phase === 'active') {
          const job = this.queue.shift();
          if (!job) break;
          try {
            const result = await job.action();
            if (this.phase !== 'active') return;
            job.request.success(result);
          } catch (error) {
            if (!job.request.fail(error).defaultPrevented) throw error;
          }
        }
        if (this.phase !== 'active') return;
        if (this.mode !== 'readonly' && (this.operations.length || this.request)) {
          writable(); this.phase = 'committing';
          const id = 'tx-' + unique();
          const operations = [];
          for (const op of this.operations) operations.push(op.type === 'put' ? Object.assign({}, op, { value: await encode(op.value) }) : op);
          const body = { id, name: this.db.name, revision: this.revision, operations };
          if (this.request) { body.schema = this.db.state.schema; body.version = this.db.state.version; }
          const result = await commitWithReceipt(body);
          // No terminal event may claim rollback while a commit could have reached SQLite.
          if (!result) { report(fault('ServerWriteUnconfirmedError', '无法确认服务器是否已提交这次保存')); this.error = blocked; this.emit('error'); return; }
          this.db.state.revision = result.revision;
        }
        this.phase = 'done'; this.db.upgrade = null;
        try { this.emit('complete'); if (this.request) { this.request.transaction = null; this.request.success(this.db); } }
        finally { this.release(); }
      } catch (error) {
        if (['ServerConflictError', 'NetworkError', 'UnknownError', 'TypeError'].includes(error.name)) report(error);
        this.fail(error);
      }
    }
    async rows(store, index, query, keysOnly) {
      const data = await remote('read', { name: this.db.name, store, index, query, keysOnly, revision: this.revision });
      let rows = data.rows.map(row => Object.assign({}, row, keysOnly ? {} : { value: decode(row.value) }));
      for (const op of this.operations.filter(o => o.store === store)) {
        if (op.type === 'clear') { rows = []; continue; }
        rows = rows.filter(row => cmp(row.primaryKey, op.key) !== 0);
        if (op.type === 'put') {
          const keys = index ? op.indexes[index] || [] : [op.key];
          keys.filter(k => matches(k, query)).forEach(k => rows.push({ key: k, primaryKey: op.key, value: clone(op.value) }));
        }
      }
      rows.sort((a, b) => cmp(a.key, b.key) || cmp(a.primaryKey, b.primaryKey)); return rows;
    }
  }
  class Store {
    constructor(tx, name, index) { this.transaction = tx; this.name = name; this.indexName = index || null; }
    get schema() { return this.transaction.db.state.schema[this.name]; }
    get keyPath() { return this.indexName ? this.schema.indexes[this.indexName].keyPath : this.schema.keyPath; }
    get autoIncrement() { return !!this.schema.autoIncrement; }
    get indexNames() { return names(Object.keys(this.schema.indexes)); }
    index(name) { if (!this.schema.indexes[name]) throw fault('NotFoundError', '索引不存在'); return new Store(this.transaction, this.name, name); }
    createIndex(name, keyPath, options) {
      if (this.transaction.mode !== 'versionchange') throw fault('InvalidStateError', '只能在升级时创建索引');
      if (this.schema.indexes[name]) throw fault('ConstraintError', '索引已存在');
      this.schema.indexes[name] = Object.assign({ keyPath, unique: false, multiEntry: false }, options); return this.index(name);
    }
    deleteIndex(name) { if (this.transaction.mode !== 'versionchange') throw fault('InvalidStateError', '只能在升级时删除索引'); delete this.schema.indexes[name]; }
    get(query) { return this.select(query, false, rows => rows.length ? clone(rows[0].value) : undefined); }
    getKey(query) { return this.select(query, true, rows => rows.length ? unkey(rows[0].primaryKey) : undefined); }
    getAll(query, count) { return this.select(query, false, rows => rows.slice(0, count === undefined ? rows.length : count).map(r => clone(r.value))); }
    getAllKeys(query, count) { return this.select(query, true, rows => rows.slice(0, count === undefined ? rows.length : count).map(r => unkey(r.primaryKey))); }
    count(query) { return this.select(query, true, rows => rows.length); }
    select(query, keysOnly, project) {
      const q = range(query); return this.transaction.add(this, async () => project(await this.transaction.rows(this.name, this.indexName, q, keysOnly)));
    }
    put(value, explicitKey) { return this.write(value, explicitKey, false); }
    add(value, explicitKey) { return this.write(value, explicitKey, true); }
    write(value, explicitKey, add) {
      if (this.transaction.mode === 'readonly' || this.indexName) throw fault('ReadOnlyError', '只读事务不能写入');
      const frozen = clone(value), inline = this.schema.keyPath !== null;
      if (inline && explicitKey !== undefined) throw fault('DataError', '内联键不能指定外部键');
      const k = key(inline ? path(frozen, this.schema.keyPath) : explicitKey);
      return this.transaction.add(this, async () => {
        if (add && (await this.transaction.rows(this.name, null, { lower: k, upper: k }, true)).length) throw fault('ConstraintError', '记录已存在');
        this.transaction.operations.push({ type: 'put', store: this.name, key: k, value: frozen, add, indexes: indexes(frozen, this.schema) });
        return unkey(k);
      });
    }
    delete(query) {
      if (this.transaction.mode === 'readonly') throw fault('ReadOnlyError', '只读事务不能删除');
      const q = range(query);
      return this.transaction.add(this, async () => {
        if (q && 'lower' in q && 'upper' in q && cmp(q.lower, q.upper) === 0 && !q.lowerOpen && !q.upperOpen) {
          this.transaction.operations.push({ type: 'delete', store: this.name, key: q.lower }); return;
        }
        const rows = await this.transaction.rows(this.name, null, q, true);
        rows.forEach(row => this.transaction.operations.push({ type: 'delete', store: this.name, key: row.primaryKey }));
      });
    }
    clear() {
      if (this.transaction.mode === 'readonly') throw fault('ReadOnlyError', '只读事务不能清空');
      return this.transaction.add(this, async () => { this.transaction.operations.push({ type: 'clear', store: this.name }); });
    }
    openCursor(query, direction) { return this.cursor(query, direction, false); }
    openKeyCursor(query, direction) { return this.cursor(query, direction, true); }
    cursor(query, direction, keysOnly) {
      const q = range(query), tx = this.transaction, request = new Request(this, tx), source = this;
      let rows, position = 0, cursor;
      async function step() {
        if (!rows) {
          rows = await tx.rows(source.name, source.indexName, q, keysOnly);
          if (String(direction).startsWith('prev')) rows.reverse();
          if (String(direction).endsWith('unique')) rows = rows.filter((r, i) => !i || cmp(r.key, rows[i - 1].key));
        }
        const row = rows[position++];
        cursor = row ? { source, direction: direction || 'next', key: unkey(row.key), primaryKey: unkey(row.primaryKey),
          continue(nextKey) { if (nextKey !== undefined) { const k = key(nextKey); while (position < rows.length && (String(direction).startsWith('prev') ? cmp(rows[position].key, k) > 0 : cmp(rows[position].key, k) < 0)) position++; } enqueue(); },
          advance(n) { if (!Number.isInteger(n) || n < 1) throw new TypeError('游标步数必须为正整数'); position += n - 1; enqueue(); },
          update(value) { return source.transaction.objectStore(source.name).put(value, source.schema.keyPath === null ? unkey(row.primaryKey) : undefined); },
          delete() { return source.transaction.objectStore(source.name).delete(unkey(row.primaryKey)); } } : null;
        if (cursor && !keysOnly) cursor.value = clone(row.value);
        return cursor;
      }
      function enqueue() {
        if (['done', 'committing', 'aborted'].includes(tx.phase)) throw fault('TransactionInactiveError', '事务已结束');
        request.readyState = 'pending'; tx.queue.push({ request, action: step });
      }
      enqueue(); return request;
    }
  }
  function unique() { return root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : Array.from(root.crypto.getRandomValues(new Uint32Array(4))).map(n => n.toString(16)).join('-'); }
  async function stateFor(name) {
    if (!states.has(name)) {
      const state = { name, connections: new Set(), tail: Promise.resolve() };
      state.ready = remote('open', { name }).then(meta => { Object.assign(state, meta); return state; }); states.set(name, state);
    }
    return states.get(name).ready;
  }
  const factory = {
    cmp(a, b) { return nativeDB.cmp(a, b); },
    open(name, version) {
      const request = new Request();
      setTimeout(async () => {
        try {
          if (blocked) throw blocked;
          const state = await stateFor(String(name)); await state.tail;
          const wanted = version === undefined ? state.version || 1 : Number(version);
          if (!Number.isInteger(wanted) || wanted < 1 || wanted < state.version) throw fault('VersionError', '数据库版本不兼容');
          const db = new Database(state);
          if (wanted > state.version) { request.version = wanted; new Transaction(db, Object.keys(state.schema), 'versionchange', request); }
          else request.success(db);
        } catch (error) { request.fail(error); }
      }, 0);
      return request;
    },
    deleteDatabase(name) {
      const request = new Request();
      setTimeout(async () => {
        try {
          writable(); const state = await stateFor(String(name)); await state.tail;
          state.connections.forEach(db => { db.emit('versionchange', { oldVersion: state.version, newVersion: null }); db.close(); });
          const result = await remote('delete', { name: String(name), revision: state.revision });
          state.version = 0; state.schema = {}; state.revision = result.revision; request.success(undefined);
        } catch (error) { if (error.name === 'ServerConflictError') report(error); request.fail(error); }
      }, 0); return request;
    }
  };
  function installLocal(boot) {
    const values = new Map(Object.entries(boot.values)), versions = Object.assign(Object.create(null), boot.versions);
    let revision = boot.revision;
    function mutate(body) { writable(); try { const result = sync('local', body); revision = result.revision; return result; } catch (e) { report(e); throw e; } }
    const storage = {
      get length() { return values.size; }, key(i) { return [...values.keys()][Number(i)] ?? null; },
      getItem(k) { if (blocked) throw blocked; return values.has(String(k)) ? values.get(String(k)) : null; },
      setItem(k, v) { writable(); k = String(k); v = String(v); if (projectRestorePending && (k === 'tm_P_lite' || k === 'tm_P')) throw projectRestoreError(); if (values.get(k) === v) return; const result = mutate({ key: k, value: v, version: versions[k] || 0 }); values.set(k, v); versions[k] = result.version; },
      removeItem(k) { writable(); k = String(k); if (projectRestorePending && k === 'tm_P') throw projectRestoreError(); if (!values.has(k)) return; const result = mutate({ key: k, value: null, version: versions[k] || 0 }); values.delete(k); versions[k] = result.version; },
      clear() { mutate({ clear: true, revision }); values.forEach((_, k) => { versions[k] = revision; }); values.clear(); }
    };
    const proxy = new Proxy(storage, {
      get(target, k) { if (typeof k === 'symbol' || k in target) return Reflect.get(target, k); return storage.getItem(k) === null ? undefined : storage.getItem(k); },
      set(target, k, v) { storage.setItem(k, v); return true; }, deleteProperty(target, k) { storage.removeItem(k); return true; },
      ownKeys() { return [...values.keys()]; }, getOwnPropertyDescriptor(_, k) { return values.has(k) ? { configurable: true, enumerable: true, writable: true, value: values.get(k) } : undefined; }
    });
    Object.defineProperty(root, 'localStorage', { configurable: true, value: proxy });
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('tm-server-local-storage:' + datasetId);
      ['setItem', 'removeItem', 'clear'].forEach(method => {
        const operation = storage[method];
        storage[method] = function (k, v) {
          const oldValue = method === 'clear' ? null : storage.getItem(k);
          operation(k, v);
          channel.postMessage({ key: method === 'clear' ? null : String(k), oldValue,
            newValue: method === 'setItem' ? String(v) : null, revision,
            versions: method === 'clear' ? versions : { [String(k)]: versions[String(k)] } });
        };
      });
      channel.onmessage = event => {
        const row = event.data;
        if (row.key === null) values.clear(); else if (row.newValue === null) values.delete(row.key); else values.set(row.key, row.newValue);
        Object.assign(versions, row.versions); revision = row.revision;
        root.dispatchEvent(new StorageEvent('storage', { key: row.key, oldValue: row.oldValue, newValue: row.newValue, url: root.location.href }));
      };
    }
  }
  try {
    const boot = sync('bootstrap');
    datasetId = boot.datasetId;
    gzipRequests = !!boot.gzipRequests;
    root.TMServerStorage = { mode: 'sqlite', encode, decode, flush: () => Promise.all([...states.values()].map(s => s.tail)),
      beforeUnload(event) {
        // Normal project/settings writes own persistence. A large emergency
        // localStorage snapshot cannot be sent with sync XHR during dismissal.
        if (pendingWrites.size && event) { event.preventDefault(); event.returnValue = ''; }
      }
    };
    // Parallel downloads shorten parser stalls. A delayed project read must still
    // finish before automatic scenario registration can persist startup defaults.
    projectRestorePending = !!boot.hasProject && ['/', '/index.html'].includes(root.location.pathname);
    root.addEventListener('tm:p-restored', () => { projectRestorePending = false; }, { once: true });
    installLocal(boot); Object.defineProperty(root, 'indexedDB', { configurable: true, value: factory });
  } catch (error) {
    report(error); installLocal({ values: {}, versions: {}, revision: 0 });
    Object.defineProperty(root, 'indexedDB', { configurable: true, value: factory });
  }
})(window);
