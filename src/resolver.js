'use strict';
// Resolvedor de tipo: dado o documento e o prefixo da linha ate o cursor,
// descobre a qual model o acesso se refere e QUAL operador ('.' ou ':') foi
// usado. No arken:
//   coluna  -> propriedade com ponto:      reg.descricao
//   relacao -> metodo com dois-pontos:     reg:items()   (class[name]=function(self))
//   metodo  -> tambem dois-pontos:         reg:save()
// Encadeamento: reg:items()[1]:produto()  /  reg:items()[1].id

// Metodos do ActiveRecord que devolvem instancia/colecao do proprio model.
const MODEL_FACTORIES = ['find', 'new', 'first', 'last', 'all', 'create', 'where'];

// Declaracoes locais cruas do arquivo. A resolucao (model x modulo do arken)
// acontece depois, em resolveVar, porque depende do indice e do catalogo.
function scanDecls(docText) {
  const decls = new Map();
  let m;

  // local X = require('A.B') -> model do projeto OU modulo do arken
  const reReq = /local\s+([A-Za-z_]\w*)\s*=\s*require\s*\(?\s*['"]([\w.\-]+)['"]/g;
  while ((m = reReq.exec(docText)) !== null) {
    decls.set(m[1], { kind: 'require', path: m[2] });
  }

  // local X = require('A.B').metodo(...) -> aplica o metodo sobre o modulo
  const reReqCall = /local\s+([A-Za-z_]\w*)\s*=\s*require\s*\(?\s*['"]([\w.\-]+)['"]\s*\)?\s*[.:]\s*([A-Za-z_]\w*)/g;
  while ((m = reReqCall.exec(docText)) !== null) {
    decls.set(m[1], { kind: 'require-call', path: m[2], method: m[3] });
  }

  // local X = Class.new('A.B', 'ActiveRecord') -> classe (model do arquivo)
  const reClass = /local\s+([A-Za-z_]\w*)\s*=\s*Class\.new\(\s*['"]([\w.]+)['"]/g;
  while ((m = reClass.exec(docText)) !== null) {
    decls.set(m[1], { kind: 'model-class', className: m[2] });
  }

  // local r = <Var>.metodo(...):outro() -> depende do que <Var> for
  const reExpr =
    /local\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*(?:\s*[.:]\s*[A-Za-z_]\w*\s*(?:\([^()]*\))?\s*(?:\[[^\]]*\])?)+)/g;
  while ((m = reExpr.exec(docText)) !== null) {
    if (decls.has(m[1]) && decls.get(m[1]).kind !== 'expr') continue;
    decls.set(m[1], { kind: 'expr', expr: m[2] });
  }

  return decls;
}

// Compatibilidade: mapa simples nome -> { className, kind } dos models.
function scanLocals(docText) {
  const locals = new Map();
  const decls = scanDecls(docText);
  for (const [name, d] of decls) {
    if (d.kind === 'require') locals.set(name, { className: d.path, kind: 'class' });
    else if (d.kind === 'model-class') locals.set(name, { className: d.className, kind: 'class' });
    else if (d.kind === 'require-call' && MODEL_FACTORIES.indexOf(d.method) >= 0) {
      locals.set(name, { className: d.path, kind: 'instance' });
    }
  }
  for (const [name, d] of decls) {
    if (d.kind !== 'expr') continue;
    const chain = extractChain(d.expr);
    if (!chain || chain.length !== 2) continue;
    const base = locals.get(chain[0]);
    if (base && MODEL_FACTORIES.indexOf(chain[1]) >= 0) {
      locals.set(name, { className: base.className, kind: 'instance' });
    }
  }
  return locals;
}

// ------------------------------------------------------- tipos do catalogo arken

function apiModule(index, name) {
  const api = index && index.api;
  if (!api || !name) return null;
  return api.modules.get(name) || null;
}

function apiGlobal(index, name) {
  const api = index && index.api;
  if (!api || !name) return null;
  return api.globals.get(name) || null;
}

function findFn(list, name) {
  return list.find(function (f) { return f.name === name; }) || null;
}

// Funcoes visiveis num receiver do arken, conforme o operador usado.
function apiMembers(type) {
  const mod = type.module;
  if (!mod) return []; // number/boolean: sem metodos de instancia no arken
  if (type.kind === 'instance') {
    return mod.instance.length ? mod.instance : mod.static;
  }
  return mod.static.length ? mod.static : mod.instance;
}

// Biblioteca padrao de string do Lua 5.1/LuaJIT. Nao vem do arken, mas a tabela
// `string` e' o __index das strings, entao valem como metodo do valor — sem
// elas a lista de uma coluna string ficaria faltando gsub/lower/upper/sub.
const LUA_STRING_METHODS = [
  { name: 'byte', params: ['i', 'j'] },
  { name: 'find', params: ['pattern', 'init', 'plain'] },
  { name: 'format', params: ['...'] },
  { name: 'gmatch', params: ['pattern'] },
  { name: 'gsub', params: ['pattern', 'repl', 'n'] },
  { name: 'len', params: [] },
  { name: 'lower', params: [] },
  { name: 'match', params: ['pattern', 'init'] },
  { name: 'rep', params: ['n'] },
  { name: 'reverse', params: [] },
  { name: 'sub', params: ['i', 'j'] },
  { name: 'upper', params: [] }
].map(function (f) {
  return {
    name: f.name,
    params: f.params.map(function (p) { return { name: p, type: null, optional: false }; }),
    returns: null, file: null, line: 0, lua: true
  };
});

// Metodos que o proprio Lua da ao valor deste tipo.
function builtinMembers(type) {
  if (!type || type.kind !== 'instance') return [];
  const name = type.module ? type.module.name : null;
  return (name === 'arken.string' || name === 'string') ? LUA_STRING_METHODS : [];
}

// Qual tabela global do Lua o modulo representa — e' por ela que as extensoes
// do config/profile.lua do projeto chegam ao tipo.
const MODULE_GLOBAL = {
  'arken.string': 'string',
  'string': 'string',
  'os': 'os',
  'math': 'math',
  'table': 'table'
};

// Extensoes de tipo declaradas no profile do projeto, aplicaveis a este tipo.
// Em contexto de instancia (`valor:metodo()`) o primeiro parametro e' o self.
function projectMembers(index, type) {
  const ext = index && index.extensions;
  if (!ext || !type || !type.module) return [];
  const list = ext[MODULE_GLOBAL[type.module.name]];
  if (!list) return [];
  if (type.kind !== 'instance') return list;
  return list.map(function (fn) {
    return Object.assign({}, fn, { params: fn.params.slice(1), project: true });
  });
}

// Submodulos alcancaveis por campo: arken.concurrent.task -> task.singular, task.fifo...
function apiSubmodules(index, mod) {
  const api = index && index.api;
  if (!api || !mod) return [];
  const prefix = mod.name + '.';
  const subs = [];
  for (const name of api.modules.keys()) {
    if (name.indexOf(prefix) !== 0) continue;
    if (name.slice(prefix.length).indexOf('.') >= 0) continue; // so o nivel seguinte
    subs.push(api.modules.get(name));
  }
  return subs;
}

// Aplica um passo da cadeia (`:metodo()` / `.campo`) sobre um tipo do arken.
function apiStep(index, type, name) {
  const fn = findFn(apiMembers(type), name);
  if (fn) {
    if (!fn.returns) return null;
    const next = apiModule(index, fn.returns);
    return next ? { module: next, kind: 'instance' } : null;
  }
  // campo que e' outro modulo: task.singular, concurrent.task, ...
  const sub = apiModule(index, type.module.name + '.' + name);
  return sub ? { module: sub, kind: 'class' } : null;
}

// ------------------------------------------------------- tipo das colunas
//
// O que `record.coluna` guarda de fato (lib/arken/ActiveRecord/Adapter.lua,
// *ParserValue): date/datetime/time ficam como a STRING crua do banco; so
// `record:read('coluna')` (read_value_*) converte para Date/Time. Por isso
// `module` (acesso direto) e `reads` (via read) sao diferentes.
const COLUMN_TYPES = {
  string:    { lua: 'string',  module: 'arken.string' },
  text:      { lua: 'string',  module: 'arken.string' },
  time:      { lua: 'string',  module: 'arken.string' },
  date:      { lua: 'string',  module: 'arken.string', reads: 'arken.chrono.Date' },
  datetime:  { lua: 'string',  module: 'arken.string', reads: 'arken.chrono.Time' },
  timestamp: { lua: 'string',  module: 'arken.string', reads: 'arken.chrono.Time' },
  number:    { lua: 'number',  module: null },
  boolean:   { lua: 'boolean', module: null }
};

// Metodos do ActiveRecord que devolvem o valor convertido de uma coluna.
const COLUMN_READERS = ['read', 'get'];

function findColumn(model, name) {
  return model.columns.find(function (c) { return c.name === name; }) || null;
}

// Tipo do valor de uma coluna. `viaRead` escolhe o valor convertido.
function columnType(index, model, col, viaRead) {
  const spec = COLUMN_TYPES[col.format];
  if (!spec) return null;
  const target = viaRead && spec.reads ? spec.reads : spec.module;
  const base = {
    column: col, owner: model,
    lua: viaRead && spec.reads ? spec.reads : spec.lua,
    converted: !!(viaRead && spec.reads)
  };
  const mod = target ? apiModule(index, target) : null;
  // number/boolean nao tem metodos de instancia no arken: tipo sem membros.
  if (!mod) return Object.assign(base, { module: null, kind: 'value' });
  return Object.assign(base, { module: mod, kind: 'instance' });
}

// Um passo de cadeia sobre qualquer tipo: relacao/coluna (model) ou retorno (arken).
function stepType(index, type, step) {
  if (!type) return null;
  const name = typeof step === 'string' ? step : step.name;
  const args = typeof step === 'string' ? '' : step.args;

  if (type.column) return null; // colunas nao encadeiam mais nada

  if (!type.model) return apiStep(index, type, name);

  if (type.kind === 'class') {
    // Regra.find{...} / Regra.new() -> instancia do proprio model
    return MODEL_FACTORIES.indexOf(name) >= 0 ? { model: type.model, kind: 'instance' } : null;
  }

  const rel = type.model.relations.find(function (r) { return r.name === name; });
  if (rel) {
    const next = index.byClass.get(rel.record);
    return next ? { model: next, kind: 'instance' } : null;
  }

  // self:read('created_at') -> valor convertido (Date/Time)
  if (COLUMN_READERS.indexOf(name) >= 0) {
    const col = findColumn(type.model, literalArg(args));
    return col ? columnType(index, type.model, col, true) : null;
  }

  // self.descricao -> string do banco, com os metodos de string do arken
  const col = findColumn(type.model, name);
  return col ? columnType(index, type.model, col, false) : null;
}

// className do model declarado neste arquivo (para resolver 'self').
function selfClassName(docText) {
  const m = docText.match(/Class\.new\(\s*['"]([\w.]+)['"]\s*,\s*['"]ActiveRecord['"]\s*\)/);
  return m ? m[1] : null;
}

// Separa o operador final ('.'/':') e o que ja foi digitado depois dele.
// Retorna { op, partial, receiverExpr } ou null.
function parseAccess(linePrefix) {
  const m = linePrefix.match(/([.:])\s*([A-Za-z0-9_]*)$/);
  if (!m) return null;
  return {
    op: m[1],
    partial: m[2],
    receiverExpr: linePrefix.slice(0, m.index)
  };
}

// Igual a extractChain, mas cada passo carrega os argumentos escritos, para
// quem precisa deles (read('coluna')). Retorna [{ name, args }] ou null.
function extractChainSteps(receiverExpr) {
  const tail = receiverExpr.match(
    /([A-Za-z_]\w*)((?:\s*[.:]\s*[A-Za-z_]\w*\s*(?:\([^()]*\))?\s*(?:\[[^\]]*\])?)*)\s*$/
  );
  if (!tail) return null;
  const steps = [{ name: tail[1], args: '' }];
  const re = /[.:]\s*([A-Za-z_]\w*)\s*(?:\(([^()]*)\))?/g;
  let m;
  while ((m = re.exec(tail[2])) !== null) {
    steps.push({ name: m[1], args: m[2] || '' });
  }
  return steps;
}

// A partir do fim de receiverExpr, extrai a cadeia de acesso que forma o
// receiver: base + segmentos ".nome" / ":nome()" (ignorando () e [..]).
// Ex.: "print(reg:items()[1]:produto()" -> ['reg','items','produto']
function extractChain(receiverExpr) {
  const steps = extractChainSteps(receiverExpr);
  return steps ? steps.map(function (s) { return s.name; }) : null;
}

// Primeiro argumento literal de uma chamada, ignorando os demais:
//   read('created_at') / get('saldo', 0) -> created_at / saldo
function literalArg(args) {
  const m = (args || '').match(/^\s*['"]([\w.]+)['"]\s*(?:,|$)/);
  return m ? m[1] : null;
}

// Tipo de uma variavel local: { model, kind } de um model do projeto,
// { module, kind } de um modulo do arken, ou null.
function resolveVar(index, decls, name, seen) {
  const guard = seen || new Set();
  if (guard.has(name)) return null;
  guard.add(name);

  const d = decls.get(name);
  if (!d) {
    // tabela global do arken (os, string, math)
    const global = apiGlobal(index, name);
    if (global) return { module: global, kind: 'class' };
    // global publicada pelo profile do projeto (DateTime, JSON, Date, ...)
    const alias = index && index.globalAliases ? index.globalAliases[name] : null;
    if (!alias) return null;
    const model = index.byClass.get(alias);
    if (model) return { model: model, kind: 'class' };
    const mod = apiModule(index, alias);
    return mod ? { module: mod, kind: 'class' } : null;
  }

  if (d.kind === 'model-class') {
    const model = index.byClass.get(d.className);
    return model ? { model: model, kind: 'class' } : null;
  }

  if (d.kind === 'require' || d.kind === 'require-call') {
    const model = index.byClass.get(d.path);
    const mod = model ? null : apiModule(index, d.path);
    if (!model && !mod) return null;
    const type = model ? { model: model, kind: 'class' } : { module: mod, kind: 'class' };
    return d.kind === 'require' ? type : stepType(index, type, d.method);
  }

  if (d.kind === 'expr') {
    const chain = extractChainSteps(d.expr);
    if (!chain || chain.length < 2) return null;
    let type = resolveVar(index, decls, chain[0].name, guard);
    for (const step of chain.slice(1)) {
      type = stepType(index, type, step);
      if (!type) return null;
    }
    return type;
  }

  return null;
}

// Resolve o receiver. Para models: { model, kind, op, partial }.
// Para a API do arken: { module, kind, op, partial }.
function resolve(index, docText, linePrefix) {
  const acc = parseAccess(linePrefix);
  if (!acc) return null;

  const chain = extractChainSteps(acc.receiverExpr);
  if (!chain || chain.length === 0) return null;

  const decls = scanDecls(docText);
  const base = chain[0].name;
  const steps = chain.slice(1);

  let type;
  if (base === 'self') {
    const className = selfClassName(docText);
    const model = className ? index.byClass.get(className) : null;
    if (!model) return null;
    type = { model: model, kind: 'instance' };
  } else {
    type = resolveVar(index, decls, base);
    if (!type) return null;
  }

  for (const step of steps) {
    type = stepType(index, type, step);
    if (!type) return null;
  }

  if (type.model) {
    return { model: type.model, kind: type.kind, op: acc.op, partial: acc.partial };
  }
  return {
    module: type.module, kind: type.kind, op: acc.op, partial: acc.partial,
    column: type.column || null, owner: type.owner || null,
    lua: type.lua || null, converted: !!type.converted
  };
}

// --- helpers para os providers (signature/definition/completions contextuais) ---

// Chamada em andamento: "<receiver>:metodo(arg1, arg" -> resolve receiver + metodo.
// Retorna { receiverExpr, op, method, activeParam } ou null.
function parseCall(linePrefix) {
  const m = linePrefix.match(/([.:])\s*([A-Za-z_]\w*)\s*\(([^()]*)$/);
  if (!m) return null;
  const argsText = m[3];
  return {
    receiverExpr: linePrefix.slice(0, m.index),
    op: m[1],
    method: m[2],
    activeParam: argsText.length ? argsText.split(',').length - 1 : 0
  };
}

// Cursor dentro de uma string alvo de navegacao: require('X') ou record='X'.
// Retorna { kind: 'require'|'record', value } se o char estiver na string.
function stringTargetAt(lineText, character) {
  const re = /(require\s*\(?\s*|record\s*=\s*)['"]([\w.\-]+)['"]/g;
  let m;
  while ((m = re.exec(lineText)) !== null) {
    const quote = m.index + m[1].length;      // posicao da aspa de abertura
    const start = quote + 1;
    const end = start + m[2].length;           // fim do valor (exclusivo)
    if (character >= start && character <= end) {
      return { kind: m[1].indexOf('require') === 0 ? 'require' : 'record', value: m[2] };
    }
  }
  return null;
}

// Cursor digitando dentro de require('...') -> retorna o parcial ja digitado.
function inRequireString(linePrefix) {
  const m = linePrefix.match(/require\s*\(?\s*['"]([\w.\-]*)$/);
  return m ? m[1] : null;
}

// Nome da variavel local imediatamente antes do require, se o cursor esta
// dentro do require('...'). Ex.: "local Pedido_Item = require('" -> "Pedido_Item".
function localVarForRequire(linePrefix) {
  const m = linePrefix.match(/\blocal\s+([A-Za-z_]\w*)\s*=\s*require\s*\(?\s*['"][\w.\-]*$/);
  return m ? m[1] : null;
}

// Caminho de require inferido a partir do nome da variavel: '_' vira '.'.
// "Pedido_Item" -> "Pedido.Item" ; "Empresa" -> "Empresa"
function requirePathFromVar(varName) {
  return varName.split('_').join('.');
}

// Cursor digitando dentro de um campo de bloco de relacao (record/foreignKey/name).
// Retorna { field, partial } ou null.
function inRelationField(linePrefix) {
  const m = linePrefix.match(/\b(record|foreignKey|name)\s*=\s*['"]([\w.]*)$/);
  return m ? { field: m[1], partial: m[2] } : null;
}

module.exports = {
  resolve, scanLocals, scanDecls, resolveVar, extractChain, extractChainSteps,
  parseAccess, selfClassName,
  parseCall, stringTargetAt, inRequireString, inRelationField,
  localVarForRequire, requirePathFromVar,
  apiModule, apiGlobal, apiMembers, apiSubmodules, projectMembers, builtinMembers, findFn,
  LUA_STRING_METHODS,
  columnType, COLUMN_TYPES, COLUMN_READERS, MODEL_FACTORIES
};
