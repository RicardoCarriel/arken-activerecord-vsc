'use strict';
// Extrator da API do proprio arken (sem dependencia do 'vscode').
//
// Le um checkout/instalacao do arken e produz um catalogo:
//   modules: { 'arken.base64': { static: [...], instance: [...] }, ... }
//   globals: { os: {...}, string: {...}, math: {...} }
//
// Duas fontes:
//   1) bindings C++ em src/bindings/**/*.cpp
//        luaL_newmetatable(L, "arken.x")            -> tabela do modulo (estatico)
//        luaL_newmetatable(L, "arken.x.metatable")  -> metodos de instancia
//        luaL_register(L, "os", Map)                -> tabela global
//      os parametros saem dos luaL_check*/lua_to* do corpo da funcao C.
//   2) bibliotecas Lua em lib/arken/**/*.lua
//        function M:nome(p) -> instancia ; function M.nome(p) -> estatico
//
// O mesmo parser roda em build time (tools/gen-arken-api.js, gera
// data/arken-api.json) e em runtime, quando o usuario aponta arkenLsp.arkenPath
// para um checkout do arken.

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ utilidades

function makeLineLookup(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return function (offset) {
    let lo = 0, hi = starts.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= offset) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  };
}

function walkFiles(dir, ext, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, ext, out);
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

// ------------------------------------------------------------- parser C++

// Corpo de cada `static int nome( lua_State *L ) { ... }`, por casamento de chaves.
function collectCFunctions(source) {
  const bodies = new Map();
  const re = /(?:static\s+)?int\s*\n?\s*(\w+)\s*\(\s*lua_State\s*\*\s*L\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    bodies.set(m[1], { body: source.slice(m.index + m[0].length, i - 1), index: m.index });
  }
  return bodies;
}

// Arrays `luaL_reg NOME[] = { {"lua", c_func}, ... };`
function collectRegTables(source) {
  const tables = new Map();
  const re = /luaL_reg\s+(\w+)\s*\[\s*\]\s*=\s*\{([\s\S]*?)\}\s*;/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const entries = [];
    const reEntry = /\{\s*"([^"]+)"\s*,\s*(\w+)\s*\}/g;
    let e;
    while ((e = reEntry.exec(m[2])) !== null) {
      entries.push({ name: e[1], fn: e[2] });
    }
    tables.set(m[1], entries);
  }
  return tables;
}

// Onde cada array de registro e' publicado: metatable nomeada ou tabela global.
function collectRegistrations(source) {
  const regs = [];
  const reMeta = /luaL_newmetatable\s*\(\s*L\s*,\s*"([^"]+)"\s*\)\s*;\s*luaL_register\s*\(\s*L\s*,\s*(?:nullptr|NULL|0)\s*,\s*(\w+)\s*\)/g;
  let m;
  while ((m = reMeta.exec(source)) !== null) {
    regs.push({ target: m[1], table: m[2], global: false });
  }
  const reGlobal = /luaL_register\s*\(\s*L\s*,\s*"([^"]+)"\s*,\s*(\w+)\s*\)/g;
  while ((m = reGlobal.exec(source)) !== null) {
    regs.push({ target: m[1], table: m[2], global: true });
  }
  return regs;
}

const C_TYPES = {
  string: 'string', lstring: 'string', integer: 'number', number: 'number',
  boolean: 'boolean', udata: 'userdata', userdata: 'userdata', int: 'number',
  long: 'number', table: 'table', function: 'function', thread: 'thread'
};

// Parametros a partir dos luaL_check*/luaL_opt*/lua_to* do corpo, indexados pela
// posicao na pilha. `skipSelf` ignora o indice 1 (metodos de instancia).
function paramsFromBody(body, skipSelf) {
  const slots = new Map();
  const re = /(?:([A-Za-z_]\w*(?:\s*\*)?)\s+\*?\s*([A-Za-z_]\w*)\s*=\s*)?(luaL_check|luaL_opt|lua_to)(\w*)\s*\(\s*L\s*,\s*(\d+)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const slot = parseInt(m[5], 10);
    if (!slot || (skipSelf && slot === 1)) continue;
    const kind = m[3];
    const raw = (m[4] || '').toLowerCase();
    const type = C_TYPES[raw] || null;
    const prev = slots.get(slot);
    const entry = {
      name: m[2] || (prev && prev.name) || null,
      type: type || (prev && prev.type) || null,
      optional: kind === 'luaL_opt' ? true : (prev ? prev.optional : false)
    };
    if (!prev || (!prev.name && entry.name)) slots.set(slot, entry);
  }

  const max = slots.size ? Math.max.apply(null, Array.from(slots.keys())) : 0;
  const first = skipSelf ? 2 : 1;
  const params = [];
  for (let i = first; i <= max; i++) {
    const s = slots.get(i);
    params.push({
      name: (s && s.name) || ('arg' + (i - first + 1)),
      type: (s && s.type) || null,
      optional: !!(s && s.optional)
    });
  }
  return params;
}

