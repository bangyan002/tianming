'use strict';
const CATALOG = [
  ['scenario', '剧本', [['list', '', '列出可用剧本']]],
  ['game', '开局与国情', [['start', '<scenario>', '开始新局'], ['status', '', '查看当前国情与草稿']]],
  ['people', '人员名册', [['list', '[search]', '查人员姓名、所在地与状态'], ['show', '<person>', '查人物能力及现任官位']]],
  ['offices', '官位与任职', [['list', '[search]', '查机构、官位与任职者'], ['show', '<office>', '查看官位品秩与职掌']]],
  ['audience', '召见与对话', [['open', '<person> [--private]', '召见人物，可选私下叙谈'], ['say', '"<message>"', '向当前召见人物说话'], ['status', '', '查看当前召见人物'], ['history', '[person]', '查看对话记录'], ['close', '', '结束当前召见']]],
  ['edict', '诏令草稿', [['add', '[political|military|diplomatic|economic|other] "<text>"', '添加诏令，过回合提交'], ['list', '', '查看草稿'], ['clear', '', '清空待提交草稿']]],
  ['memorial', '奏疏与批复', [['list', '', '查看奏疏列表'], ['show', '<number>', '阅读奏疏'], ['reply', '<number> approve|reject|comment [text]', '准奏、驳回或批示']]],
  ['turn', '回合推演', [['next', '', '提交诏令、批复并推进回合']]],
  ['history', '史记', [['show', '[turn]', '查最近五回合或指定回合']]],
  ['save', '存档', [['list', '', '查看存档列表'], ['write', '[1-9] [name]', '保存手动档'], ['load', '[0-9|autosave|pre_endturn]', '恢复存档，默认 0 为终端自动档'], ['export', '<file.json>', '导出游戏 JSON'], ['import', '<file.json>', '导入游戏 JSON']]],
  ['config', 'AI 配置', [['set', '[url model]', '设置地址、模型和密钥'], ['show', '', '查看配置状态']]],
  ['prompt', '交互会话内的提示', [['show', '', '读取当前弹窗'], ['choose', '<number>', '选择当前提示中的按钮']]]
].map(([group, description, entries]) => ({ group, description, commands: entries.map(([verb, args, text]) => ({ verb, usage: group + ' ' + verb + (args ? ' ' + args : ''), description: text })) }));
const GROUPS = Object.fromEntries(CATALOG.map(item => [item.group, item.group]));
Object.assign(GROUPS, { scenarios: 'scenario', person: 'people', office: 'offices' });

