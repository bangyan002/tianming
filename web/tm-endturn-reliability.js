// Shared turn diagnostics and request ownership. No world mutation or API credentials are stored.
(function(root) {
  'use strict';
  var TM = root.TM = root.TM || {};
  TM.Endturn = TM.Endturn || {};
  if (TM.Endturn.Reliability) return;
  var active = null, history = [], sequence = 0, contexts = new WeakMap(), progressTimer = null;
  function error(code, message) { var e = new Error(message); e.code = code; return e; }
  function selectedMode(p) {
    var contract = TM.Endturn.ModeContract;
    return contract ? contract.selectedMode(p) : (typeof root.agentModeOn === 'function' && root.agentModeOn() ? 'agent' : 'llm');
  }
  function preflight(p) {
    p = p || root.P || {};
    var missing = [], mode = selectedMode(p);
    function need(name, value) { if (typeof value !== 'function') missing.push(name); }
    need('Pipeline.run', TM.Endturn.Pipeline && TM.Endturn.Pipeline.run);
    need('Pipeline.buildCtx', TM.Endturn.Pipeline && TM.Endturn.Pipeline.buildCtx);
    need('_buildSaveState', root._buildSaveState);
    if (p.ai && p.ai.key) {
      need('_aiFetchWithRetry', root._aiFetchWithRetry); need('_aiComputeTimeout', root._aiComputeTimeout);
      need('_aiErrorIsTerminal', root._aiErrorIsTerminal); need('_tmAIFetch', root._tmAIFetch);
      if (mode === 'agent') {
        need('AgentMode.run', TM.Endturn.AgentMode && TM.Endturn.AgentMode.run);
        need('AgentIntentPlan.commitSpecialistProposal', TM.Endturn.AgentIntentPlan && TM.Endturn.AgentIntentPlan.commitSpecialistProposal);
      } else need('_endTurn_aiInfer', root._endTurn_aiInfer);
    }
    return { ok: !missing.length, mode: mode, missing: missing };
  }
  function classify(e) {
    var code = String(e && e.code || ''), status = Number(e && (e.status || e.statusCode)) || 0;
    if (code === 'TURN_DEPENDENCY_MISSING') return 'dependency';
    if (code === 'AI_ABORTED' || e && e.name === 'AbortError') return 'cancelled';
    if (/STALE|world_changed|load_changed/i.test(code)) return 'world_changed';
    if (/TIMEOUT|DEADLINE/.test(code) || e && e.name === 'TimeoutError') return 'timeout';
    if (status === 401 || status === 403) return 'authentication';
    if (status === 429) return 'rate_limit';
    if (status >= 500) return 'provider';
    if (/context|budget/i.test(code)) return 'context_budget';
    if (code === 'sc1-result-unavailable' || /parse|json|schema/i.test(code) || e && e.name === 'SyntaxError') return 'output_format';
    if (/save|persist|quota|storage/i.test(code)) return 'persistence';
    if (e && (e.writebackFailures || e.validity)) return 'world_validation';
    if (/^AI_MOBILE_/.test(code)) return 'mobile_transport';
    return status >= 400 ? 'request_rejected' : 'runtime';
  }
  var phases = { queue: '排队', request: '等待接口首响应', 'native-buffered': '等待接口返回完整结果', body: '读取完整结果', 'error-body': '读取接口错误', retry: '等待重试' };
  function clean(value, limit) {
    var text = String(value == null ? '' : value), p = root.P || {};
    [p.ai, p.aiSecondary, p.secondaryAI, p.ai && p.ai.secondary].forEach(function(cfg) {
      if (cfg && cfg.key) text = text.split(String(cfg.key)).join('[密钥已隐藏]');
    });
    return text.replace(/Bearer\s+[^\s"']+|\bsk-[\w-]+/gi, '[密钥已隐藏]').slice(0, limit || 1600);
  }
  function describeError(e, context) {
    context = Object.assign({}, e && typeof e === 'object' && contexts.get(e) || {}, context || {});
    var category = classify(e), code = clean(e && (e.code || e.name), 80), status = Number(e && (e.status || e.statusCode)) || 0;
    var report = { category: category, code: code, status: status, stage: clean(context.stage, 160), subcall: clean(context.subcall, 80), phase: clean(context.phase, 80), details: [] };
    var canonical = { dependency: '回合所需组件未加载', cancelled: '请求已取消', world_changed: '存档、分支或接口配置已改变，原请求结果不能写入当前回合', authentication: '接口鉴权失败，请检查对应接口密钥或权限', rate_limit: '服务商限制请求频率', provider: '服务商返回错误', context_budget: '上下文长度、调用次数或重试预算已达到限制', mobile_transport: '手机接口传输失败', request_rejected: '接口拒绝了请求' };
    if (category === 'timeout') report.message = (phases[e && e.phase] || (code === 'AI_QUEUE_TIMEOUT' ? phases.queue : '等待接口结果')) + '超时' + (e && e.timeoutMs ? '（期限 ' + Math.round(e.timeoutMs / 1000) + ' 秒）' : '');
    else if (status || canonical[category]) report.message = (canonical[category] || '接口请求失败') + (status ? '（HTTP ' + status + '）' : '');
    else report.message = clean(e && e.message || e || '未知错误');
    if (e && Array.isArray(e.writebackFailures)) e.writebackFailures.slice(0, 40).forEach(function(f) {
      var field = clean(f.field, 100) + (f.index != null ? '[' + f.index + ']' : ''), target = clean(f.target, 160), reason = clean(f.reason || f.code);
      report.details.push({ field: field, target: target, code: clean(f.code, 80), message: field + (target ? ' · 对象「' + target + '」' : '') + '：' + reason });
    });
    if (e && e.validity && Array.isArray(e.validity.reasons)) e.validity.reasons.slice(0, 40).forEach(function(reason) { report.details.push({ message: clean(reason) }); });
    if (e && Array.isArray(e.missing)) report.details.push({ message: '缺少组件：' + e.missing.map(function(name) { return clean(name, 100); }).join('、') });
    if (/主推演未形成完整结构化结果/.test(String(e && e.message || ''))) {
      var sc1 = TM.RecoveryRuntime && TM.RecoveryRuntime.sc1Failure && TM.RecoveryRuntime.sc1Failure();
      if (sc1) { report.message = clean(sc1.detail); (sc1.issues || []).forEach(function(issue) { report.details.push({ code: clean(issue.code, 80), message: clean(issue.message) }); }); }
    }
    return report;
  }
  function noteFailure(e, context) {
    if (e && typeof e === 'object') contexts.set(e, Object.assign({}, contexts.get(e) || {}, context || {}));
    var report = describeError(e);
    if (active && active.status === 'running') {
      var rows = active.errors, key = [report.subcall, report.stage, report.phase, report.code, report.message].join('|');
      if (!rows.some(function(row) { return row.key === key; })) rows.push({ key: key, at: Date.now(), error: report });
      if (rows.length > 60) rows.shift();
    }
    return report;
  }
  function closePhase(row, now) {
    row.phaseMs[row.phase] = (row.phaseMs[row.phase] || 0) + Math.max(0, now - row.phaseAt); row.phaseAt = now;
  }
  function requestRetry(ticket, e, delayMs) {
    if (!ticket || ticket.owner.status !== 'running') return;
    var row = ticket.row; row.retryErrors.push({ attempt: row.attempts, delayMs: Math.max(0, Number(delayMs) || 0), error: describeError(e, { subcall: row.id, phase: row.phase }) });
    if (row.retryErrors.length > 20) row.retryErrors.shift(); requestPhase(ticket, 'retry');
  }
  function live() {
    if (!active || active.status !== 'running') return null;
    var record = JSON.parse(JSON.stringify({ id: active.id, turn: active.turn, mode: active.mode, startedAt: active.startedAt, status: active.status, stages: active.stages, requests: active.requests, errors: active.errors })), now = Date.now();
    record.ms = now - active.startedAt;
    record.requests.forEach(function(row) { if (row.ok == null) { closePhase(row, now); row.ms = now - row.at; } });
    return record;
  }
  function duration(ms) { var s = Math.max(0, Math.floor(ms / 1000)); return s >= 60 ? Math.floor(s / 60) + ' 分 ' + s % 60 + ' 秒' : s + ' 秒'; }
  function stopProgress() { if (progressTimer != null) { root.clearInterval(progressTimer); progressTimer = null; } }
  function openDetails() { var timing = TM.Endturn.Timing; if (timing && timing.openDiagnostics) timing.openDiagnostics(); }
  function updateProgress() {
    if (!root.document) return;
    var scope = live(), sub = root.document.getElementById('loading-sub'); if (!scope || !sub || !sub.parentNode) return;
    var panel = root.document.getElementById('tm-turn-wait-details');
    if (!panel) {
      panel = root.document.createElement('details'); panel.id = 'tm-turn-wait-details'; panel.open = true; panel.style.cssText = 'font-size:var(--text-xs);line-height:1.6;margin-top:12px;max-height:28vh;overflow:auto;text-align:left';
      panel.appendChild(root.document.createElement('summary')); panel.appendChild(root.document.createElement('div'));
      var button = root.document.createElement('button'); button.className = 'bt bs'; button.textContent = '查看具体原因与耗时'; button.onclick = openDetails; panel.appendChild(button); sub.parentNode.appendChild(panel);
    }
    var pending = scope.requests.filter(function(row) { return row.ok == null; });
    panel.firstChild.textContent = '已耗时 ' + duration(scope.ms) + (pending.length ? ' · ' + pending.length + ' 个调用正在等待' : ' · 正在处理回合');
    var lines = pending.map(function(row) { return (row.label ? row.label + '（' + row.id + '）' : row.id) + ' · 第 ' + Math.max(1, row.attempts) + ' 次 · ' + (phases[row.phase] || row.phase) + ' ' + duration(row.phaseMs[row.phase] || 0) + '（累计 ' + duration(row.ms) + '）'; });
    if (!pending.length && scope.stages.length) lines.push('阶段：' + scope.stages[scope.stages.length - 1].stage);
    var recoveries = TM.EmergencyRecovery && TM.EmergencyRecovery.status ? TM.EmergencyRecovery.status() : [];
    recoveries.filter(function(row) { return row.startedAt >= scope.startedAt; }).forEach(function(row) { lines.push('应急恢复 · ' + row.call + ' · 额外调用 ' + row.calls + ' 次 · ' + duration((row.endedAt || Date.now()) - row.startedAt) + (row.detail ? '\n' + clean(row.detail, 240) : '')); });
    if (scope.errors.length) lines.push('已记录 ' + scope.errors.length + ' 项异常，可查看具体原因。');
    panel.children[1].style.whiteSpace = 'pre-wrap'; panel.children[1].textContent = lines.join('\n');
  }
  function showFailure(e) {
    if (!root.document || !root.document.body) return;
    var old = root.document.getElementById('tm-turn-failure-details'); if (old) old.remove();
    var last = history[history.length - 1], report = last && last.failure || describeError(e), panel = root.document.createElement('details');
    panel.id = 'tm-turn-failure-details'; panel.open = true; panel.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:1005;max-width:min(560px,90vw);max-height:45vh;overflow:auto;padding:12px;background:var(--bg-1);color:var(--txt);border:1px solid var(--bdr);border-radius:8px;font-size:var(--text-sm);line-height:1.7;box-shadow:var(--shadow-lg)';
    var summary = root.document.createElement('summary'); summary.textContent = '回合处理异常' + (last ? ' · 耗时 ' + duration(last.ms) : '') + (report.stage ? ' · ' + report.stage : '') + (report.subcall ? ' · ' + report.subcall : ''); panel.appendChild(summary);
    var content = root.document.createElement('div'); content.style.whiteSpace = 'pre-wrap'; content.textContent = [report.message].concat(report.details.map(function(d) { return d.message; })).filter(function(s, i, a) { return a.indexOf(s) === i; }).join('\n'); panel.appendChild(content);
    var view = root.document.createElement('button'); view.className = 'bt bs'; view.textContent = '查看全部错误与耗时'; view.onclick = openDetails; panel.appendChild(view);
    var dismiss = root.document.createElement('button'); dismiss.className = 'bt bs'; dismiss.textContent = '关闭提示'; dismiss.onclick = function() { panel.remove(); }; panel.appendChild(dismiss); root.document.body.appendChild(panel);
  }
  function begin() {
    var gm = root.GM, p = root.P, generation = root._tmLoadGen;
    var identity = [gm && gm._campaignId, gm && gm._timelineId].join('|');
    var scope = { id: 'turn-' + Date.now().toString(36) + '-' + (++sequence), mode: selectedMode(p), turn: gm && gm.turn, startedAt: Date.now(), status: 'running', requests: [], stages: [], errors: [] };
    scope.current = function() { return root.GM === gm && root.P === p && root._tmLoadGen === generation && identity === [gm && gm._campaignId, gm && gm._timelineId].join('|'); };
    scope.controllers = new Set();
    active = scope; stopProgress();
    if (root.document && typeof root.setInterval === 'function') { updateProgress(); progressTimer = root.setInterval(updateProgress, 1000); }
    return scope;
  }
  function requestStart(label) {
    var scope = active;
    if (!scope || scope.status !== 'running' || !scope.current()) return null;
    var row = { id: clean(label || 'request', 80).replace(/[^a-zA-Z0-9_:-]/g, '').slice(0, 80), at: Date.now(), phaseAt: Date.now(), phase: 'queue', phaseMs: {}, retryErrors: [], attempts: 0 };
    if (TM.CallRetryPolicy && TM.CallRetryPolicy.catalog) { var match = TM.CallRetryPolicy.catalog().find(function(call) { return call.id === row.id || call.id === row.id.split(':')[0]; }); if (match) row.label = match.label; }
    scope.requests.push(row); if (scope.requests.length > 160) scope.requests.shift();
    return { row: row, owner: scope };
  }
  function bindRequest(ticket, ctrl) { if (ticket && ticket.owner.status === "running") ticket.owner.controllers.add(ctrl); }
  function unbindRequest(ticket, ctrl) { if (ticket) ticket.owner.controllers.delete(ctrl); }
  function requestPhase(ticket, phase) {
    if (!ticket || ticket.owner.status !== 'running') return;
    var row = ticket.row, now = Date.now(); closePhase(row, now); row.phase = phase;
    if (phase === 'request' || phase === 'native-buffered') { if (row.queueMs == null) row.queueMs = now - row.at; row.attempts++; }
    if (phase === 'body') row.headersAt = now;
  }
  function requestEnd(ticket, e) {
    if (!ticket || ticket.row.ok != null) return;
    var row = ticket.row, now = Date.now(); closePhase(row, now); row.ms = now - row.at; row.ok = !e;
    if (e) { row.error = noteFailure(e, { subcall: row.id, phase: row.phase }); row.category = row.error.category; row.code = row.error.code; row.status = row.error.status; }
  }
  function mark(scope, stage) {
    if (scope && scope.status === 'running') scope.stages.push({ stage: stage, at: Date.now(), ms: Date.now() - scope.startedAt });
  }
  function finish(scope, status, e) {
    if (!scope || scope.status !== 'running') return;
    if (e) noteFailure(e);
    scope.status = status; scope.ms = Date.now() - scope.startedAt;
    if (status === 'failed') {
      scope.controllers.forEach(function(ctrl) { if (!ctrl.signal.aborted) { var stopped = error('AI_ABORTED', '本回合已失败，其余请求已停止等待'); ctrl.abort(stopped); } });
      scope.requests.forEach(function(row) { if (row.ok == null) { row.ok = false; row.category = 'cancelled'; row.code = 'TURN_FAILED_CANCELLED'; row.ms = Date.now() - row.at; closePhase(row, Date.now()); } });
    }
    scope.controllers.clear();
    var record = { id: scope.id, turn: scope.turn, mode: scope.mode, startedAt: scope.startedAt, ms: scope.ms, status: status, stages: scope.stages, requests: scope.requests, errors: scope.errors };
    if (e) record.failure = describeError(e);
    history.push(JSON.parse(JSON.stringify(record))); if (history.length > 12) history.shift();
    if (active === scope) { active = null; stopProgress(); }
  }
  // An invoke timeout ends local waiting, never cancels a main-process disk operation.
  var bridgeFlights = new WeakMap(), bridgeEvents = [], bridgePending = 0;
  var BRIDGE_WAIT_MS = 60000, BRIDGE_MAX_PENDING = 32;
  function bridgeError(code, message, uncertain) {
    var e = error(code, message); e.outcome = uncertain ? 'unconfirmed' : 'not-sent'; return e;
  }
  function bridgeRecord(method, state, e, started) {
    bridgeEvents.push({ method: method, state: state, code: String(e && e.code || '').slice(0, 80), ms: Date.now() - started, at: Date.now() });
    if (bridgeEvents.length > 12) bridgeEvents.shift();
  }
  function callTurnBridge(method, payload, opts) {
    opts = opts || {};
    return new Promise(function(resolve, reject) {
      var bridge = root.tianming;
      var allowed = ['stageTurnData','publishTurnData','recoverTurnData','discardTurnData','listSaveTimelineRefs'];
      if (allowed.indexOf(method) < 0 || !bridge || typeof bridge[method] !== 'function') {
        reject(bridgeError('TURN_BRIDGE_UNAVAILABLE', '桌面分卷接口未就绪', false)); return;
      }
      if (method !== 'listSaveTimelineRefs' && bridge.turnDataProtocolVersion !== 2) { reject(bridgeError('TURN_BRIDGE_PROTOCOL', '分卷时间线协议不匹配，未发送桌面操作', false)); return; }
      var key, expected = {};
      if (payload) ['transactionId','campaignId','timelineId','turn','stateChecksum'].forEach(function(k) { expected[k] = payload[k]; });
      if (method === 'listSaveTimelineRefs') key = 'timeline-refs';
      else {
        if (!payload || !['campaignId','timelineId','transactionId'].every(function(k) { return typeof payload[k] === 'string' && payload[k].length > 0 && payload[k].length <= 160; })) {
          reject(bridgeError('TURN_BRIDGE_IDENTITY', '分卷事务身份缺失，未发送桌面写入', false)); return;
        }
        key = JSON.stringify([payload.campaignId, payload.timelineId, payload.transactionId]);
      }
      var table = bridgeFlights.get(bridge);
      if (!table) { table = new Map(); bridgeFlights.set(bridge, table); }
      if (table.has(key)) { reject(bridgeError('TURN_BRIDGE_PENDING', '同一分卷事务仍等待桌面回执，未重复发送', true)); return; }
      if (bridgePending >= BRIDGE_MAX_PENDING) { reject(bridgeError('TURN_BRIDGE_BUSY', '桌面未确认请求过多，请核对后重新打开游戏', true)); return; }
      var signal = opts.signal, protocol = bridge.turnDataProtocolVersion, token = {}, started = Date.now(), timer, done = false, ticket;
      function current() { return root.tianming === bridge && bridge.turnDataProtocolVersion === protocol && (!opts.isCurrent || opts.isCurrent() === true); }
      function cleanup() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', cancelled); }
      function stop(e) {
        if (done) return; done = true; cleanup(); bridgeRecord(method, 'waiting-ended', e, started);
        requestEnd(ticket, e); reject(e);
      }
      function cancelled() { stop(bridgeError('TURN_BRIDGE_ABORTED', '已停止等待桌面分卷回执；未宣称远端操作已取消', true)); }
      function settle(e, value) {
        if (table.get(key) === token) { table.delete(key); bridgePending--; }
        if (done) { bridgeRecord(method, e ? 'late-rejection' : 'late-response', null, started); return; }
        try { if (!current()) e = bridgeError('TURN_BRIDGE_STALE', '分卷回执对应的世界或桌面连接已改变', true); } catch (guardError) { e = guardError; }
        if (!e && value && value.success === true && method !== 'listSaveTimelineRefs') {
          var mismatch = Object.keys(expected).some(function(k) { return value[k] != null && String(value[k]) !== String(expected[k]); });
          if (mismatch) e = bridgeError('TURN_BRIDGE_IDENTITY', '桌面分卷回执身份不匹配，保留恢复信息', true);
        }
        done = true; cleanup(); bridgeRecord(method, e ? 'failed' : 'responded', e, started);
        requestEnd(ticket, e || (value && value.success === false ? error('TURN_BRIDGE_REJECTED', '桌面返回失败') : null));
        if (e) reject(e); else resolve(value);
      }
      try {
        if (signal && signal.aborted) { reject(bridgeError('TURN_BRIDGE_ABORTED', '操作已取消，未发送桌面请求', false)); return; }
        if (!current()) { reject(bridgeError('TURN_BRIDGE_STALE', '世界已改变，未发送旧分卷请求', false)); return; }
        table.set(key, token); bridgePending++;
        ticket = requestStart('bridge:' + method); requestPhase(ticket, 'request');
        timer = setTimeout(function() { stop(bridgeError('TURN_BRIDGE_TIMEOUT', '桌面分卷等待超时；远端结果未确认，恢复凭据保持不变', true)); }, BRIDGE_WAIT_MS);
        if (signal) signal.addEventListener('abort', cancelled, { once: true });
        var response = method === 'listSaveTimelineRefs' ? bridge[method]() : bridge[method](payload);
        Promise.resolve(response).then(function(value) { settle(null, value); }, function(e) { settle(e); });
      } catch (e) { settle(e); }
    });
  }
  function bridgeDiagnostics() { return { pending: bridgePending, limit: BRIDGE_MAX_PENDING, waitMs: BRIDGE_WAIT_MS, events: JSON.parse(JSON.stringify(bridgeEvents)) }; }

  function snapshot() { return JSON.parse(JSON.stringify(history)); }
  TM.Endturn.Reliability = { preflight: preflight, classify: classify, begin: begin, mark: mark, finish: finish, requestStart: requestStart, requestPhase: requestPhase, requestEnd: requestEnd, bindRequest: bindRequest, unbindRequest: unbindRequest, snapshot: snapshot, live: live, noteFailure: noteFailure, describeError: describeError, requestRetry: requestRetry, phaseLabel: function(phase) { return phases[phase] || phase; }, showFailure: showFailure,
    callTurnBridge: callTurnBridge, bridgeDiagnostics: bridgeDiagnostics,
    assertReady: function(p) { var result = preflight(p); if (!result.ok) { var e = error('TURN_DEPENDENCY_MISSING', '过回合依赖未加载：' + result.missing.join('、') + '。未发送 AI 请求。'); e.missing = result.missing; throw e; } return result; } };
})(typeof window !== 'undefined' ? window : globalThis);
