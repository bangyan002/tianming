#!/usr/bin/env node
'use strict';

// Compile the handlers as read from HTML, then exercise expansion and appointment paths.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const container = { innerHTML: '', addEventListener() {} };
const context = {
  console: { log() {}, warn() {}, error(...args) { throw new Error(args.join(' ')); } },
  GM: { chars: [], facs: [], vars: {}, officeTree: [], turn: 1 },
  P: { engineConstants: {}, playerInfo: {} }, TM: {},
  localStorage: { getItem() { return null; }, setItem() {} },
  document: { readyState: 'loading', getElementById(id) { return id === 'office-tree' ? container : null; }, addEventListener() {} },
  EndTurnHooks: { register() {} }, setTimeout() { return 0; }, clearTimeout() {}
};
context.window = context;
context._$ = context.document.getElementById;
vm.createContext(context);
for (const file of ['tm-utils.js', 'tm-office-system.js', 'tm-office-editor.js', 'tm-office-runtime.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
}
context.getTSText = () => '第一回';
let opened;
context._offOpenPicker = (...args) => { opened = JSON.parse(JSON.stringify(args)); };
context.event = { stopPropagation() {}, target: { closest() { return null; } } };

function handler(html, className, index = 0) {
  // A raw double quote terminates the attribute before HTML entities are decoded.
  const re = new RegExp('<(?:button|div)\\b[^>]*\\bclass="(?:[^"]*\\s)?' + className + '(?=\\s|")[^"]*"[^>]*\\bonclick="([^"]*)"', 'g');
  const matches = [...html.matchAll(re)];
  assert(matches[index], 'Missing click handler for ' + className);
  return matches[index][1].replace(/&(amp|quot|lt|gt|#39);/g, (_, key) => ({ amp: '&', quot: '"', lt: '<', gt: '>', '#39': "'" })[key]);
}
function click(html, className, index) {
  vm.runInContext('(function(event){' + handler(html, className, index) + '\n}).call(null, event);', context);
}
function reset(tree, view = 'list') {
  context.GM = { chars: [], facs: [], vars: {}, officeTree: tree, turn: 1,
    _officeViewMode: view, _officeViewModeExplicit: true };
  context.renderOfficeTree(true);
}
const seat = { name: '大学士', holder: '', rank: '正五品' };
const cabinet = { name: '内阁', positions: [seat], subs: [] };

reset([cabinet]);
assert(!container.innerHTML.includes('ogp-panel open'), 'List must start with departments collapsed');
click(container.innerHTML, 'ogp-dept');
assert(container.innerHTML.includes('ogp-panel open'), 'Clicking the cabinet must show its positions');
click(container.innerHTML, 'ogp-pos-btn');
assert.deepStrictEqual(opened, [[0, 'positions', 0], '内阁', '大学士', ''], 'Appointment must retain the complete path');
context.setOfficeViewMode('tree');
assert(container.innerHTML.includes('og-v10-pos '), 'Switching to the tree must preserve expansion');
context.setOfficeViewMode('list');
assert(container.innerHTML.includes('ogp-panel open'), 'Switching back to the list must preserve expansion');
click(container.innerHTML, 'ogp-dept');
assert(!container.innerHTML.includes('ogp-panel open'), 'Clicking again must collapse the cabinet');

// Filtering out earlier departments must not renumber paths or expansion keys.
reset([{ name: '司礼监', positions: [], subs: [] }, cabinet]);
click(container.innerHTML, 'ogp-dept');
assert.strictEqual(context.GM._officeCollapsed['[1]'], false);
assert.strictEqual(context.GM._officeCollapsed['[0]'], true);
click(container.innerHTML, 'ogp-pos-btn');
assert.deepStrictEqual(opened[0], [1, 'positions', 0]);
context.setOfficeSubTab('shuji');
assert(!container.innerHTML.includes('ogp-panel open'), 'Changing category must initially collapse departments');
click(container.innerHTML, 'ogp-dept');
assert(container.innerHTML.includes('ogp-panel open'), 'The first click after filtering must expand');

// Both department cards and their chevron buttons must handle nested string segments.
const nestedPath = [0, 's', 0];
const child = { name: '阁属', positions: [{ ...seat }], subs: [] };
reset([{ name: '内阁', positions: [], subs: [child] }], 'tree');
context.GM._officeCollapsed['[0]'] = false;
context.GM._officeCollapsed[JSON.stringify(nestedPath)] = true;
context.renderOfficeTree(true);
click(container.innerHTML, 'og-v10-dept', 1);
assert.strictEqual(context.GM._officeCollapsed[JSON.stringify(nestedPath)], false);
assert(container.innerHTML.includes('og-v10-pos '), 'Nested department must display its positions');
click(container.innerHTML, 'og-v10-pos-btn');
assert.deepStrictEqual(opened[0], [0, 's', 0, 'p', 0]);
click(container.innerHTML, 'og-v10-dept-collapse', 1);
assert.strictEqual(context.GM._officeCollapsed[JSON.stringify(nestedPath)], true);
assert(!container.innerHTML.includes('og-v10-pos '), 'Chevron must collapse the same department');

// The existing list renderer also handles occupied positions through the same picker.
context.GM.chars = [{ name: '阁臣', alive: true, officialTitle: '大学士', rankLevel: 18 }];
const occupied = { ...seat, holder: '阁臣' };
click(context._ogpRenderPosCard(occupied, '内阁', [0, 'positions', 0]), 'ogp-pos-btn');
assert.deepStrictEqual(opened, [[0, 'positions', 0], '内阁', '大学士', '阁臣']);

// The legacy tree card must encode nested paths too.
let rendered = 0;
context.renderOfficeTree = () => { rendered++; };
const legacy = context._ogRenderDeptCard({ node: child, path: nestedPath, depth: 2,
  x: 0, y: 0, collapsed: true }, 0, 240, 120, JSON.stringify(nestedPath));
click(legacy, 'og-dept-card');
assert.strictEqual(rendered, 1);
click(legacy, 'og-dept-collapse');
assert.strictEqual(rendered, 2);

console.log('smoke-office-click-handlers: PASS (appointment, replacement, cabinet expansion, filters, nested departments, view switching)');