// Modulo devolvido pela funcao: `luaL_getmetatable(L, "arken.x.metatable")`.
function returnsFromBody(body) {
  const m = body.match(/luaL_getmetatable\s*\(\s*L\s*,\s*"([^"]+)\.metatable"\s*\)/);
  return m ? m[1] : null;
}

// Nome de require declarado pelo arquivo: luaopen_arken_digest_md5 -> arken.digest.md5.
function luaopenNames(source) {
  const names = [];
  const re = /\bluaopen_(\w+)\s*\(\s*lua_State/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const name = m[1].split('_').join('.');
    if (names.indexOf(name) < 0) names.push(name);
  }
  return names;
}

// Um arquivo .cpp -> lista de { target, global, functions: [...] }.
function parseBindingSource(source, relFile) {
  const lineAt = makeLineLookup(source);
  const bodies = collectCFunctions(source);
  const tables = collectRegTables(source);
  const opens = luaopenNames(source);
  // Alguns bindings nomeiam a metatable sem o prefixo do modulo (ex.: "odebug"
  // em luaopen_arken_odebug). Com um unico luaopen no arquivo, ele manda.
  const canonical = opens.length === 1 ? opens[0] : null;
  const out = [];

  for (const reg of collectRegistrations(source)) {
    const entries = tables.get(reg.table);
    if (!entries) continue;
    const skipSelf = /\.metatable$/.test(reg.target);
    let target = reg.target;
    if (!reg.global && canonical && target.indexOf('arken.') !== 0) {
      target = skipSelf ? canonical + '.metatable' : canonical;
    }
    const functions = [];
    for (const entry of entries) {
      if (entry.name.indexOf('__') === 0) continue; // metametodos (__gc, __eq, ...)
      const fn = bodies.get(entry.fn);
      functions.push({
        name: entry.name,
        params: fn ? paramsFromBody(fn.body, skipSelf) : [],
        returns: fn ? returnsFromBody(fn.body) : null,
        file: relFile,
        line: fn ? lineAt(fn.index) : 0
      });
    }
    out.push({ target: target, global: reg.global, functions: functions });
  }
  return out;
}

// ------------------------------------------------------------- parser Lua

// Nome do modulo a partir do caminho: lib/arken/net/url.lua -> arken.net.url
function luaModuleName(libDir, file) {
  const rel = path.relative(libDir, file).replace(/\.lua$/, '');
  return rel.split(path.sep).join('.');
}

