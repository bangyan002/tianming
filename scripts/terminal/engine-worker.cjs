'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Storage } = require('./storage.cjs');

const ORIGIN = 'http://tianming.localhost', root = path.join(workerData.root, 'web');
let dom, context, storage, closed = false, currentScript = null;
const diagnostics = [];
if (process.env.TM_TERMINAL_DEBUG) setInterval(() => parentPort.postMessage({ log: 'Node heap: ' + Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB' }), 5000).unref();
function run(code, filename = 'terminal-operation', script = null) {
  const previous = currentScript; currentScript = script;
  try { return new vm.Script(code, { filename }).runInContext(context, { timeout: 60000 }); }
  catch (error) { throw Object.assign(Error(filename + ': ' + error.message), { code: error.code }); }
  finally { currentScript = previous; }
}
function dialog(type, message, defaultValue) {
  const shared = new SharedArrayBuffer(65536), view = new Int32Array(shared, 0, 2);
  parentPort.postMessage({ dialog: { type, message: String(message), defaultValue }, shared });
  const outcome = Atomics.wait(view, 0, 0, 10 * 60 * 1000);
  if (outcome === 'timed-out') return type === 'confirm' ? false : null;
  const text = Buffer.from(new Uint8Array(shared, 8, Atomics.load(view, 1))).toString('utf8');
  const answer = JSON.parse(text);
  return type === 'confirm' ? answer.accept : type === 'prompt' ? answer.accept ? answer.text : null : undefined;
}
function installPlatform(window) {
  Object.defineProperty(window.document, 'currentScript', { get: () => currentScript });
  // The terminal supplies its own text views. Keep the graphical stage hidden
  // and omit its central panel so original renderers take their existing early
  // exits, retaining data synchronization without constructing SVG/map screens.
  const stage = window.document.getElementById('G');
  if (stage) Object.defineProperty(stage.style, 'display', { get: () => 'none', set() {}, configurable: true });
  const centralPanel = window.document.getElementById('gc');
  if (centralPanel) centralPanel.remove();
  const log = (kind, args) => {
    if (kind === 'error' || kind === 'warn') { diagnostics.push(args.map(value => String(value)).join(' ')); if (diagnostics.length > 40) diagnostics.shift(); }
    if (process.env.TM_TERMINAL_DEBUG) parentPort.postMessage({ log: kind + ': ' + args.map(value => String(value)).join(' ') });
  };
  window.console = Object.fromEntries(['log', 'error', 'warn', 'info', 'debug', 'trace'].map(kind => [kind, (...args) => log(kind, args)]));
  for (const name of ['structuredClone', 'Blob', 'Response', 'Request', 'Headers', 'AbortController', 'AbortSignal', 'CompressionStream', 'DecompressionStream', 'TextEncoder', 'TextDecoder', 'ReadableStream', 'TransformStream', 'WritableStream']) window[name] = globalThis[name];
  Object.defineProperty(window, 'crypto', { value: webcrypto });
  window.Worker = undefined; // The game's existing main-thread save fallback remains available.
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN + '/');
    if (url.origin !== ORIGIN) return fetch(input, init);
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) return new Response('', { status: 403 });
    try {
      const actual = await fs.promises.realpath(file);
      if (!actual.startsWith(root + path.sep)) return new Response('', { status: 403 });
      return new Response(await fs.promises.readFile(actual), { headers: { 'Content-Type': path.extname(file) === '.json' ? 'application/json' : 'application/octet-stream' } });
    } catch (_) { return new Response('', { status: 404 }); }
  };
  window.alert = message => dialog('alert', message);
  window.confirm = message => dialog('confirm', message);
  window.prompt = (message, value) => dialog('prompt', message, value);
  window.matchMedia = query => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.requestIdleCallback = callback => window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0);
  window.cancelIdleCallback = window.clearTimeout;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800 }; };
  window.HTMLElement.prototype.getClientRects = function () {
    if (!this.isConnected) return [];
    for (let node = this; node && node.style; node = node.parentElement) if (node.hidden || node.style.display === 'none' || node.style.visibility === 'hidden') return [];
    return [this.getBoundingClientRect()];
  };
  window.HTMLCanvasElement.prototype.getContext = function () {
    if (this._terminalContext) return this._terminalContext;
    const canvas = this, gradient = { addColorStop() {} };
    const target = { canvas, measureText: text => ({ width: String(text).length * 6 }), createLinearGradient: () => gradient, createRadialGradient: () => gradient, createPattern: () => null, getLineDash: () => [], getImageData: () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 }) };
    this._terminalContext = new Proxy(target, { get(object, key) { return key in object ? object[key] : () => {}; } });
    return this._terminalContext;
  };
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  const append = window.Node.prototype.appendChild;
  window.Node.prototype.appendChild = function (node) {
    const result = append.call(this, node);
    if (node.tagName === 'SCRIPT' && node.src) window.queueMicrotask(async () => {
      try {
        const url = new URL(node.src, ORIGIN), file = path.resolve(root, '.' + url.pathname);
        if (url.origin !== ORIGIN || !file.startsWith(root + path.sep)) throw Error('终端只加载仓库内的游戏脚本');
        run(await fs.promises.readFile(file, 'utf8'), url.pathname, node);
        node.dispatchEvent(new window.Event('load'));
      } catch (_) { node.dispatchEvent(new window.Event('error')); }
    });
    return result;
  };
  // outside-only prevents markup/AI content from executing scripts. Explicit
  // terminal choices can still invoke a trusted game's inline button handler.
  window.__tmTerminalClick = function (button) {
    button.click();
    if (!button.onclick && button.getAttribute('onclick')) {
      window.__tmTerminalClickedButton = button;
      run('(function(event){' + button.getAttribute('onclick') + '\n}).call(__tmTerminalClickedButton,new Event("click"))');
      delete window.__tmTerminalClickedButton;
    }
  };
}

