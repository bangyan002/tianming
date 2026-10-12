'use strict';
// A real, hidden browser keeps the existing DOM/IndexedDB game engine intact.
// CDP uses private process pipes; a token-bound loopback relay carries AI traffic.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ORIGIN = 'http://tianming.localhost';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function findBrowser(explicit) {
  const candidates = [explicit, process.env.TM_BROWSER];
  if (process.platform === 'darwin') candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  if (process.platform === 'win32') {
    for (const folder of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(folder, 'Google/Chrome/Application/chrome.exe'), path.join(folder, 'Microsoft/Edge/Application/msedge.exe'));
    }
  }
  for (const folder of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'msedge']) candidates.push(path.join(folder, name));
  }
  for (const candidate of candidates.filter(Boolean)) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (_) {}
  }
  throw new Error('未找到 Chromium / Chrome / Edge。安装其中一个，或通过 --browser 路径指定。');
}

class Browser {
  constructor(options = {}) {
    this.root = options.root || path.resolve(__dirname, '../..');
    this.webRoot = fs.realpathSync(path.join(this.root, 'web'));
    this.dataDir = path.resolve(options.dataDir || path.join(os.homedir(), '.tianming-terminal'));
    this.executable = findBrowser(options.browser);
    this.noSandbox = options.noSandbox;
    this.pending = new Map();
    this.network = new Map();
    this.relayRequests = new Map();
    this.sequence = 0;
    this.buffer = Buffer.alloc(0);
    this.diagnostics = '';
    this.closed = false;
  }