// Variavel exportada: `return X` no fim do arquivo, senao o alvo do Class.new.
function luaModuleVar(source) {
  const ret = source.match(/\breturn\s+([A-Za-z_]\w*)\s*;?\s*$/);
  if (ret) return ret[1];
  const cls = source.match(/local\s+([A-Za-z_]\w*)\s*=\s*Class\.new\s*\(/);
  return cls ? cls[1] : null;
}

function luaParams(text) {
  return text.split(',')
    .map(function (p) { return p.trim(); })
    .filter(function (p) { return p.length > 0; })
    .map(function (p) { return { name: p, type: null, optional: false }; });
}

function parseLuaSource(source, moduleName, relFile) {
  const varName = luaModuleVar(source);
  if (!varName) return null;
  const lineAt = makeLineLookup(source);
  const v = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const instance = [];
  const staticM = [];
  const seenI = new Set();
  const seenS = new Set();
  let m;

  const reInst = new RegExp('function\\s+' + v + '\\s*:\\s*([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)', 'g');
  while ((m = reInst.exec(source)) !== null) {
    if (seenI.has(m[1])) continue;
    seenI.add(m[1]);
    instance.push({ name: m[1], params: luaParams(m[2]), returns: null, file: relFile, line: lineAt(m.index) });
  }

  const reStatic = new RegExp('function\\s+' + v + '\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)', 'g');
  while ((m = reStatic.exec(source)) !== null) {
    if (seenS.has(m[1])) continue;
    seenS.add(m[1]);
    staticM.push({ name: m[1], params: luaParams(m[2]), returns: null, file: relFile, line: lineAt(m.index) });
  }

  const reAssign = new RegExp('\\b' + v + '\\s*\\.\\s*([A-Za-z_]\\w*)\\s*=\\s*function\\s*\\(([^)]*)\\)', 'g');
  while ((m = reAssign.exec(source)) !== null) {
    if (seenS.has(m[1])) continue;
    seenS.add(m[1]);
    staticM.push({ name: m[1], params: luaParams(m[2]), returns: null, file: relFile, line: lineAt(m.index) });
  }

  // M.encode = encode  ->  local function encode(str) declarada no arquivo
  const reAlias = new RegExp('\\b' + v + '\\s*\\.\\s*([A-Za-z_]\\w*)\\s*=\\s*([A-Za-z_]\\w*)\\s*(?:$|[\\r\\n])', 'gm');
  while ((m = reAlias.exec(source)) !== null) {
    if (seenS.has(m[1])) continue;
    const target = source.match(
      new RegExp('(?:local\\s+)?function\\s+' + m[2] + '\\s*\\(([^)]*)\\)'));
    if (!target) continue;
    seenS.add(m[1]);
    staticM.push({
      name: m[1], params: luaParams(target[1]), returns: null,
      file: relFile, line: lineAt(target.index)
    });
  }

  if (!instance.length && !staticM.length) return null;

  // Class.new expoe :new() e os metodos de instancia sao chamados no objeto.
  const isClass = /Class\.new\s*\(/.test(source);
  if (isClass && !seenS.has('new')) {
    staticM.push({ name: 'new', params: [], returns: moduleName, file: relFile, line: 0 });
  }

  return { name: moduleName, kind: 'lua', file: relFile, static: staticM, instance: instance };
}

// lib/arken/ActiveRecord.lua injeta os metodos estaticos em cada model dentro de
// uma fabrica, como `class.find = function(params)`. Sao os metodos que aparecem
// em `Model.<x>` — nao ficam no modulo arken.ActiveRecord.
function parseActiveRecordStatics(source, relFile) {
  const lineAt = makeLineLookup(source);
  const out = [];
  const seen = new Set();
  const re = /\bclass\s*\.\s*([A-Za-z_]\w*)\s*=\s*function\s*\(([^)]*)\)|function\s+class\s*\.\s*([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const name = m[1] || m[3];
    const params = m[1] ? m[2] : m[4];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name: name, params: luaParams(params), returns: null,
      file: relFile, line: lineAt(m.index)
    });
  }
  return out;
}

// Tabelas globais que profiles costumam estender. Em Lua a tabela `string`
// tambem e' o __index das strings, entao `function string.toDate(v)` vale como
// `string.toDate(v)` e como `v:toDate()`.
const EXTENDABLE_GLOBALS = ['string', 'math', 'table', 'os'];

// `function string.toDate(value)` / `os.exec = function(cmd)` de um profile.
function parseGlobalExtensions(source, relFile) {
  const lineAt = makeLineLookup(source);
  const out = {};
  const names = EXTENDABLE_GLOBALS.join('|');
  const re = new RegExp(
    'function\\s+(' + names + ')\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)' +
    '|\\b(' + names + ')\\s*\\.\\s*([A-Za-z_]\\w*)\\s*=\\s*function\\s*\\(([^)]*)\\)', 'g');
  let m;
  while ((m = re.exec(source)) !== null) {
    const table = m[1] || m[4];
    const name = m[2] || m[5];
    const params = m[1] ? m[3] : m[6];
    if (!out[table]) out[table] = [];
    if (out[table].some(function (f) { return f.name === name; })) continue;
    out[table].push({
      name: name, params: luaParams(params), returns: null,
      file: relFile, line: lineAt(m.index)
    });
  }
  return out;
}

// Le os .lua de um diretorio de profile e junta as extensoes de tabela global.
function scanProfileDir(dir, root) {
  const merged = {};
  for (const file of walkFiles(dir, '.lua', [])) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    const found = parseGlobalExtensions(source, root ? path.relative(root, file) : file);
    for (const table of Object.keys(found)) {
      if (!merged[table]) merged[table] = [];
      for (const fn of found[table]) {
        if (merged[table].some(function (f) { return f.name === fn.name; })) continue;
        merged[table].push(fn);
      }
    }
  }
  return merged;
}

// ------------------------------------------------------------------ catalogo

function emptyModule(name, kind, file) {
  return { name: name, kind: kind, file: file || null, static: [], instance: [] };
}

