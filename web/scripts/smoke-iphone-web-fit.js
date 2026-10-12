#!/usr/bin/env node
'use strict';

// Exercise the public stage transform against Safari's changing visible rectangle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'tm-fixed-fit.js'), 'utf8');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
let passed = 0;

function harness(options = {}) {
  const events = new Map(), frames = [], timers = [], classes = new Set();
  function target(name) {
    return { addEventListener(type, fn) {
      const key = name + ':' + type;
      if (!events.has(key)) events.set(key, []);
      events.get(key).push(fn);
    } };
  }
  function element() {
    return { nodeType: 1, style: {}, setAttribute() {}, appendChild() {}, querySelectorAll() { return []; } };
  }
  const body = element(), root = element();
  root.classList = { add(name) { classes.add(name); } };
  const viewportMeta = { setAttribute() {} };
  const document = Object.assign(target('document'), {
    body, head: element(), documentElement: root, readyState: 'complete', styleSheets: [],
    createElement: element, querySelector() { return viewportMeta; }
  });
  const sandbox = Object.assign(target('window'), {
    document, location: { search: options.search || '' }, console,
    navigator: { userAgent: options.ua === undefined ? IPHONE : options.ua },
    innerWidth: options.width || 390, innerHeight: options.height || 844,
    scrollX: 0, scrollY: 0,
    localStorage: { getItem() {
      if (options.blockStorage) throw new Error('storage denied');
      return options.resolution || null;
    } },
    getComputedStyle() { return Object.assign({ paddingTop: '0', paddingRight: '0', paddingBottom: '0', paddingLeft: '0' }, options.insets); },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    setTimeout(fn) { timers.push(fn); },
    MutationObserver: function () { this.observe = function () {}; }
  });
  if (!options.noVisualViewport) sandbox.visualViewport = Object.assign(target('visual'), {
    width: sandbox.innerWidth, height: sandbox.innerHeight, offsetLeft: 0, offsetTop: 0, scale: 1
  });
  if (options.native) sandbox.Capacitor = { isNativePlatform() { return true; } };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'tm-fixed-fit.js' });
  return {
    sandbox, body, classes,
    emit(name, type) {
      for (const fn of events.get(name + ':' + type) || []) fn();
      while (frames.length) frames.shift()();
    },
    settle() { while (timers.length) timers.shift()(); while (frames.length) frames.shift()(); }
  };
}

function bounds(h) {
  const m = /^translate\(([^p]+)px,([^p]+)px\) scale\(([^)]+)\)$/.exec(h.body.style.transform);
  assert.ok(m, 'stage has a translate/scale transform');
  const stage = h.sandbox.TM.fixedFit, left = +m[1], top = +m[2], scale = +m[3];
  return { left, top, right: left + stage.VW * scale, bottom: top + stage.VH * scale, scale };
}
function contained(h, visible) {
  const b = bounds(h);
  assert.ok(b.scale > 0);
  assert.ok(b.left >= visible.left - 0.51 && b.top >= visible.top - 0.51, 'stage starts inside visible safe area');
  assert.ok(b.right <= visible.right + 0.51 && b.bottom <= visible.bottom + 0.51, 'stage ends inside visible safe area');
}
function test(name, fn) { fn(); passed++; console.log('  PASS ' + name); }

console.log('smoke-iphone-web-fit');
test('iPhone enables the full stage without URL flags', () => {
  const h = harness();
  assert.ok(h.classes.has('tm-fixed-fit'));
  contained(h, { left: 0, top: 0, right: 390, bottom: 844 });
});
test('blocked localStorage does not disable iPhone scaling', () => {
  assert.ok(harness({ blockStorage: true }).classes.has('tm-fixed-fit'));
});
test('landscape avoids notch and home indicator', () => {
  const h = harness({ width: 844, height: 390, insets: { paddingLeft: '47px', paddingRight: '47px', paddingBottom: '21px' } });
  contained(h, { left: 47, top: 0, right: 797, bottom: 369 });
});
test('rotation refits without changing the virtual resolution', () => {
  const h = harness(), stage = h.sandbox.TM.fixedFit;
  Object.assign(h.sandbox, { innerWidth: 844, innerHeight: 390 });
  Object.assign(h.sandbox.visualViewport, { width: 844, height: 390 });
  h.emit('window', 'orientationchange'); h.settle();
  assert.equal(h.sandbox.TM.fixedFit.VW, stage.VW);
  assert.ok(bounds(h).scale > 390 / stage.VW);
  contained(h, { left: 0, top: 0, right: 844, bottom: 390 });
});
test('Safari toolbar changes refit through visualViewport.resize', () => {
  const h = harness({ width: 844, height: 390 });
  h.sandbox.visualViewport.height = 290;
  h.emit('visual', 'resize');
  contained(h, { left: 0, top: 0, right: 844, bottom: 290 });
});
test('keyboard panning includes visual offsets and document scroll', () => {
  const h = harness({ width: 844, height: 390 });
  Object.assign(h.sandbox.visualViewport, { offsetLeft: 8, offsetTop: 80, width: 820, height: 180 });
  h.sandbox.scrollY = 30;
  h.emit('visual', 'scroll');
  contained(h, { left: 8, top: 110, right: 828, bottom: 290 });
});
test('keyboard dismissal restores the scale', () => {
  const h = harness({ width: 844, height: 390 }), original = bounds(h).scale;
  h.sandbox.visualViewport.height = 150; h.emit('visual', 'resize');
  assert.ok(bounds(h).scale < original);
  h.sandbox.visualViewport.height = 390; h.emit('document', 'focusout'); h.settle();
  assert.equal(bounds(h).scale, original);
});
test('manual browser zoom is not canceled by automatic refitting', () => {
  const h = harness(), transform = h.body.style.transform;
  Object.assign(h.sandbox.visualViewport, { scale: 2, width: 195, height: 422 });
  h.emit('visual', 'resize');
  assert.equal(h.body.style.transform, transform);
});
test('missing visualViewport falls back to window dimensions', () => {
  contained(harness({ noVisualViewport: true }), { left: 0, top: 0, right: 390, bottom: 844 });
});
test('explicit rendering resolution remains authoritative', () => {
  const h = harness({ resolution: '1920x1080' });
  assert.equal(h.sandbox.TM.fixedFit.VW, 1920);
  assert.equal(h.sandbox.TM.fixedFit.VH, 1080);
});
test('desktop and Android browser retain window-responsive layouts', () => {
  for (const ua of ['Mozilla/5.0 (X11; Linux x86_64)', 'Mozilla/5.0 (Linux; Android 14)']) {
    assert.equal(harness({ ua }).classes.has('tm-fixed-fit'), false);
  }
});
test('native Android retains its wide-screen stage', () => {
  const h = harness({ ua: 'Android', native: true, width: 960, height: 430 });
  assert.ok(h.sandbox.TM.fixedFit.VW > 1477);
  contained(h, { left: 0, top: 0, right: 960, bottom: 430 });
});
console.log('smoke-iphone-web-fit PASS ' + passed + '/' + passed);