  send(method, params = {}, sessionId = this.session, timeout = 60000) {
    if (this.closed) return Promise.reject(new Error('终端游戏引擎已关闭'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('引擎响应超时：' + method));
      }, timeout);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0', error => {
        if (error) { const request = this.pending.get(id); this.pending.delete(id); if (request) request.reject(error); }
      });
    });
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let boundary;
    while ((boundary = this.buffer.indexOf(0)) >= 0) {
      const raw = this.buffer.subarray(0, boundary).toString();
      this.buffer = this.buffer.subarray(boundary + 1);
      if (!raw) continue;
      const message = JSON.parse(raw);
      if (message.id) {
        const request = this.pending.get(message.id);
        if (request) {
          this.pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
        }
      } else if (message.method === 'Fetch.requestPaused') {
        this.serve(message.params, message.sessionId).catch(error => { this.diagnostics = String(error.message); });
      } else if (message.method === 'Page.javascriptDialogOpening') {
        // Blocking browser dialogs become a terminal choice, never an automatic approval.
        this.dialog = message.params;
        if (this.onDialog) this.onDialog(message.params).catch(error => { this.diagnostics = error.message; });
      } else if (message.method === 'Network.loadingFailed') {
        const controller = this.network.get(message.params.requestId);
        if (controller) controller.abort();
      }
    }
  }

  async serve({ requestId, request, resourceType, networkId }, sessionId) {
    const url = new URL(request.url);
    if (url.origin !== ORIGIN) {
      const urls = await this.evaluate("typeof P==='object' && P.ai ? [P.ai.url,P.ai.secondary && P.ai.secondary.url].filter(Boolean) : []", 10000);
      const provider = urls.some(value => { try { return new URL(value).origin === url.origin; } catch (_) { return false; } });
      if (provider) return this.proxy(requestId, request, networkId, sessionId);
      return this.send('Fetch.continueRequest', { requestId }, sessionId);
    }
    let body = Buffer.alloc(0), status = 404, type = 'text/plain; charset=utf-8';
    try {
      const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = path.resolve(this.webRoot, '.' + name);
      const inside = file.startsWith(this.webRoot + path.sep);
      // Text mode does not need portraits, audio, fonts or movie assets.
      if (request.method === 'GET' && inside && !['Image', 'Media', 'Font'].includes(resourceType)) {
        const actual = fs.realpathSync(file);
        if (actual.startsWith(this.webRoot + path.sep) && fs.statSync(actual).isFile()) {
          body = await fs.promises.readFile(actual); status = 200;
          type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm' })[path.extname(actual)] || 'application/octet-stream';
        }
      }
    } catch (_) {}
    await this.send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }], body: body.toString('base64') }, sessionId);
  }

  async proxy(requestId, request, networkId, sessionId) {
    // Terminal AI traffic uses Node's transport, so providers do not need CORS
    // support. Preserve the game's request/response and retry ownership.
    const cors = [
      { name: 'Access-Control-Allow-Origin', value: ORIGIN },
      { name: 'Access-Control-Allow-Credentials', value: 'true' },
      { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
      { name: 'Access-Control-Allow-Headers', value: request.headers['Access-Control-Request-Headers'] || request.headers['access-control-request-headers'] || 'authorization, content-type, anthropic-version, x-api-key' }
    ];
    if (request.method === 'OPTIONS') return this.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors }, sessionId);
    let postData = request.postData;
    if (request.hasPostData && postData === undefined && networkId) postData = (await this.send('Network.getRequestPostData', { requestId: networkId }, sessionId)).postData;
    const token = randomUUID(), controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    const finish = () => {
      clearTimeout(timeout); this.relayRequests.delete(token);
      if (networkId) this.network.delete(networkId);
    };
    controller.signal.addEventListener('abort', finish, { once: true });
    if (networkId) this.network.set(networkId, controller);
    this.relayRequests.set(token, { request, postData, cors, controller, finish });
    try {
      // URL substitution is invisible to the page. A loopback relay preserves
      // streaming headers/chunks, including first-token and abort semantics.
      await this.send('Fetch.continueRequest', { requestId, url: this.relayURL + '/' + token }, sessionId);
    } catch (error) { controller.abort(); throw error; }
  }

  async relay(req, res) {
    const token = req.url.slice(1), entry = this.relayRequests.get(token);
    if (!entry) { res.writeHead(404); res.end(); return; }
    for (const header of entry.cors) res.setHeader(header.name, header.value);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    this.relayRequests.delete(token);
    const { request, controller } = entry;
    req.resume();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !/^(host|origin|referer|content-length|accept-encoding|sec-)/i.test(name)));
      const response = await fetch(request.url, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : entry.postData, signal: controller.signal, redirect: 'manual' });
      for (const [name, value] of response.headers) {
        if (!/^(content-encoding|content-length|transfer-encoding|access-control-)/i.test(name)) res.setHeader(name, value);
      }
      res.writeHead(response.status); res.flushHeaders();
      if (response.body) await pipeline(Readable.fromWeb(response.body), res, { signal: controller.signal }); else res.end();
    } catch (error) {
      if (res.headersSent) res.destroy();
      else { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: '终端无法连接 AI 服务商：' + error.message } })); }
    } finally { entry.finish(); }
  }

  async start() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.lockPath = path.join(this.dataDir, 'terminal.lock');
    try { this.lock = fs.openSync(this.lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let alive = true;
      try { process.kill(Number(fs.readFileSync(this.lockPath, 'utf8')), 0); } catch (probe) { alive = probe.code !== 'ESRCH'; }
      if (alive) throw new Error('这个存档目录已有终端游戏在运行；可用 --data-dir 指定另一个目录。');
      fs.unlinkSync(this.lockPath); this.lock = fs.openSync(this.lockPath, 'wx', 0o600);
    }
    fs.writeFileSync(this.lock, String(process.pid));
    this.relayServer = http.createServer((req, res) => this.relay(req, res).catch(() => res.destroy()));
    this.relayServer.listen(0, '127.0.0.1');
    await once(this.relayServer, 'listening');
    this.relayURL = 'http://127.0.0.1:' + this.relayServer.address().port;
    const args = ['--headless', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-background-networking', '--autoplay-policy=user-gesture-required', '--user-data-dir=' + path.join(this.dataDir, 'profile')];
    if (this.noSandbox || process.platform === 'linux' && process.getuid() === 0) args.push('--no-sandbox');
    this.child = spawn(this.executable, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.on('data', chunk => { this.diagnostics = (this.diagnostics + chunk).slice(-4000); });
    this.child.stdio[4].on('data', chunk => this.receive(chunk));
    const fail = error => {
      this.closed = true;
      for (const controller of this.network.values()) controller.abort();
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    this.child.on('error', fail);
    this.child.on('exit', code => fail(new Error('后台引擎退出（' + code + '）：' + this.diagnostics)));
    await this.send('Browser.getVersion', {}, undefined, 20000);
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    this.session = (await this.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.send('Fetch.enable', { patterns: [{ urlPattern: ORIGIN + '/*' }, { urlPattern: 'https://*/*' }, { urlPattern: 'http://127.0.0.1:*/*' }, { urlPattern: 'http://localhost:*/*' }] });
    await this.send('Page.navigate', { url: ORIGIN + '/' });
    await this.ready("document.readyState==='complete' && typeof P==='object' && typeof startGame==='function' && typeof fullLoadGame==='function' && window.TMPhase8FormalBridge && TMPhase8FormalBridge.drafts && typeof TMPhase8FormalBridge.drafts.getFormalEdictDraftSnapshot==='function' && window.TM_SaveDB && TM_SaveDB.isAvailable()", 90000);
    await this.evaluate("typeof _tmAwaitLoadBarrier==='function' ? _tmAwaitLoadBarrier() : true");
    await this.evaluate('TMOfficialScenarioLoader.ready()');
    await this.evaluate(await fs.promises.readFile(path.join(__dirname, 'renderer.js'), 'utf8'));
    return this;
  }

  async evaluate(expression, timeout = 60000) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, this.session, timeout);
    if (result.exceptionDetails) {
      const error = result.exceptionDetails.exception;
      throw new Error((error && error.description || result.exceptionDetails.text).split('\n')[0].replace(/^Error: /, ''));
    }
    return result.result.value;
  }

  call(action, args = {}) {
    return this.evaluate('TMTerminal.call(' + JSON.stringify(action) + ',' + JSON.stringify(args) + ')', 30 * 60 * 1000);
  }

  async ready(expression, timeout = 30000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (this.closed) throw new Error('后台引擎启动失败：' + this.diagnostics);
      try { if (await this.evaluate(expression, 3000)) return; } catch (_) {}
      await delay(100);
    }
    throw new Error('后台游戏加载超时');
  }

  async answerDialog(accept, text) {
    if (!this.dialog) throw new Error('当前没有待答复的提示');
    await this.send('Page.handleJavaScriptDialog', { accept, promptText: text });
    this.dialog = null;
  }

  async close() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      const exited = once(this.child, 'exit').catch(() => {});
      try { await this.send('Browser.close', {}, undefined, 3000); } catch (_) {}
      await Promise.race([exited, delay(3000)]);
      if (this.child.exitCode === null && this.child.signalCode === null) { this.child.kill('SIGKILL'); await exited; }
    }
    this.closed = true;
    for (const entry of this.relayRequests.values()) entry.controller.abort();
    if (this.relayServer) {
      this.relayServer.closeAllConnections();
      await new Promise(resolve => this.relayServer.close(resolve));
      this.relayServer = undefined;
    }
    if (this.lock !== undefined) { fs.closeSync(this.lock); fs.unlinkSync(this.lockPath); this.lock = undefined; }
  }
}

module.exports = { Browser, findBrowser };