function getCatalog(group, compact = false) {
  if (!group) return compact ? CATALOG.map(item => ({ group: item.group, description: item.description })) : CATALOG;
  const name = GROUPS[group], entry = CATALOG.find(item => item.group === name);
  if (!entry) throw Error('未知命令组：' + group + '。输入 list 查看命令组。');
  return entry;
}
function tokenize(line) {
  const words = []; let word = '', quote = null, started = false;
  line = line.trim();
  for (let i = 0; i < line.length; i++) {
    const character = line[i], next = line[i + 1];
    if (quote) {
      if (character === quote) quote = null;
      else if (character === '\\' && quote === '"' && (next === '"' || next === '\\')) word += line[++i];
      else word += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; }
    else if (character === '\\' && next && /[\s"'\\]/.test(next)) { word += line[++i]; started = true; }
    else if (/\s/.test(character)) { if (started) words.push(word); word = ''; started = false; }
    else { word += character; started = true; }
  }
  if (quote) throw Error('引号未完成，请补齐后重试。');
  if (started) words.push(word);
  return words;
}
function complete(line) {
  const parts = line.trimStart().split(/\s+/), groups = CATALOG.map(item => item.group);
  if (parts.length === 1) return [[...groups, 'list', 'commands', 'help', 'exit', 'quit'].filter(item => item.startsWith(parts[0])), line];
  const group = GROUPS[parts[0]], prefix = parts[1] || '';
  if (['help', 'list', 'commands'].includes(parts[0])) return [groups.filter(item => item.startsWith(prefix)).map(item => parts[0] + ' ' + item), line];
  const item = CATALOG.find(entry => entry.group === group);
  if (item && parts.length <= 2) return [[...item.commands.map(command => command.verb), 'help'].filter(verb => verb.startsWith(prefix)).map(verb => parts[0] + ' ' + verb), line];
  return [[], line];
}
const CATEGORIES = { political: 'political', politics: 'political', military: 'military', diplomatic: 'diplomatic', diplomacy: 'diplomatic', economic: 'economic', economy: 'economic', other: 'other' };
function parseCommand(argv) {
  if (!argv.length) return { action: 'help', args: {} };
  if (argv[0] === 'interactive') return { interactive: true };
  if (['exit', 'quit'].includes(argv[0])) return { action: 'quit', args: {} };
  if (['help', 'list', 'commands'].includes(argv[0])) {
    if (argv[1]) getCatalog(argv[1]);
    return { action: argv[0] === 'help' ? 'help' : 'catalog', args: { group: argv[1] } };
  }
  const group = GROUPS[argv[0]], verb = argv[1];
  if (group && (!verb || ['help', '--help', '-h'].includes(verb))) return { action: 'help', args: { group } };
  const parts = argv.slice(2), text = parts.join(' ');
  function command(action, args = {}) { return { action, args }; }
  function requireText() { if (!text) throw Error('请提供名称、编号或内容。'); return text; }
  function number(value, fallback, max = Infinity) {
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || Number(value) > max) throw Error('编号须为 1 到 ' + (max === Infinity ? '相应列表的最大编号' : max));
    return Number(value);
  }
  switch (group + ':' + verb) {
    case 'scenario:list': return command('scenarios');
    case 'game:start': return command('start', { query: requireText() });
    case 'game:status': return command('status');
    case 'people:list': return command('people', { query: text });
    case 'people:show': return command('person', { query: requireText() });
    case 'offices:list': return command('offices', { query: text });
    case 'offices:show': return command('office', { query: requireText() });
    case 'audience:open': {
      const privateMode = parts.includes('--private');
      const query = parts.filter(part => part !== '--private').join(' ');
      if (!query) throw Error('请指定要召见的人物。');
      return command('summon', { query, private: privateMode });
    }
    case 'audience:say': return command('say', { text: requireText() });
    case 'audience:close': return command('leave');
    case 'audience:status': return command('audienceStatus');
    case 'audience:history': return command('audienceHistory', { query: text });
    case 'edict:list': return command('drafts');
    case 'edict:clear': return command('clearEdicts');
    case 'edict:add': {
      requireText();
      const category = CATEGORIES[parts[0]] || 'other';
      const content = CATEGORIES[parts[0]] ? parts.slice(1).join(' ') : text;
      if (!content) throw Error('请提供诏令内容。');
      return command('edict', { category, text: content });
    }
    case 'memorial:list': return command('memorials');
    case 'memorial:show': return command('memorials', { query: String(number(parts[0] || '')) });
    case 'memorial:reply': {
      const index = number(parts[0] || '');
      const decision = { approve: 'approved', reject: 'rejected', comment: 'annotated' }[parts[1]];
      const content = parts.slice(2).join(' ');
      if (!decision || decision === 'annotated' && !content) throw Error('用法：memorial reply 编号 approve|reject|comment [批复内容]');
      return command('reply', { index, decision, text: content });
    }
    case 'turn:next': return command('next');
    case 'history:show': return command('history', { turn: number(parts[0], undefined) });
    case 'save:list': return command('saves');
    case 'save:write': return command('save', { slot: number(parts[0], 1, 9), name: parts.slice(1).join(' ') || '终端手动存档' });
    case 'save:load': {
      const id = parts[0] || '0';
      if (!/^[0-9]$|^autosave$|^pre_endturn$/.test(id)) throw Error('用法：save load [0-9|autosave|pre_endturn]');
      return command('load', { id: /^\d$/.test(id) ? 'slot_' + id : id });
    }
    case 'save:export': return command('export', { file: requireText() });
    case 'save:import': return command('import', { file: requireText() });
    case 'config:show': return command('configStatus');
    case 'config:set':
      if (parts.length && parts.length !== 2) throw Error('用法：config set [API地址 模型]，密钥单独输入或使用 TM_API_KEY。');
      return command('configure', { url: parts[0], model: parts[1] });
    case 'prompt:show': return command('prompt');
    case 'prompt:choose': return command('choose', { index: number(parts[0] || '') });
  }
  throw Error('未知子命令；输入 list、help 或 <group> help 查看用法。');
}
module.exports = { parseCommand, getCatalog, tokenize, complete };
