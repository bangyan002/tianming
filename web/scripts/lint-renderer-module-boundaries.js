#!/usr/bin/env node
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const lib = require('./lib-arch-guard');

const BUNDLE = 'generated/tm-ai-change-applier.bundle.js';
const MODULE_ROOT = path.join(lib.WEB_ROOT, 'modules', 'ai-change-applier');
const SOURCES = [
  'context.js',
  'core.js',
  'office-update-intent.js',
  'validators.js',
  'reconcile.js',
  'legacy-adapter.js',
  'index.js'
];
const LEGACY = [
  'tm-ai-change-applier.js',
  'tm-ai-change-applier-validators.js',
  'tm-ai-change-applier-reconcile.js'
];
const failures = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const indexScripts = lib.parseIndexScripts().map((entry) => entry.src);
check(indexScripts.filter((src) => src === BUNDLE).length === 1, 'index.html must load exactly one AI applier bundle');
LEGACY.forEach((file) => {
  check(!fs.existsSync(path.join(lib.WEB_ROOT, file)), file + ' must be removed');
  check(indexScripts.indexOf(file) === -1, file + ' must not remain in index.html');
});

const bundlePath = path.join(lib.WEB_ROOT, BUNDLE);
check(fs.existsSync(bundlePath), BUNDLE + ' must exist');
const bundle = fs.existsSync(bundlePath) ? read(bundlePath) : '';
check(bundle.startsWith('// GENERATED FILE — run: npm run build:renderer-modules'), 'bundle must carry the generated-file provenance header');
check(bundle.indexOf('__acaParts') === -1 && bundle.indexOf('__acaP') === -1, 'bundle must not recreate the legacy ACA bucket');
check(!/\beval\s*\(|\bnew\s+Function\s*\(/.test(bundle), 'bundle must not execute generated strings');

let combinedSource = '';
SOURCES.forEach((name) => {
  const file = path.join(MODULE_ROOT, name);
  check(fs.existsSync(file), 'missing module source ' + name);
  if (!fs.existsSync(file)) return;
  const source = read(file);
  combinedSource += '\n' + source;
  const lines = source.split(/\r?\n/).length;
  check(lines <= 3000, name + ' exceeds the 3000-line module boundary: ' + lines);
  try {
    acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (error) {
    failures.push(name + ' does not parse as an ES module: ' + error.message);
  }
});
check(combinedSource.indexOf('__acaParts') === -1 && combinedSource.indexOf('__acaP') === -1, 'module sources must communicate only through imports, parameters, and return values');

const entry = read(path.join(MODULE_ROOT, 'index.js'));
['./core.js', './validators.js', './reconcile.js', './context.js', './legacy-adapter.js'].forEach((specifier) => {
  check(entry.indexOf("from '" + specifier + "'") >= 0, 'module entry must explicitly import ' + specifier);
});
check(/validateDependencies\(deps\)[\s\S]*createCore\(deps\)/.test(entry), 'dependency validation must precede core initialization');
check(/buildAIChangeApplier\(deps\)[\s\S]*legacyExports/.test(entry), 'module graph must be fully built before legacy publication');
const adapter = read(path.join(MODULE_ROOT, 'legacy-adapter.js'));
check(/existing && existing\.initialized === true/.test(adapter), 'legacy adapter must initialize idempotently');
check(adapter.indexOf('Object.getOwnPropertyDescriptor') >= 0 && adapter.indexOf('Object.defineProperty') >= 0, 'legacy publication must snapshot and restore property descriptors');
check(adapter.indexOf('restoreProperties(snapshots)') >= 0, 'legacy publication failure must roll back every published property');
check(adapter.indexOf("publishProperty(aiNamespace, 'ApplierModule', state)") > adapter.indexOf('exportKeys.forEach'), 'initialized module state must publish after every legacy global');
check(adapter.indexOf('ai-change-applier-publish-failed') >= 0, 'legacy publication failures must remain structured and retryable after rollback');

const pureFactories = read(path.join(MODULE_ROOT, 'core.js')) + '\n' + read(path.join(MODULE_ROOT, 'reconcile.js'));
[
  'AIChangeApplier', 'applyAllegianceChange', '_syncFiscalScalars', '_arriveCharNow',
  '_hasInstantArrivalRule', 'applyAITurnChanges', 'applyAIArmyChange', 'onAppointment',
  'onDismissal', 'normalizeAIWriteBackDeaths', 'applyNormalizedAIWriteBackDeaths',
  'preflightAIWriteBack', 'validateAIWriteBackBatch', '_applyBattleResult'
].forEach((name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  check(!new RegExp('\\b(?:global|window)\\.' + escaped + '\\s*=(?!=)').test(pureFactories), name + ' must only publish through the atomic legacy adapter');
});

const splitContracts = read(path.join(lib.WEB_ROOT, 'scripts', 'lint-split-contracts.js'));
LEGACY.forEach((file) => check(splitContracts.indexOf(file) === -1, file + ' must not remain a split-order contract'));

const prerequisiteOrder = ['tm-ai-change-pathutils.js', 'tm-ai-change-army.js', 'tm-ai-change-narrative.js', BUNDLE]
  .map((src) => indexScripts.indexOf(src));
check(prerequisiteOrder.every((position) => position >= 0), 'AI applier prerequisites and bundle must all be mounted');
check(prerequisiteOrder.every((position, index) => index === 0 || position > prerequisiteOrder[index - 1]), 'AI applier capability providers must precede its single bundle');

const buildCheck = cp.spawnSync(process.execPath, [path.join(lib.WEB_ROOT, 'scripts', 'build-renderer-modules.js'), '--check'], {
  cwd: path.resolve(lib.WEB_ROOT, '..'),
  encoding: 'utf8',
  windowsHide: true
});
check(buildCheck.status === 0, 'generated bundle is stale: ' + String(buildCheck.stdout || buildCheck.stderr || '').trim());

if (failures.length) {
  console.error('[lint-renderer-module-boundaries] FAIL ' + failures.length + '/' + checks);
  failures.forEach((failure) => console.error('  - ' + failure));
  process.exit(1);
}

console.log('[lint-renderer-module-boundaries] PASS checks=' + checks);
