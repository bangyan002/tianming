/* Structured-clone values shared by local IndexedDB and SQLite transport. */
(function (root) {
  'use strict';
  const nativeDB = root.indexedDB;
  function fault(name, message) { const error = new Error(message); error.name = name; return error; }
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
  root.TMStorageCodec = { encode, decode, key, unkey, indexes };
})(typeof window === 'undefined' ? self : window);
