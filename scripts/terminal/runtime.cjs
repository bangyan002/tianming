'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');

class Runtime {
  constructor(options = {}) {
    this.root = options.root || path.resolve(__dirname, '../..');
    this.dataDir = path.resolve(options.dataDir || path.join(os.homedir(), '.tianming-terminal'));
    this.pending = new Map(); this.sequence = 0; this.closed = false;
  }
  request(action, payload = {}) {
    if (this.closed || this.workerStopped) return Promise.reject(Error('终端游戏引擎已关闭'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence; this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, action, ...payload });
    });
  }
  async start() {
    try { require.resolve('jsdom'); require.resolve('fake-indexeddb'); }
    catch (_) { throw Error('终端运行依赖尚未安装，请先运行 npm run setup:cli。'); }
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.lockPath = path.join(this.dataDir, 'terminal.lock');
    try { this.lock = fs.openSync(this.lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let alive = true;
      try { const pid = Number(fs.readFileSync(this.lockPath, 'utf8')); if (!Number.isInteger(pid) || pid <= 0) throw Error('存档目录锁文件不完整'); process.kill(pid, 0); }
      catch (probe) { alive = probe.code !== 'ESRCH'; }
      if (alive) throw Error('这个存档目录已有终端游戏在运行；可用 --data-dir 指定另一个目录。');
      fs.unlinkSync(this.lockPath); this.lock = fs.openSync(this.lockPath, 'wx', 0o600);
    }
    fs.writeFileSync(this.lock, String(process.pid));
    this.worker = new Worker(path.join(__dirname, 'engine-worker.cjs'), { workerData: { root: this.root, dataDir: this.dataDir }, resourceLimits: { maxOldGenerationSizeMb: 4096 } });
    const fail = error => { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); };
    this.worker.on('error', error => { this.workerStopped = true; fail(error); });
    this.worker.on('exit', code => { this.workerStopped = true; if (!this.closed) fail(Error('Node 运行时已退出：' + code)); });
    this.worker.on('message', message => {
      if (message.dialog) {
        this.dialog = message.dialog; this.dialogMemory = message.shared;
        if (this.onDialog) Promise.resolve(this.onDialog(message.dialog)).catch(() => this.answerDialog(false));
        else this.answerDialog(false);
        return;
      }
      if (message.log) { process.stderr.write(message.log + '\n'); return; }
      const item = this.pending.get(message.id); if (!item) return;
      this.pending.delete(message.id);
      if (message.error) item.reject(Object.assign(Error(message.error), { code: message.code, diagnostics: message.diagnostics })); else item.resolve(message.result);
    });
    await this.request('start'); return this;
  }
  evaluate(expression) { return this.request('evaluate', { expression }); }
  call(operation, args = {}) { return this.request('call', { operation, args }); }
  answerDialog(accept, text = '') {
    if (!this.dialogMemory) throw Error('当前没有待答复的提示');
    const bytes = Buffer.from(JSON.stringify({ accept, text }));
    if (bytes.length > this.dialogMemory.byteLength - 8) throw Error('答复内容过长');
    const view = new Int32Array(this.dialogMemory, 0, 2);
    new Uint8Array(this.dialogMemory, 8, bytes.length).set(bytes);
    Atomics.store(view, 1, bytes.length); Atomics.store(view, 0, 1); Atomics.notify(view, 0);
    this.dialog = undefined; this.dialogMemory = undefined;
  }
  async close() {
    try {
      if (this.worker) {
        if (this.dialogMemory) this.answerDialog(false);
        try { if (!this.workerStopped) await this.request('close'); } finally { this.closed = true; await this.worker.terminate(); }
      }
    } finally {
      this.closed = true;
      if (this.lock !== undefined) { fs.closeSync(this.lock); fs.unlinkSync(this.lockPath); this.lock = undefined; }
    }
  }
}
module.exports = { Runtime };