async function start() {
  storage = new Storage(workerData.dataDir); await storage.restore();
  const console = new VirtualConsole(); console.on('jsdomError', error => { diagnostics.push(error.message); });
  dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), { url: ORIGIN + '/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
  context = dom.getInternalVMContext(); installPlatform(dom.window); storage.mount(dom.window);
  const scripts = Array.from(dom.window.document.scripts), deferred = [];
  for (const script of scripts) {
    if (script.defer) { deferred.push(script); continue; }
    await load(script);
  }
  for (const script of deferred) await load(script);
  await run('TM_SaveDB.open()'); storage.bindGame(dom.window);
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded', { bubbles: true }));
  dom.window.dispatchEvent(new dom.window.Event('load'));
  await new Promise(resolve => setTimeout(resolve, 150));
  await run("typeof _tmAwaitLoadBarrier==='function' ? _tmAwaitLoadBarrier() : true");
  await run('TMOfficialScenarioLoader.ready()');
  run(fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8'), 'terminal/renderer.js');
  await storage.flush();
  return { loaded: scripts.length };
}
async function load(script) {
  if (script.src) {
    const url = new URL(script.src), file = path.resolve(root, '.' + url.pathname);
    if (url.origin !== ORIGIN || !file.startsWith(root + path.sep)) throw Error('启动脚本路径不受支持：' + url.pathname);
    run(fs.readFileSync(file, 'utf8'), url.pathname, script);
  } else if (!script.type || ['text/javascript', 'application/javascript'].includes(script.type)) run(script.textContent, 'index-inline', script);
}
let queue = Promise.resolve();
parentPort.on('message', message => {
  queue = queue.then(async () => {
    try {
      if (process.env.TM_TERMINAL_DEBUG) parentPort.postMessage({ log: 'Operation: ' + (message.operation || message.action) });
      let result;
      if (message.action === 'start') result = await start();
      else if (message.action === 'evaluate') { result = await run(message.expression); if (typeof result === 'function') result = undefined; }
      else if (message.action === 'call') { result = await dom.window.TMTerminal.call(message.operation, message.args); await storage.flush(); }
      else if (message.action === 'close') { closed = true; if (dom) dom.window.close(); if (storage) await storage.close(); }
      else throw Error('未知运行时操作');
      parentPort.postMessage({ id: message.id, result });
    } catch (error) { parentPort.postMessage({ id: message.id, error: String(error.message), code: error.code, diagnostics: diagnostics.slice(-5) }); }
  });
});
