// Injected only by the terminal launcher, after the production runtime is ready.
// Mutations use game owners; the terminal never supplies its own simulation.
(function () {
  'use strict';
  var notices = [], choices = [], closingJobs = new Set();
  var originalToast = window.toast;
  window.toast = function (message) {
    notices.push(plain(message));
    if (notices.length > 30) notices.shift();
    return originalToast.apply(this, arguments);
  };
  // The GUI closes instantly while commitment extraction continues. A terminal
  // save/exit must await that same work before freezing the snapshot.
  var extract = window._wd_extractCommitments;
  window._wd_extractCommitments = function () {
    var job = Promise.resolve(extract.apply(this, arguments));
    closingJobs.add(job);
    job.finally(function () { closingJobs.delete(job); }).catch(function () {});
    return job;
  };

  function plain(value) {
    var template = document.createElement('template');
    template.innerHTML = String(value == null ? '' : value).replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n');
    template.content.querySelectorAll('script,style').forEach(function (node) { node.remove(); });
    return (template.content.textContent || '').replace(/\n[ \t]*\n[ \t]*\n/g, '\n\n').trim();
  }
  function running() { if (!GM.running) throw Error('请先用 game start <scenario> 或 save load 进入游戏。'); }
  function writable() {
    if (GM.busy || GM._endTurnBusy || endTurn._preSubmitInFlight || window._wenduiSending) throw Error('游戏正在处理上一项操作，请稍候。');
  }
  function needAI() {
    if (!(P.ai && P.ai.key && P.ai.url && P.ai.model)) throw Error('请先用 config set 配置 AI 地址、模型和密钥，才能对话或推演回合。');
  }
  function draftBridge() {
    if (!window.TMPhase8FormalBridge || !TMPhase8FormalBridge.drafts) throw Error('诏令模块尚未就绪。');
    return TMPhase8FormalBridge.drafts;
  }
  function resolve(rows, query) {
    query = String(query || '').trim();
    if (/^[1-9]\d*$/.test(query)) {
      var item = rows[Number(query) - 1];
      if (!item) throw Error('编号不存在，请重新查看列表。');
      return item;
    }
    var exact = rows.filter(function (row) { return row.id === query || row.name === query; });
    var found = exact.length ? exact : rows.filter(function (row) { return query && String(row.name || '').includes(query); });
    if (found.length !== 1) throw Error(found.length ? '名称不唯一，请使用完整名称或编号。' : '未找到，请先查看列表。');
    return found[0];
  }
  function status() {
    if (!GM.running) return { running: false, ai: !!(P.ai && P.ai.key) };
    var scenario = findScenarioById(GM.sid), info = GM.playerInfo || P.playerInfo || {};
    return {
      running: true, scenario: scenario && scenario.name || GM.sid, turn: GM.turn,
      date: typeof getTSText === 'function' ? getTSText(GM.turn) : GM.date || '',
      player: info.characterName || '', faction: info.factionName || '', target: GM.wenduiTarget,
      treasury: ['money','grain','cloth','turnIncome','turnExpense','annualIncome','annualExpense'].reduce(function (result, key) { if (GM.guoku && GM.guoku[key] !== undefined) result[key] = GM.guoku[key]; return result; }, {}), variables: Object.keys(GM.vars || {}).map(function (name) { var row = GM.vars[name]; return { name: name, value: row.value, unit: row.unit || '' }; }),
      drafts: draftBridge().getFormalEdictDraftSnapshot(), ai: !!(P.ai && P.ai.key)
    };
  }
  function offices() {
    var rows = [];
    function visit(nodes, parent) {
      (nodes || []).forEach(function (department) {
        var label = parent.concat(department.name || department.id || '机构');
        (department.positions || []).forEach(function (position) {
          var who = (GM.chars || []).find(function (c) { return position.holder && c.name === position.holder || position.holderId && c.id === position.holderId; });
          rows.push({ index: rows.length + 1, id: position.id || '', name: position.name || '', department: label.join(' / '), rank: position.rank || '', holder: who && who.name || position.holder || '', function: position.function || position.func || position.description || '' });
        });
        visit(department.subs || department.children, label);
      });
    }
    visit(GM.officeTree, []); return rows;
  }
  function resumeAudience() {
    if (!GM.wenduiTarget || document.getElementById('wd-modal-input')) return;
    var metadata = {};
    try { metadata = JSON.parse(localStorage.getItem('tm_terminal_audience') || '{}'); } catch (_) {}
    var target = GM.wenduiTarget;
    var mode = metadata.target === target && metadata.campaignId === GM._campaignId ? metadata.mode : 'formal';
    openWenduiModal(target, mode, null, { campaignId: GM._campaignId, timelineId: GM._timelineId, turn: GM.turn, target: target });
    if (!document.getElementById('wd-modal-input')) throw Error(notices.join('\n') || '保存的召见会话目前无法继续。');
  }
  function rememberAudience() {
    if (GM.wenduiTarget) localStorage.setItem('tm_terminal_audience', JSON.stringify({ target: GM.wenduiTarget, mode: _wenduiMode, campaignId: GM._campaignId, timelineId: GM._timelineId, turn: GM.turn }));
    else localStorage.removeItem('tm_terminal_audience');
  }
  async function save(slot, name) {
    running(); writable();
    await Promise.all(Array.from(closingJobs));
    if (!await SaveManager.saveToSlot(slot, name || '终端存档')) throw Error('存档未成功写入，请保留终端并重试。');
    return { slot: slot, turn: GM.turn };
  }
  function prompt() {
    choices = [];
    var layer = typeof _tmTopModalLayer === 'function' ? _tmTopModalLayer() : null;
    var root = layer && layer.node;
    if (!root) {
      var nodes = Array.from(document.querySelectorAll('.modal-bg.show,.tm-desk-overlay,#tm-opening'));
      root = nodes.filter(function (node) { return getComputedStyle(node).display !== 'none'; }).pop();
    }
    if (!root) return { text: '', choices: [] };
    choices = Array.from(root.querySelectorAll('button')).filter(function (node) {
      return !node.disabled && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    });
    return { text: plain(root.innerHTML), choices: choices.map(function (node) { return plain(node.textContent); }) };
  }
  async function call(action, args) {
    args = args || {}; notices = [];
    var result;
    if (!['status', 'scenarios', 'people', 'person', 'offices', 'office', 'audienceStatus', 'audienceHistory', 'memorials', 'history', 'saves', 'prompt', 'configStatus'].includes(action)) writable();
    if (action !== 'choose' && action !== 'prompt') choices = [];
    switch (action) {
      case 'scenarios':
        await TMOfficialScenarioLoader.ready();
        result = P.scenarios.map(function (row) { return { id: row.id, name: row.name, role: row.role }; }); break;
      case 'start': {
        var row = resolve(P.scenarios, args.query);
        await startGame(row.id);
        var opening = document.getElementById('tm-op-enter');
        if (opening) opening.click();
        if (!GM.running || GM.sid !== row.id) {
          result = { pending: true, prompt: prompt(), notices: notices.slice() }; break;
        }
        if (typeof _tmAwaitLoadBarrier === 'function') await _tmAwaitLoadBarrier();
        result = { status: status(), opening: plain(row.opening || row.background || row.desc || '') };
        await save(0, '终端自动存档'); break;
      }
      case 'status': result = status(); break;
      case 'restore': {
        var current = await TM_SaveDB.load('slot_0');
        var canonical = await TM_SaveDB.load('autosave');
        if (canonical && _isLoadableGameState(canonical.gameState)) {
          var latestGM = canonical.gameState.GM || canonical.gameState;
          var currentGM = current && current.gameState && (current.gameState.GM || current.gameState);
          if (!currentGM || latestGM._campaignId === currentGM._campaignId && latestGM._timelineId === currentGM._timelineId && Number(latestGM.turn) > Number(currentGM.turn)) current = canonical;
        }
        if (current && _isLoadableGameState(current.gameState)) {
          await fullLoadGame({ gameState: current.gameState }, { source: 'terminal-command-resume', preserveTimeline: true });
          resumeAudience();
        }
        result = status(); break;
      }
      case 'person': {
        running(); var person = resolve(GM.chars || [], args.query);
        result = { index: GM.chars.indexOf(person) + 1, name: person.name, age: person.age, alive: person.alive !== false && !person.dead, faction: person.faction || '', party: person.party || '', location: person.location || '', role: person.role || person.position || person.title || '', loyalty: person.loyalty, health: person.health, intelligence: person.intelligence, administration: person.administration, politics: person.politics, military: person.military, personality: person.personality || '', offices: offices().filter(function (row) { return row.holder === person.name; }), summonable: typeof _wdCanDirectAudience === 'function' && _wdCanDirectAudience(person) }; break;
      }
      case 'offices': case 'office':
        running(); result = offices();
        if (action === 'office') result = resolve(result, args.query);
        else if (args.query) result = result.filter(function (row) { return [row.name, row.department, row.rank, row.holder].join(' ').includes(args.query); });
        break;
      case 'audienceStatus':
        running(); result = { target: GM.wenduiTarget || null, mode: _wenduiMode, exchanges: GM.wenduiTarget ? (GM.wenduiHistory[GM.wenduiTarget] || []).length : 0 }; break;
      case 'audienceHistory': {
        running(); var target = args.query ? resolve(GM.chars || [], args.query).name : GM.wenduiTarget;
        if (!target) throw Error('请指定人物，或先召见一人。');
        result = { target: target, messages: (GM.wenduiHistory[target] || []).map(function (row) { return { role: row.role, content: plain(row.content), turn: row.turn }; }) }; break;
      }
      case 'people':
        running();
        result = (GM.chars || []).map(function (c, index) {
          return { index: index + 1, name: c.name, role: c.role || c.position || c.title || '', location: c.location || '', alive: c.alive !== false && !c.dead, summonable: typeof _wdCanDirectAudience === 'function' && _wdCanDirectAudience(c) };
        }).filter(function (c) { return !args.query || [c.name, c.role, c.location].join(' ').includes(args.query); }); break;
      case 'summon': {
        running(); var ch = resolve(GM.chars || [], args.query);
        var requestedMode = args.private ? 'private' : 'formal';
        if (GM.wenduiTarget && (GM.wenduiTarget !== ch.name || _wenduiMode !== requestedMode)) { closeWenduiModal(); await Promise.all(Array.from(closingJobs)); }
        if (GM.wenduiTarget === ch.name && _wenduiMode === requestedMode && document.getElementById('wd-modal-input')) {
          result = { target: ch.name, greeting: '当前正在与此人对话。' }; break;
        }
        openWenduiModal(ch.name, args.private ? 'private' : 'formal');
        if (GM.wenduiTarget !== ch.name || !document.getElementById('wd-modal-input')) throw Error(notices.join('\n') || '当前不能召见此人。');
        var bubbles = Array.from(document.querySelectorAll('#wd-modal-chat .wendui-npc-bubble'));
        result = { target: ch.name, greeting: bubbles.length ? plain(bubbles[bubbles.length - 1].innerHTML) : _wdGenerateGreeting(ch.name, ch) };
        await save(0, '终端自动存档'); break;
      }
      case 'say': {
        running(); needAI();
        resumeAudience();
        var input = document.getElementById('wd-modal-input'), target = GM.wenduiTarget;
        if (!target || !input) throw Error('请先用 audience open <person> 召见人物。');
        var before = (GM.wenduiHistory[target] || []).length;
        input.value = args.text; await sendWendui();
        var replies = (GM.wenduiHistory[target] || []).slice(before).filter(function (row) { return row.role === 'npc'; });
        if (!replies.length) throw Error(notices.join('\n') || '人物未返回回复，请检查 AI 配置。');
        result = { target: target, text: replies.map(function (row) { return plain(row.content); }).join('\n\n') };
        await save(0, '终端自动存档'); break;
      }
      case 'leave':
        running(); if (GM.wenduiTarget) closeWenduiModal();
        result = await save(0, '终端自动存档'); break;
      case 'edict': {
        running();
        var ids = { political: 'edict-pol', military: 'edict-mil', diplomatic: 'edict-dip', economic: 'edict-eco', other: 'edict-oth' };
        var id = ids[args.category || 'other']; if (!id) throw Error('诏令类别无效。');
        var bridge = draftBridge();
        var current = bridge.getFormalEdictDraftSnapshot()[args.category || 'other'];
        // Use the existing form capture owner with a terminal-owned input. The
        // graphical editor can show one category at a time; looking up its old
        // legacy textarea would lose drafts when the active category differs.
        var form = document.createElement('div'), input = document.createElement('textarea');
        input.id = id;
        input.value = (current ? current + '\n\n' : '') + args.text;
        form.appendChild(input);
        bridge.captureDeskOverlayState(form);
        result = bridge.getFormalEdictDraftSnapshot();
        if (!String(result[args.category || 'other']).includes(args.text)) throw Error('诏令草稿未被游戏接收。');
        await save(0, '终端自动存档'); break;
      }
      case 'clearEdicts':
        running(); draftBridge().clearFormalEdictDrafts();
        result = await save(0, '终端自动存档'); break;
      case 'next': {
        running(); needAI();
        if (GM.wenduiTarget) { closeWenduiModal(); await Promise.all(Array.from(closingJobs)); }
        var turn = GM.turn;
        // Same entry used by the GUI's “静候有司” choice, including transaction,
        // preflight, AI inference, ledger writeback and canonical save commit.
        await _endTurnInternal({ postTurnCourt: false });
        if (GM.busy || GM._endTurnCommitPending) throw Error('回合存档结果仍待核对，请保留进程；勿重复推演。');
        if (GM.turn <= turn) throw Error(notices.join('\n') || '回合未完成，请检查 AI 配置。');
        var history = (GM.shijiHistory || []).slice(-1)[0] || {};
        result = { status: status(), report: plain(history.shizhengji || history.zhengwen || history.shilu || history.html || '') };
        await save(0, '终端自动存档'); break;
      }
      case 'memorials':
        running(); result = (GM.memorials || []).map(function (m, index) { return { index: index + 1, title: m.title || m.type || '奏疏', from: m.from || '', content: plain(m.content), status: m.status, reply: m.reply || '' }; });
        if (args.query) { result = result[Number(args.query) - 1]; if (!result) throw Error('奏疏编号不存在。'); } break;
      case 'reply': {
        running(); var m = (GM.memorials || [])[args.index - 1]; if (!m) throw Error('奏疏编号不存在。');
        if (!['approved', 'rejected', 'annotated'].includes(args.decision)) throw Error('批复方式无效。');
        _stageMemorialDecision(m, args.decision, args.text || '');
        if (m.status !== args.decision) throw Error('游戏未接受此批复。');
        result = await save(0, '终端自动存档'); break;
      }
      case 'history':
        running(); result = (GM.shijiHistory || []).filter(function (row) { return !args.turn || Number(row.turn) === Number(args.turn); }).slice(-5).map(function (row) { return { turn: row.turn, text: plain(row.shizhengji || row.zhengwen || row.shilu || row.html || '') }; }); break;
      case 'saves': result = await TM_SaveDB.list(); break;
      case 'save': result = await save(args.slot, args.name); break;
      case 'load': {
        var id = args.id || 'slot_0', saved = await TM_SaveDB.load(id);
        if (!saved || !_isLoadableGameState(saved.gameState)) throw Error('存档不存在或无法读取：' + id);
        if (GM.wenduiTarget) { closeWenduiModal(); await Promise.all(Array.from(closingJobs)); }
        await fullLoadGame({ gameState: saved.gameState }, { source: 'terminal-' + id });
        resumeAudience();
        result = status(); await save(0, '终端自动存档'); break;
      }
      case 'export':
        running(); await Promise.all(Array.from(closingJobs));
        if (typeof _awaitPostTurnJobsForSave === 'function') await _awaitPostTurnJobsForSave();
        result = JSON.stringify(_buildSaveState({ format: 'project', detach: true })); break;
      case 'import':
        if (!args.data || !args.data.gameState || !_isLoadableGameState(args.data.gameState)) throw Error('文件不是有效的天命存档。');
        if (GM.wenduiTarget) { closeWenduiModal(); await Promise.all(Array.from(closingJobs)); }
        await fullLoadGame(args.data, { source: 'terminal-import' });
        resumeAudience();
        result = status(); await save(0, '终端自动存档'); break;
      case 'configure': {
        var config = Object.assign({}, P.ai || {}, args);
        if (!config.url || !config.model || !config.key) throw Error('地址、模型和密钥都需要填写。');
        var url = new URL(config.url); if (!['http:', 'https:'].includes(url.protocol)) throw Error('API 地址须为 http:// 或 https://。');
        localStorage.setItem('tm_api', JSON.stringify(config));
        _tmRehydrateAiFromDevice();
        result = { url: P.ai.url, model: P.ai.model, configured: !!P.ai.key }; break;
      }
      case 'configStatus': result = { url: P.ai && P.ai.url || '', model: P.ai && P.ai.model || '', configured: !!(P.ai && P.ai.key) }; break;
      case 'prompt': result = prompt(); break;
      case 'choose': {
        var button = choices[args.index - 1];
        if (!button || !button.isConnected || button.disabled) throw Error('选项已变化，请重新输入 prompt show。');
        choices = []; if (window.__tmTerminalClick) window.__tmTerminalClick(button); else button.click();
        result = prompt(); break;
      }
      default: throw Error('未知终端操作：' + action);
    }
    if (GM.running) rememberAudience();
    return { result: result, notices: notices.slice() };
  }
  window.TMTerminal = { call: call };
})();
