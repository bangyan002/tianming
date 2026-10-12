'use strict';
// Verify separate classic evaluation: direct concatenation would make both captures return B.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const build = `
import sys,tempfile
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from assets import AssetCache
from script_packs import ScriptPacks
with tempfile.TemporaryDirectory() as folder:
 p=ScriptPacks(folder,AssetCache())
 url=p.register([
  {'src':'a.js','code':"function captured(){return 'A'};window.first=captured();let shared=4;"},
  {'src':'b.js','code':"function captured(){return 'B'};window.second=captured();window.lexical=shared+1;"},
  {'src':'c.js','code':"'use strict';window.strict=(function(){return this;})();var classicGlobal=9;"}
 ])
 print(p.resolve(url.rsplit('/',1)[1]).read_text())
`;
const pack=execFileSync('python3',['-c',build,__dirname],{encoding:'utf8'});
let context;
const parent={appendChild(node){vm.runInContext(node.text,context);return node;}};
const world={URL,location:{href:'http://localhost:9123/index.html'},document:{head:parent,currentScript:{parentNode:parent,nonce:''},
  createElement(){return {setAttribute(){},remove(){}};}}};
world.window=world;context=vm.createContext(world);
vm.runInContext(pack,context);
assert.equal(world.first,'A');assert.equal(world.second,'B');assert.equal(world.lexical,5);
assert.equal(world.strict,undefined);assert.equal(world.classicGlobal,9);
assert(!/\beval\s*\(/.test(pack));
console.log('PASS separate global scopes, function override capture, lexical sharing and per-file strictness');