// Le um checkout do arken e devolve o catalogo serializavel.
function scan(arkenPath) {
  const modules = {};
  const globals = {};

  function moduleFor(name, kind, file) {
    if (!modules[name]) modules[name] = emptyModule(name, kind, file);
    if (!modules[name].file && file) modules[name].file = file;
    return modules[name];
  }

  const bindingsDir = path.join(arkenPath, 'src', 'bindings');
  for (const file of walkFiles(bindingsDir, '.cpp', [])) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    const rel = path.relative(arkenPath, file);
    for (const reg of parseBindingSource(source, rel)) {
      if (reg.global) {
        if (!globals[reg.target]) globals[reg.target] = emptyModule(reg.target, 'global', rel);
        globals[reg.target].static = globals[reg.target].static.concat(reg.functions);
        continue;
      }
      const isInstance = /\.metatable$/.test(reg.target);
      const name = isInstance ? reg.target.replace(/\.metatable$/, '') : reg.target;
      const mod = moduleFor(name, 'binding', rel);
      if (isInstance) mod.instance = mod.instance.concat(reg.functions);
      else mod.static = mod.static.concat(reg.functions);
    }
  }

  const libDir = path.join(arkenPath, 'lib');
  for (const file of walkFiles(libDir, '.lua', [])) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    const rel = path.relative(arkenPath, file);
    const name = luaModuleName(libDir, file);
    const parsed = parseLuaSource(source, name, rel);
    if (!parsed) continue;
    const mod = moduleFor(name, 'lua', rel);
    mod.kind = 'lua';
    mod.static = mod.static.concat(parsed.static);
    mod.instance = mod.instance.concat(parsed.instance);
  }

  // profile.d/*.lua do arken estende as tabelas globais (os.exec, table.shuffle).
  const profiles = scanProfileDir(path.join(arkenPath, 'profile.d'), arkenPath);
  for (const table of Object.keys(profiles)) {
    if (!globals[table]) globals[table] = emptyModule(table, 'global', null);
    for (const fn of profiles[table]) {
      if (globals[table].static.some(function (f) { return f.name === fn.name; })) continue;
      globals[table].static.push(fn);
    }
  }

  // Metodos do ActiveRecord herdados por todo model do projeto.
  const arFile = path.join(libDir, 'arken', 'ActiveRecord.lua');
  const activeRecord = { static: [], instance: [] };
  try {
    const source = fs.readFileSync(arFile, 'utf8');
    activeRecord.static = parseActiveRecordStatics(source, path.relative(arkenPath, arFile));
  } catch (e) {
    // sem lib/arken/ActiveRecord.lua o consumidor cai na lista embutida
  }
  const arModule = modules['arken.ActiveRecord'];
  if (arModule) activeRecord.instance = arModule.instance.slice();

  return {
    arkenPath: arkenPath,
    generatedAt: new Date().toISOString(),
    modules: modules,
    globals: globals,
    activeRecord: activeRecord
  };
}

// ------------------------------------------------------- carga em runtime

function isArkenSource(dir) {
  try {
    return !!dir &&
      fs.existsSync(path.join(dir, 'src', 'bindings')) &&
      fs.existsSync(path.join(dir, 'lib', 'arken'));
  } catch (e) {
    return false;
  }
}

// Catalogo com os caminhos de arquivo ja absolutos (para go-to-definition) e
// indices em Map, prontos para os providers.
function prepare(catalog, arkenPath) {
  const root = arkenPath || catalog.arkenPath || null;
  const byModule = new Map();
  const byGlobal = new Map();

  function absolutize(mod) {
    const fix = function (fn) {
      if (fn.file && root) fn.absFile = path.join(root, fn.file);
      return fn;
    };
    mod.static.forEach(fix);
    mod.instance.forEach(fix);
    if (mod.file && root) mod.absFile = path.join(root, mod.file);
    return mod;
  }

  for (const name of Object.keys(catalog.modules || {})) {
    byModule.set(name, absolutize(catalog.modules[name]));
  }
  for (const name of Object.keys(catalog.globals || {})) {
    byGlobal.set(name, absolutize(catalog.globals[name]));
  }

  const activeRecord = catalog.activeRecord || { static: [], instance: [] };
  absolutize(activeRecord);

  return {
    arkenPath: root,
    generatedAt: catalog.generatedAt || null,
    modules: byModule,
    globals: byGlobal,
    activeRecord: activeRecord
  };
}

function loadFile(file, arkenPath) {
  const raw = fs.readFileSync(file, 'utf8');
  return prepare(JSON.parse(raw), arkenPath);
}

module.exports = {
  scan,
  prepare,
  loadFile,
  isArkenSource,
  parseBindingSource,
  parseLuaSource,
  parseGlobalExtensions,
  scanProfileDir,
  paramsFromBody,
  luaModuleName,
  walkFiles,
  EXTENDABLE_GLOBALS
};
