/* Native IndexedDB owns gameplay. Only explicit saves upload to SQLite. */
(function (root) {
  'use strict';
  const API = '/__tm_storage__/', nativeDB = root.indexedDB, nativeLocal = root.localStorage, codec = root.TMStorageCodec;
  const connections = new Map(), preparing = new Map(), localWrites = new Set();
  let boot, prefix, catalogKey, uploading = null, capturing = null, lastError = null, localError = null;
  let restorePending = false, box = null, label = null, button = null, journalReady;
  let mountedInRail = false, positionQueued = false, railSizeObserver = null, observedCap = null, floatingButtonStyle = '';
  let saveWorker = null, workerUnavailable = false, workerSequence = 0;
  const workerRequests = new Map();
  function stopWorker(message) {
    workerUnavailable = true;
    if (saveWorker) saveWorker.terminate(); saveWorker = null;
    for (const request of workerRequests.values()) {
      clearTimeout(request.timer); const error = fault('SaveWorkerUnavailableError', message);
      error.workerUnavailable = true; request.reject(error);
    }
    workerRequests.clear();
  }
  function background(task, data) {
    if (workerUnavailable || typeof root.Worker !== 'function') return null;
    if (!saveWorker) {
      try {
        saveWorker = new root.Worker(API + 'save-worker.js');
        saveWorker.onmessage = event => {
          const reply = event.data, request = workerRequests.get(reply.requestId); if (!request) return;
          clearTimeout(request.timer); workerRequests.delete(reply.requestId);
          if (reply.error) { const error = fault(reply.error.name, reply.error.message); error.code = reply.error.code; request.reject(error); }
          else request.resolve(reply.result);
        };
        saveWorker.onerror = event => { event.preventDefault(); stopWorker('后台保存暂不可用，请再次保存。'); };
      } catch (_) { workerUnavailable = true; return null; }
    }
    const requestId = ++workerSequence; let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => stopWorker('后台保存准备超时，请再次保存。'), task === 'canonical' ? 60000 : 180000);
    workerRequests.set(requestId, { resolve, reject, timer });
    try { saveWorker.postMessage({ requestId, task, data }); }
    catch (_) { clearTimeout(timer); workerRequests.delete(requestId); return null; }
    return promise;
  }
  function backgroundCanonical(state, identity) {
    // postMessage clones immediately, preserving the original serialization point.
    const pending = background('canonical', { state,
      compress: !!(root.SaveCompression && root.SaveCompression.supported && typeof root.DecompressionStream === 'function'),
      sha256: !!(root.crypto && root.crypto.subtle && typeof root.TextEncoder === 'function') });
    if (!pending) return null;
    return pending.then(parts => Object.freeze(Object.assign(parts, {
      state, identity: Object.freeze(Object.assign({}, identity || {}))
    })));
  }
  function yieldToPage() {
    return new Promise(resolve => {
      if (document.visibilityState === 'visible') root.requestAnimationFrame(() => setTimeout(resolve, 0));
      else setTimeout(resolve, 0);
    });
  }
  function positionSaveButton() {
    if (!box) return;
    const cap = document.querySelector('#tm-right-rail > .tm-rc-cap, #tm-phase8-formal-rail > .tmf-rail-cap');
    if (railSizeObserver && cap !== observedCap) {
      if (observedCap) railSizeObserver.unobserve(observedCap);
      if (cap) railSizeObserver.observe(cap); observedCap = cap;
    }
    const inRail = !!(cap && cap.getClientRects().length && getComputedStyle(cap).visibility !== 'hidden');
    if (inRail) {
      if (box.parentNode !== cap.parentNode || box.previousElementSibling !== cap) cap.after(box);
    } else if (box.parentNode !== document.body) document.body.appendChild(box);
    if (inRail !== mountedInRail) {
      mountedInRail = inRail; box.classList.toggle('tm-server-save-in-rail', inRail);
      button.className = inRail ? 'tm-rc-icon tm-server-save-button' : '';
      button.style.cssText = inRail ? '' : floatingButtonStyle;
    }
    const text = inRail ? uploading ? '上传' : capturing ? '本机' : '保存' : uploading ? '正在上传…' : capturing ? '正在存本机…' : '保存到服务器';
    if (button.textContent !== text) button.textContent = text;
  }
  function positionSoon() {
    if (positionQueued) return; positionQueued = true;
    root.requestAnimationFrame(() => { positionQueued = false; positionSaveButton(); });
  }
  const uid = () => root.crypto.randomUUID ? root.crypto.randomUUID() : Array.from(root.crypto.getRandomValues(new Uint32Array(4))).join('-');
  function fault(name, message) { const error = new Error(message); error.name = name; return error; }
  function readJSON(key, fallback) { const value = nativeLocal.getItem(key); return value === null ? fallback : JSON.parse(value); }
  function catalog() { return readJSON(catalogKey, { databases: {}, settingsSynced: {}, settingsVersions: {}, lastUpload: null }); }
  function update(change) { const value = catalog(); change(value); nativeLocal.setItem(catalogKey, JSON.stringify(value)); return value; }
  function values() {
    const result = {}, start = prefix + 'value:';
    for (let i = 0; i < nativeLocal.length; i++) { const key = nativeLocal.key(i); if (key.startsWith(start)) result[key.slice(start.length)] = nativeLocal.getItem(key); }
    return result;
  }
  function dirty() {
    const meta = catalog(), local = values();
    return Object.values(meta.databases).some(row => row.token !== row.syncedToken) ||
      [...new Set(Object.keys(local).concat(Object.keys(meta.settingsSynced)))].some(key => (local[key] ?? null) !== (meta.settingsSynced[key] ?? null));
  }
  function status() { return { mode: 'local-first', uploading: !!uploading, capturing: !!capturing, pendingLocalWrites: localWrites.size,
    dirty: dirty(), localError, error: lastError, lastUpload: catalog().lastUpload }; }
  function render() {
    if (!document.body || !catalogKey) return;
    if (!box) {
      box = document.createElement('section'); box.id = 'tm-server-save-status';
      box.setAttribute('aria-label', '存档状态'); box.setAttribute('aria-live', 'polite');
      box.style.cssText = 'position:fixed;right:12px;bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483000;max-width:calc(100vw - 24px);box-sizing:border-box;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 12px;border:1px solid #a9894d;border-radius:8px;background:#292319;color:#f5e6c8;font:13px sans-serif;box-shadow:0 2px 12px #0004;';
      label = document.createElement('span'); button = document.createElement('button'); button.type = 'button';
      button.style.cssText = 'border:1px solid #b4955e;border-radius:5px;padding:7px 10px;background:#dfc088;color:#302619;font:inherit;cursor:pointer;';
      floatingButtonStyle = button.style.cssText;
      button.onclick = () => { saveCurrent().catch(() => {}); };
      box.append(label, button); document.body.appendChild(box);
      const style = document.createElement('style'); style.id = 'tm-server-save-rail-style';
      style.textContent = '#tm-server-save-status.tm-server-save-in-rail{position:relative!important;inset:auto!important;transform:none!important;z-index:auto!important;width:40px;max-width:none!important;padding:0!important;border:0!important;border-radius:0!important;background:none!important;box-shadow:none!important;flex:0 0 auto;pointer-events:auto;}' +
        '#tm-server-save-status.tm-server-save-in-rail>span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;}' +
        '#tm-server-save-status.tm-server-save-in-rail>button{width:40px;height:40px;padding:0!important;font:14px "STKaiti","KaiTi",serif!important;letter-spacing:0!important;pointer-events:auto;}' +
        '#tm-server-save-status.tm-server-save-in-rail>button:disabled{opacity:.55;cursor:wait;}';
      document.head.appendChild(style);
      new MutationObserver(positionSoon).observe(document.body, { childList: true, subtree: true });
      if (typeof ResizeObserver === 'function') railSizeObserver = new ResizeObserver(positionSoon);
      root.addEventListener('resize', positionSoon);
    }
    button.disabled = !!uploading || !!capturing;
    button.textContent = uploading ? '正在上传…' : capturing ? '正在存本机…' : '保存到服务器';
    label.textContent = localError ? '本机保存失败，请保留当前页面：' + localError.message :
      lastError ? '服务器未保存，本机进度已保留。' + lastError.message :
      uploading ? '已存本机，正在上传；可以继续游戏' :
      localWrites.size || capturing ? '正在保存到本机' : dirty() ? '已存本机 · 尚未上传' : '已保存到服务器';
    button.title = '保存到服务器 · ' + label.textContent;
    button.setAttribute('aria-label', button.title); button.setAttribute('data-tip', button.title);
    positionSaveButton();
    root.dispatchEvent(new CustomEvent('tm:server-save-state', { detail: status() }));
  }
  function report(error, local) { if (local) localError = error; else lastError = error; render(); }
  function changed(name, deleted, hasProject) {
    update(meta => { const row = meta.databases[name] || { initialized: true, revision: 0, syncedToken: null };
      row.token = uid(); row.deleted = !!deleted; meta.databases[name] = row;
      if (hasProject) meta.hasLocalProject = true; });
    localError = null; render();
  }
  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.addEventListener('complete', resolve, { once: true });
      tx.addEventListener('abort', () => reject(tx.error || fault('AbortError', '本机保存已中止')), { once: true });
    });
  }
  function watch(tx, name) {
    if (tx.mode === 'readonly') return tx;
    const settled = done(tx); localWrites.add(settled); render();
    settled.then(() => changed(name, false, name === 'tianming_db' && Array.from(tx.objectStoreNames).includes('projects')), error => report(error, true)).catch(error => report(error, true))
      .finally(() => { localWrites.delete(settled); render(); });
    return tx;
  }
  async function flushLocal() { while (localWrites.size) await Promise.all([...localWrites]); await Promise.resolve(); if (localError) throw localError; }
  async function payloadFor(body) {
    const text = JSON.stringify(body), large = text.length >= 256 * 1024;
    if (large && boot.gzipRequests && typeof root.CompressionStream === 'function') {
      try {
        const plain = new Blob([text]), packed = await new Response(plain.stream().pipeThrough(new root.CompressionStream('gzip'))).blob();
        if (packed.size < plain.size) return { body: packed, gzip: true, large };
      } catch (_) { /* Older browsers can upload JSON without compression. */ }
    }
    return { body: text, gzip: false, large };
  }
  async function remote(path, body, prepared) {
    const payload = prepared || await payloadFor(body), controller = new AbortController();
    const headers = { 'Content-Type': 'application/json', 'X-TM-Storage-ID': boot.datasetId };
    if (payload.gzip) headers['Content-Encoding'] = 'gzip';
    const timer = setTimeout(() => controller.abort(), path === 'commit' && payload.large ? 180000 : path === 'outcome' ? 5000 : 45000);
    try {
      const response = await fetch(API + path, { method: 'POST', headers, body: payload.body, signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) {
        const message = data.name === 'ServerConflictError' ? '服务器存档已被其他页面更新，暂未覆盖。' :
          data.name === 'ServerResetError' ? '服务器已重置，本机副本仍保留。' : data.error || '服务器请求失败';
        throw fault(data.name || 'NetworkError', message);
      }
      return data;
    } finally { clearTimeout(timer); }
  }
  async function commitWithReceipt(body, prepared) {
    const payload = prepared || await payloadFor(body);
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await remote('commit', body, payload); }
      catch (error) {
        if (['ServerConflictError', 'ServerResetError', 'ConstraintError', 'DataError'].includes(error.name)) throw error;
        try { const result = await remote('outcome', { id: body.id }); if (result.committed) return result; }
        catch (_) { throw fault('ServerWriteUnconfirmedError', '暂未确认提交结果，可再次点击保存核对。'); }
      }
    }
    throw fault('ServerWriteUnconfirmedError', '暂未确认提交结果，可再次点击保存核对。');
  }
  class Request {
    constructor() { this.result = undefined; this.error = null; this.readyState = 'pending'; this.transaction = null; this.listeners = new Map(); }
    addEventListener(type, fn, options) { const rows = this.listeners.get(type) || []; rows.push({ fn, once: !!(options && options.once) }); this.listeners.set(type, rows); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(row => row.fn !== fn)); }
    emit(type, original) {
      const event = { type, target: this, currentTarget: this, oldVersion: original && original.oldVersion, newVersion: original && original.newVersion,
        preventDefault() { if (original) original.preventDefault(); }, stopPropagation() { if (original) original.stopPropagation(); } };
      if (typeof this['on' + type] === 'function') this['on' + type](event);
      for (const row of [...(this.listeners.get(type) || [])]) {
        if (row.once) this.removeEventListener(type, row.fn);
        if (typeof row.fn === 'function') row.fn.call(this, event); else row.fn.handleEvent(event);
      }
    }
    fail(error) { this.error = error; this.readyState = 'done'; this.emit('error'); }
  }
  function rawOpen(name, version, upgrade) {
    return new Promise((resolve, reject) => {
      const request = version === undefined ? nativeDB.open(name) : nativeDB.open(name, version);
      request.onupgradeneeded = event => { if (upgrade) upgrade(request.result, request.transaction, event); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  function schemaOf(db, tx) {
    const schema = {};
    for (const name of db.objectStoreNames) {
      const store = tx.objectStore(name), indexes = {};
      for (const indexName of store.indexNames) { const index = store.index(indexName);
        indexes[indexName] = { keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }; }
      schema[name] = { keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes };
    }
    return schema;
  }
  function createSchema(db, schema) {
    for (const [name, spec] of Object.entries(schema)) {
      const store = db.createObjectStore(name, { keyPath: spec.keyPath, autoIncrement: !!spec.autoIncrement });
      for (const [index, options] of Object.entries(spec.indexes || {})) store.createIndex(index, options.keyPath, options);
    }
  }
  async function hydrate(name) {
    if (catalog().databases[name] && catalog().databases[name].initialized) return;
    const meta = await remote('open', { name }), stores = Object.keys(meta.schema), records = {};
    if (!meta.version) {
      update(current => { current.databases[name] = { initialized: true, revision: meta.revision, token: 'imported', syncedToken: 'imported', deleted: false }; });
      return;
    }
    for (const store of stores) records[store] = (await remote('read', { name, store, revision: meta.revision })).rows;
    const db = await rawOpen(prefix + 'db:' + name, Math.max(1, meta.version), db => createSchema(db, meta.schema));
    try {
      if (stores.length) {
        const tx = db.transaction(stores, 'readwrite'), settled = done(tx);
        for (const store of stores) for (const row of records[store]) {
          const target = tx.objectStore(store), value = codec.decode(row.value);
          if (target.keyPath === null) target.put(value, codec.unkey(row.primaryKey)); else target.put(value);
        }
        await settled;
      }
      update(current => { current.databases[name] = { initialized: true, revision: meta.revision, token: 'imported', syncedToken: 'imported', deleted: false }; });
    } finally { db.close(); }
  }
  async function ensureLocal(name) {
    if (!preparing.has(name)) preparing.set(name, hydrate(name).catch(error => { preparing.delete(name); throw error; }));
    return preparing.get(name);
  }
  function wrapDB(db, name) {
    if (!connections.has(name)) connections.set(name, new Set()); connections.get(name).add(db);
    db.addEventListener('versionchange', () => { db.close(); connections.get(name).delete(db); });
    return new Proxy(db, {
      get(target, key) {
        if (key === 'name') return name;
        if (key === 'transaction') return (stores, mode, options) => {
          const scope = typeof stores === 'string' ? [stores] : Array.from(stores);
          if (restorePending && name === 'tianming_db' && scope.includes('projects') && mode === 'readwrite') throw fault('ServerProjectRestorePending', '现有项目尚未恢复，未用启动默认值覆盖存档');
          return watch(target.transaction(stores, mode, options), name);
        };
        if (key === 'close') return () => { target.close(); connections.get(name).delete(target); };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      }, set(target, key, value) { return Reflect.set(target, key, value, target); }
    });
  }
  const factory = {
    cmp: nativeDB.cmp.bind(nativeDB),
    open(name, version) {
      name = String(name); const request = new Request();
      Promise.resolve().then(async () => {
        await ensureLocal(name);
        const inner = version === undefined ? nativeDB.open(prefix + 'db:' + name) : nativeDB.open(prefix + 'db:' + name, version);
        inner.onupgradeneeded = event => { request.result = wrapDB(inner.result, name); request.transaction = watch(inner.transaction, name); request.emit('upgradeneeded', event); };
        inner.onblocked = event => request.emit('blocked', event); inner.onerror = () => request.fail(inner.error);
        inner.onsuccess = () => { request.result = wrapDB(inner.result, name); request.transaction = null; request.readyState = 'done'; request.emit('success'); };
      }).catch(error => { report(error); request.fail(error); }); return request;
    },
    deleteDatabase(name) {
      name = String(name); const request = new Request();
      Promise.resolve().then(async () => {
        await ensureLocal(name); if (connections.has(name)) for (const db of connections.get(name)) db.close();
        const inner = nativeDB.deleteDatabase(prefix + 'db:' + name);
        inner.onerror = () => request.fail(inner.error); inner.onblocked = event => request.emit('blocked', event);
        inner.onsuccess = () => { changed(name, true); preparing.delete(name); request.readyState = 'done'; request.emit('success'); };
      }).catch(error => request.fail(error)); return request;
    },
    async databases() { return Object.entries(catalog().databases).filter(([, row]) => !row.deleted).map(([name]) => ({ name })); }
  };
  function journal() { return journalReady || (journalReady = rawOpen(prefix + 'upload-journal', 1, db => db.createObjectStore('jobs', { keyPath: 'name' }))); }
  async function journalRead(name) {
    const pending = background('recover', { prefix, name, gzip: boot.gzipRequests });
    if (pending) {
      try { return await pending; } catch (error) { if (!error.workerUnavailable) throw error; }
    }
    const db = await journal();
    return new Promise((resolve, reject) => { const r = db.transaction('jobs').objectStore('jobs').get(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  }
  async function journalWrite(job, remove) {
    const db = await journal(), tx = db.transaction('jobs', 'readwrite'), settled = done(tx);
    if (remove) tx.objectStore('jobs').delete(job.name); else tx.objectStore('jobs').put(job);
    await settled;
  }
  async function snapshot(name) {
    const row = catalog().databases[name], token = row.token;
    const pending = background('snapshot', { prefix, name, token, revision: row.revision, id: 'tx-' + uid(), deleted: row.deleted, gzip: boot.gzipRequests });
    if (pending) {
      try { return await pending; } catch (error) { if (!error.workerUnavailable) throw error; }
    }
    if (row.deleted) return { name, token, body: { id: 'tx-' + uid(), name, revision: row.revision, version: 0, schema: {}, operations: [] } };
    const db = await rawOpen(prefix + 'db:' + name), stores = Array.from(db.objectStoreNames), records = [];
    let schema = {};
    try {
      if (stores.length) {
        const tx = db.transaction(stores), settled = done(tx); schema = schemaOf(db, tx);
        // One read transaction captures a coherent snapshot of all stores.
        for (const store of stores) {
          const request = tx.objectStore(store).openCursor();
          request.onsuccess = () => { const cursor = request.result; if (cursor) { records.push({ store, key: cursor.primaryKey, value: cursor.value }); cursor.continue(); } };
        }
        await settled;
      }
      const operations = stores.map(store => ({ type: 'clear', store }));
      for (const record of records) operations.push({ type: 'put', store: record.store, key: codec.key(record.key),
        value: await codec.encode(record.value), indexes: codec.indexes(record.value, schema[record.store]) });
      return { name, token, body: { id: 'tx-' + uid(), name, revision: row.revision, version: db.version, schema, operations } };
    } finally { db.close(); }
  }
  async function uploadJob(job) {
    const outcome = await remote('outcome', { id: job.body.id });
    const result = outcome.committed ? outcome : await commitWithReceipt(job.body, job.payload);
    update(meta => { const row = meta.databases[job.name]; row.revision = result.revision; row.syncedToken = job.token; });
    await journalWrite(job, true);
  }
  function syncToServer() {
    if (uploading) return uploading;
    uploading = (async () => {
      lastError = null; await flushLocal();
      // Durable requests retain their ids across lost responses and page reloads.
      for (const name of Object.keys(catalog().databases)) { const old = await journalRead(name); if (old) await uploadJob(old); }
      const names = Object.entries(catalog().databases).filter(([, row]) => row.token !== row.syncedToken).map(([name]) => name);
      for (const name of names) { const job = await snapshot(name); await journalWrite(job); await uploadJob(job); }
      const local = values(), meta = catalog();
      for (const key of new Set(Object.keys(local).concat(Object.keys(meta.settingsSynced)))) {
        const value = local[key] ?? null; if (value === (meta.settingsSynced[key] ?? null)) continue;
        const result = await remote('local', { key, value, version: meta.settingsVersions[key] || 0 });
        update(current => { current.settingsVersions[key] = result.version;
          if (value === null) delete current.settingsSynced[key]; else current.settingsSynced[key] = value; });
      }
      update(current => { current.lastUpload = Date.now(); }); return { ok: true, dirty: dirty() };
    })().catch(error => { report(error); throw error; }).finally(() => { uploading = null; render(); });
    render(); return uploading;
  }
  function captureCurrent() {
    if (capturing) return capturing;
    capturing = (async () => {
      // Paint the save state before any synchronous world-snapshot work begins.
      await yieldToPage();
      if (typeof root.isWorldTransactionActive === 'function' && root.isWorldTransactionActive()) throw fault('WorldBusyError', '当前操作尚未完成，请稍后保存。');
      if (root.GM && root.GM.sid && typeof root.requestBackgroundAutosave === 'function') {
        const scheduled = await root.requestBackgroundAutosave({ reason: 'local-first-save', immediate: true });
        if (scheduled.ok && typeof root._tmAwaitBackgroundAutosaves === 'function') {
          const result = await root._tmAwaitBackgroundAutosaves();
          if (result && !result.ok && !result.skipped) throw (result.error || fault('LocalSaveError', '当前进度尚未存入本机。'));
        }
      }
      if (root.P && root.TM_SaveDB && typeof root.TM_SaveDB.saveProject === 'function' && !restorePending) {
        if (root.TM_SaveDB.assertWritable) root.TM_SaveDB.assertWritable();
        await root.TM_SaveDB.open();
        const view = Object.assign({}, typeof root._tmStripAiKeyView === 'function' ? root._tmStripAiKeyView(root.P) : root.P);
        delete view.gameState;
        // The shallow view changes no live fields; postMessage performs the one
        // synchronous freeze. IDB then stores that frozen copy on the worker.
        if (view.ai) {
          view.ai = Object.assign({}, view.ai); delete view.ai.key;
          if (view.ai.secondary) { view.ai.secondary = Object.assign({}, view.ai.secondary); delete view.ai.secondary.key; }
        }
        const pending = background('project', { prefix, project: view });
        let stored = false;
        if (pending) {
          try { await pending; changed('tianming_db', false, true); stored = true; }
          catch (error) { if (!error.workerUnavailable) throw error; }
        }
        if (!stored) {
          const project = typeof root.deepClone === 'function' ? root.deepClone(view) : structuredClone(view);
          await root.TM_SaveDB.saveProject(project);
        }
      }
      await flushLocal();
    })().catch(error => { report(error, error.name !== 'WorldBusyError'); throw error; }).finally(() => { capturing = null; render(); });
    render(); return capturing;
  }
  async function saveCurrent() { await captureCurrent(); return syncToServer(); }
  function installLocal() {
    const storage = {
      get length() { return Object.keys(values()).length; }, key(i) { return Object.keys(values())[Number(i)] ?? null; },
      getItem(key) { return nativeLocal.getItem(prefix + 'value:' + String(key)); },
      setItem(key, value) {
        key = String(key); value = String(value);
        if (restorePending && (key === 'tm_P' || key === 'tm_P_lite')) throw fault('ServerProjectRestorePending', '现有项目尚未恢复，未用启动默认值覆盖存档');
        try { if (storage.getItem(key) !== value) nativeLocal.setItem(prefix + 'value:' + key, value); localError = null; render(); }
        catch (error) { report(error, true); throw error; }
      },
      removeItem(key) { nativeLocal.removeItem(prefix + 'value:' + String(key)); render(); },
      clear() { for (const key of Object.keys(values())) nativeLocal.removeItem(prefix + 'value:' + key); render(); }
    };
    Object.defineProperty(root, 'localStorage', { configurable: true, value: new Proxy(storage, {
      get(target, key) { if (typeof key === 'symbol' || key in target) return Reflect.get(target, key); return storage.getItem(key) ?? undefined; },
      set(target, key, value) { storage.setItem(key, value); return true; }, deleteProperty(target, key) { storage.removeItem(key); return true; },
      ownKeys() { return Object.keys(values()); }, getOwnPropertyDescriptor(_, key) { const value = storage.getItem(key); return value === null ? undefined : { configurable: true, enumerable: true, writable: true, value }; }
    }) });
    root.addEventListener('storage', event => { if (event.key && event.key.startsWith(prefix)) render(); });
  }
  try {
    try {
      const xhr = new XMLHttpRequest(); xhr.open('GET', API + 'bootstrap', false); xhr.send();
      if (xhr.status !== 200) throw fault('NetworkError', '暂时无法连接服务器。');
      boot = JSON.parse(xhr.responseText); nativeLocal.setItem('__tm_local_first_active__', JSON.stringify({ datasetId: boot.datasetId, gzipRequests: boot.gzipRequests }));
    } catch (error) {
      const cached = readJSON('__tm_local_first_active__', null); if (!cached) throw error;
      boot = Object.assign({ values: {}, versions: {} }, cached); lastError = error;
    }
    prefix = '__tm_local_first__:' + boot.datasetId + ':'; catalogKey = prefix + 'catalog';
    if (nativeLocal.getItem(catalogKey) === null) {
      nativeLocal.setItem(catalogKey, JSON.stringify({ databases: {}, settingsSynced: boot.values, settingsVersions: boot.versions, lastUpload: null }));
      for (const [key, value] of Object.entries(boot.values)) nativeLocal.setItem(prefix + 'value:' + key, value);
    }
    restorePending = !!(boot.hasProject || catalog().hasLocalProject) && ['/', '/index.html'].includes(root.location.pathname);
    root.addEventListener('tm:p-restored', () => { restorePending = false; }, { once: true });
    installLocal(); Object.defineProperty(root, 'indexedDB', { configurable: true, value: factory });
    root.TMServerStorage = { mode: 'local-first', encode: codec.encode, decode: codec.decode, flush: flushLocal,
      saveLocal: captureCurrent, saveToServer: saveCurrent, syncToServer, status, createCanonicalPayload: backgroundCanonical,
      beforeUnload(event) { if ((localWrites.size || capturing) && event) { event.preventDefault(); event.returnValue = ''; } } };
    const timer = setInterval(() => { if (root.GM && root.GM.sid) captureCurrent().catch(() => {}); }, 60000);
    root.addEventListener('pagehide', () => clearInterval(timer));
    if (document.body) render(); else document.addEventListener('DOMContentLoaded', render, { once: true });
  } catch (error) {
    console.error('[TMServerStorage] local save initialization failed', error);
    const unavailable = { open() { const request = new Request(); setTimeout(() => request.fail(error), 0); return request; },
      deleteDatabase() { return this.open(); }, cmp: nativeDB.cmp.bind(nativeDB) };
    Object.defineProperty(root, 'indexedDB', { configurable: true, value: unavailable });
    Object.defineProperty(root, 'localStorage', { configurable: true, value: { getItem() { return null; }, setItem() { throw error; }, removeItem() { throw error; } } });
    root.TMServerStorage = { mode: 'unavailable', status: () => ({ localError: error }), saveToServer: () => Promise.reject(error) };
    const show = () => { const notice = document.createElement('div'); notice.id = 'tm-server-save-status';
      notice.textContent = '本机存档尚未就绪，请保留当前页面：' + error.message;
      notice.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483000;padding:10px;background:#292319;color:#f5e6c8;font:13px sans-serif'; document.body.appendChild(notice); };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
  }
})(window);
