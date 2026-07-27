'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const indexer = require('./indexer');
const resolver = require('./resolver');
const arkenapi = require('./arkenapi');

// Um indice por projeto arken (chave = raiz do projeto). Construido sob demanda.
const indexes = new Map();
// Catalogo da API do proprio arken (bindings C++ + libs Lua). Unico por sessao.
let api = null;
let output = null;
let statusBar = null;
let diagnostics = null;
const debounceTimers = new Map();

function log(msg) {
  if (output) output.appendLine('[arken] ' + msg);
}

// ------------------------------------------------------------- API do arken

const BUNDLED_API = path.join(__dirname, '..', 'data', 'arken-api.json');

// Instalacao/checkout do arken: configuracao, $ARKEN_PATH, irmao do workspace.
function findArkenSource() {
  const configured = (vscode.workspace.getConfiguration('arkenLsp').get('arkenPath') || '').trim();
  const candidates = [configured, process.env.ARKEN_PATH];
  for (const f of (vscode.workspace.workspaceFolders || [])) {
    candidates.push(f.uri.fsPath, path.join(path.dirname(f.uri.fsPath), 'arken'));
  }
  return candidates.filter(Boolean).find(arkenapi.isArkenSource) || null;
}

// Prefere o arken instalado na maquina (sempre em dia com o binario do usuario)
// e cai para o catalogo empacotado com a extensao.
function loadApi() {
  const source = findArkenSource();
  if (source) {
    try {
      const t0 = Date.now();
      const catalog = arkenapi.prepare(arkenapi.scan(source), source);
      log('API do arken: ' + catalog.modules.size + ' modulos lidos de ' + source +
          ' (' + (Date.now() - t0) + 'ms)');
      return catalog;
    } catch (e) {
      log('falha ao ler a API de ' + source + ': ' + e.message);
    }
  }
  try {
    const catalog = arkenapi.loadFile(BUNDLED_API, source);
    log('API do arken: ' + catalog.modules.size + ' modulos do catalogo empacotado.');
    return catalog;
  } catch (e) {
    log('catalogo da API indisponivel: ' + e.message);
    return arkenapi.prepare({ modules: {}, globals: {} }, null);
  }
}

function getApi() {
  if (!api) api = loadApi();
  return api;
}

function isArkenRoot(dir) {
  try {
    if (!fs.existsSync(path.join(dir, 'app', 'models'))) return false;
    return fs.existsSync(path.join(dir, 'config', 'active_record.json')) ||
           fs.existsSync(path.join(dir, 'config', 'profile.lua')) ||
           fs.existsSync(path.join(dir, 'db', 'schema'));
  } catch (e) {
    return false;
  }
}

function findRootUpwards(startDir) {
  let dir = startDir;
  while (dir) {
    if (isArkenRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function rootForFile(filePath) {
  const cfg = vscode.workspace.getConfiguration('arkenLsp');
  const auto = cfg.get('autoDetect') !== false;
  const manual = (cfg.get('projectPath') || '').trim();

  if (auto && filePath) {
    const r = findRootUpwards(path.dirname(filePath));
    if (r) return r;
  }
  if (manual && isArkenRoot(manual)) return manual;
  for (const f of (vscode.workspace.workspaceFolders || [])) {
    if (isArkenRoot(f.uri.fsPath)) return f.uri.fsPath;
  }
  return manual || null;
}

function getIndex(root) {
  if (!root) return null;
  if (!indexes.has(root)) {
    const t0 = Date.now();
    const idx = indexer.buildIndex(root);
    indexes.set(root, idx);
    log('indice: ' + idx.byClass.size + ' models de ' + root + ' (' + (Date.now() - t0) + 'ms)');
  }
  const idx = indexes.get(root);
  idx.api = getApi();
  return idx;
}

// Estrito: so devolve indice quando o arquivo esta dentro de um projeto arken.
// Usado pelos diagnosticos, que dependem da lista real de models.
function indexForFile(filePath) {
  return getIndex(rootForFile(filePath));
}

// Indice vazio com a API do arken, para .lua fora de um projeto: os models nao
// existem, mas require('arken.*') e os globais continuam completando.
let apiOnlyIndex = null;
function apiIndex() {
  if (!apiOnlyIndex) {
    apiOnlyIndex = { projectPath: null, byClass: new Map(), byTable: new Map(), byFile: new Map() };
  }
  apiOnlyIndex.api = getApi();
  return apiOnlyIndex;
}

// Permissivo: usado pelos providers de linguagem.
function contextForFile(filePath) {
  return indexForFile(filePath) || apiIndex();
}

function modelOfFile(idx, filePath) {
  const className = idx.byFile.get(path.resolve(filePath));
  return className ? idx.byClass.get(className) : null;
}

function findRelation(model, name) {
  return model.relations.find(function (r) { return r.name === name; });
}
function findColumn(model, name) {
  return model.columns.find(function (c) { return c.name === name; });
}
function findMethod(list, name) {
  return list.find(function (m) { return m.name === name; });
}

// ---------------------------------------------------------------- completion

function columnDetail(col) {
  const parts = [col.format || col.sql || '?'];
  if (col.primaryKey) parts.push('PK');
  if (col.notNull) parts.push('not null');
  return parts.join(' · ');
}

function makeColumn(model, col) {
  const it = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
  it.detail = columnDetail(col);
  it.documentation = new vscode.MarkdownString('**coluna** de `' + model.tableName + '`');
  it.sortText = '1_' + col.name;
  return it;
}

function makeRelation(rel) {
  const it = new vscode.CompletionItem(rel.name, vscode.CompletionItemKind.Reference);
  it.detail = rel.kind + ' → ' + rel.record;
  it.insertText = new vscode.SnippetString(rel.name + '()');
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**' + rel.kind + '** para `' + rel.record + '`');
  if (rel.foreignKey) md.appendMarkdown('\n\nforeignKey: `' + rel.foreignKey + '`');
  it.documentation = md;
  it.sortText = '0_' + rel.name;
  return it;
}

function makeModelMethod(method) {
  const it = new vscode.CompletionItem(method.name, vscode.CompletionItemKind.Method);
  it.detail = 'método do model(' + method.params + ')';
  it.insertText = new vscode.SnippetString(method.name + '($0)');
  it.sortText = '1_' + method.name;
  return it;
}

// Metodos que todo model herda do ActiveRecord: os reais de
// lib/arken/ActiveRecord.lua, completados pela lista embutida (alguns vem do
// Class/metatable e nao aparecem no fonte de forma parseavel).
function arMethods(kind) {
  const catalog = getApi().activeRecord || { static: [], instance: [] };
  const fallback = kind === 'static' ? indexer.AR_CLASS_METHODS : indexer.AR_INSTANCE_METHODS;
  const out = (catalog[kind] || []).slice();
  const seen = new Set(out.map(function (f) { return f.name; }));
  for (const name of fallback) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name: name, params: [], returns: null, file: null, line: 0 });
  }
  return out;
}

function arDoc(fn) {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(fn.name + '(' + fnSignature(fn) + ')', 'lua');
  md.appendMarkdown('método herdado do **ActiveRecord** do arken');
  if (fn.file) md.appendMarkdown('\n\n_' + fn.file + ':' + (fn.line + 1) + '_');
  return md;
}

function makeArMethod(fn) {
  const it = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Method);
  it.detail = '(' + fnSignature(fn) + ') · ActiveRecord';
  it.insertText = fnSnippet(fn);
  it.sortText = '2_' + fn.name;
  if (fn.file) {
    it.documentation = new vscode.MarkdownString(
      'método do **ActiveRecord** do arken\n\n_' + fn.file + ':' + (fn.line + 1) + '_');
  }
  return it;
}

function pushMethods(items, modelMethods, inherited) {
  const seen = new Set();
  for (const method of modelMethods) {
    if (seen.has(method.name)) continue;
    seen.add(method.name);
    items.push(makeModelMethod(method));
  }
  for (const fn of inherited) {
    if (seen.has(fn.name)) continue;
    seen.add(fn.name);
    items.push(makeArMethod(fn));
  }
}

// Op-aware: coluna usa '.', relacao/metodo usa ':'.
function buildMemberItems(receiver) {
  const model = receiver.model;
  const items = [];

  if (receiver.op === '.') {
    if (receiver.kind === 'class') {
      pushMethods(items, model.methods.static, arMethods('static'));
    } else {
      for (const col of model.columns) items.push(makeColumn(model, col));
    }
    return items;
  }

  if (receiver.kind === 'class') {
    pushMethods(items, model.methods.static, arMethods('static'));
  } else {
    for (const rel of model.relations) items.push(makeRelation(rel));
    pushMethods(items, model.methods.instance, arMethods('instance'));
  }
  return items;
}

// ------------------------------------------------- completions da API do arken

function fnSignature(fn) {
  return fn.params.map(function (p) {
    return p.name + (p.optional ? '?' : '');
  }).join(', ');
}

function fnSnippet(fn) {
  if (!fn.params.length) return new vscode.SnippetString(fn.name + '()');
  const args = fn.params.map(function (p, i) {
    return '${' + (i + 1) + ':' + p.name + '}';
  }).join(', ');
  return new vscode.SnippetString(fn.name + '(' + args + ')');
}

function fnDoc(mod, fn, receiver) {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(fn.name + '(' + fnSignature(fn) + ')', 'lua');
  if (fn.project) {
    md.appendMarkdown('extensão de `' + (mod ? mod.name : 'tipo') + '` declarada no profile do projeto');
  } else if (fn.lua) {
    md.appendMarkdown('biblioteca `string` padrão do Lua');
  } else if (mod) {
    md.appendMarkdown('**' + mod.name + '** · ' +
      (mod.kind === 'binding' ? 'binding nativo do arken' :
       mod.kind === 'global' ? 'tabela global estendida pelo arken' : 'biblioteca Lua do arken'));
  }
  if (receiver && receiver.column) {
    md.appendMarkdown('\n\n`' + receiver.column.name + '` — ' + columnTypeLabel(receiver));
  }
  const typed = fn.params.filter(function (p) { return p.type; });
  if (typed.length) {
    md.appendMarkdown('\n\n' + typed.map(function (p) {
      return '- `' + p.name + '`: ' + p.type + (p.optional ? ' (opcional)' : '');
    }).join('\n'));
  }
  if (fn.returns) md.appendMarkdown('\n\nretorna `' + fn.returns + '`');
  if (fn.file) md.appendMarkdown('\n\n_' + fn.file + ':' + (fn.line + 1) + '_');
  return md;
}

function makeApiFunction(mod, fn, receiver) {
  const it = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
  it.detail = '(' + fnSignature(fn) + ') · ' +
    (fn.project ? 'profile do projeto' : fn.lua ? 'string do Lua' : (mod ? mod.name : 'arken'));
  it.documentation = fnDoc(mod, fn, receiver);
  it.insertText = fnSnippet(fn);
  it.sortText = (fn.project ? '0_' : fn.lua ? '2_' : '1_') + fn.name;
  return it;
}

// Membros visiveis num receiver da API: os do arken mais as extensoes de tipo
// declaradas no profile do projeto.
function membersOf(idx, receiver) {
  return resolver.apiMembers(receiver)
    .concat(resolver.builtinMembers(receiver))
    .concat(resolver.projectMembers(idx, receiver));
}

// Descricao do tipo de uma coluna, para o detalhe/hover.
function columnTypeLabel(receiver) {
  const col = receiver.column;
  const sql = col.format || col.sql || '?';
  if (receiver.converted) {
    return 'coluna ' + sql + " lida via read() → `" + receiver.lua + '`';
  }
  return 'coluna ' + sql + ' → valor `' + receiver.lua + '`' +
    (receiver.module ? ' (métodos de `' + receiver.module.name + '`)' : '');
}

function makeApiSubmodule(sub) {
  const short = sub.name.slice(sub.name.lastIndexOf('.') + 1);
  const it = new vscode.CompletionItem(short, vscode.CompletionItemKind.Module);
  it.detail = 'submódulo · ' + sub.name;
  it.documentation = new vscode.MarkdownString(
    sub.static.length + ' funções · ' + sub.instance.length + ' métodos de instância');
  it.sortText = '1_' + short;
  return it;
}

function apiMemberItems(idx, receiver) {
  const mod = receiver.module;
  const items = membersOf(idx, receiver).map(function (fn) {
    return makeApiFunction(mod, fn, receiver);
  });
  if (receiver.kind === 'class' && mod) {
    for (const sub of resolver.apiSubmodules(idx, mod)) items.push(makeApiSubmodule(sub));
  }
  return items;
}

// Modulos do arken oferecidos dentro de require('...').
function apiModuleItems(idx) {
  const api = idx.api;
  if (!api) return [];
  const items = [];
  for (const mod of api.modules.values()) {
    const it = new vscode.CompletionItem(mod.name, vscode.CompletionItemKind.Module);
    it.detail = mod.kind === 'binding' ? 'binding nativo do arken' : 'biblioteca Lua do arken';
    it.documentation = new vscode.MarkdownString(
      mod.static.length + ' funções · ' + mod.instance.length + ' métodos de instância' +
      (mod.file ? '\n\n_' + mod.file + '_' : ''));
    it.sortText = '2_' + mod.name;
    items.push(it);
  }
  return items;
}

function modelNameItems(idx) {
  const items = [];
  for (const className of idx.byClass.keys()) {
    const it = new vscode.CompletionItem(className, vscode.CompletionItemKind.Class);
    it.detail = 'model arken';
    items.push(it);
  }
  return items;
}

// Completions dentro de require('...'): lista de models, com o caminho inferido
// do nome da variavel (Pedido_Item -> Pedido.Item) pre-selecionado NO TOPO,
// mas SO se esse model existir no indice.
function requireItems(idx, linePrefix) {
  const items = [];
  const seen = new Set();

  const varName = resolver.localVarForRequire(linePrefix);
  if (varName) {
    const guessed = resolver.requirePathFromVar(varName);
    if (idx.byClass.has(guessed)) {
      const it = new vscode.CompletionItem(guessed, vscode.CompletionItemKind.Class);
      it.detail = 'model arken · inferido do nome da variável';
      it.preselect = true;
      it.sortText = '0_' + guessed;
      items.push(it);
      seen.add(guessed);
    }
  }

  for (const className of idx.byClass.keys()) {
    if (seen.has(className)) continue;
    const it = new vscode.CompletionItem(className, vscode.CompletionItemKind.Class);
    it.detail = 'model arken';
    it.sortText = '1_' + className;
    items.push(it);
  }
  return items.concat(apiModuleItems(idx));
}

function provideCompletion(document, position) {
  const idx = contextForFile(document.uri.fsPath);
  const linePrefix = document.lineAt(position).text.substr(0, position.character);

  // 5) dentro de require('...') -> caminhos de model (com inferencia do nome da var)
  if (resolver.inRequireString(linePrefix) !== null) {
    return requireItems(idx, linePrefix);
  }

  // 4) dentro de bloco de relacao: record= -> models ; foreignKey= -> colunas
  const relField = resolver.inRelationField(linePrefix);
  if (relField) {
    if (relField.field === 'record') return modelNameItems(idx);
    if (relField.field === 'foreignKey') {
      const model = modelOfFile(idx, document.uri.fsPath);
      if (model) return model.columns.map(function (c) { return makeColumn(model, c); });
    }
    return undefined;
  }

  // membro: <expr>. / <expr>:
  const receiver = resolver.resolve(idx, document.getText(), linePrefix);
  if (!receiver) return undefined;
  if (receiver.module || receiver.column) return apiMemberItems(idx, receiver);
  return buildMemberItems(receiver);
}

// ---------------------------------------------------------------- hover

function provideHover(document, position) {
  const idx = contextForFile(document.uri.fsPath);
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
  if (!range) return undefined;
  const word = document.getText(range);
  const linePrefix = document.lineAt(position).text.substr(0, range.end.character);
  const receiver = resolver.resolve(idx, document.getText(), linePrefix);
  if (!receiver) return undefined;

  if (receiver.module || receiver.column) {
    const fn = resolver.findFn(membersOf(idx, receiver), word);
    if (fn) return new vscode.Hover(fnDoc(receiver.module, fn, receiver), range);
    return receiver.column
      ? new vscode.Hover(new vscode.MarkdownString(columnTypeLabel(receiver)), range)
      : undefined;
  }

  const model = receiver.model;

  if (receiver.op === '.') {
    const col = findColumn(model, word);
    if (col) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown('`' + word + '` — coluna de `' + model.tableName + '`\n\n');
      md.appendMarkdown('tipo: `' + (col.format || col.sql) + '`' +
        (col.notNull ? ' · not null' : '') + (col.primaryKey ? ' · PK' : ''));
      const value = resolver.columnType(idx, model, col, false);
      if (value) {
        md.appendMarkdown('\n\nvalor: `' + value.lua + '`' +
          (value.module ? ' — `' + word + ':` completa os métodos de `' + value.module.name + '`'
                        : ' — sem métodos de instância'));
        const read = resolver.columnType(idx, model, col, true);
        if (read && read.converted) {
          md.appendMarkdown('\n\n`self:read(\'' + word + '\')` converte para `' + read.lua + '`');
        }
      }
      return new vscode.Hover(md, range);
    }
    const sm = findMethod(model.methods.static, word);
    if (sm) return new vscode.Hover(new vscode.MarkdownString(
      '`' + word + '(' + sm.params + ')` — método estático de `' + model.className + '`'), range);
    const ar = findMethod(arMethods('static'), word);
    if (ar) return new vscode.Hover(arDoc(ar), range);
  } else {
    const rel = findRelation(model, word);
    if (rel) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown('`' + word + '()` — **' + rel.kind + '** para `' + rel.record + '`');
      if (rel.foreignKey) md.appendMarkdown('\n\nforeignKey: `' + rel.foreignKey + '`');
      return new vscode.Hover(md, range);
    }
    const im = findMethod(model.methods.instance, word);
    if (im) return new vscode.Hover(new vscode.MarkdownString(
      '`' + word + '(' + im.params + ')` — método de instância de `' + model.className + '`'), range);
    const ar = findMethod(arMethods('instance'), word);
    if (ar) return new vscode.Hover(arDoc(ar), range);
  }
  return undefined;
}

// ---------------------------------------------------------------- definition

function loc(file, line) {
  return new vscode.Location(vscode.Uri.file(file), new vscode.Position(line || 0, 0));
}

function provideDefinition(document, position) {
  const idx = contextForFile(document.uri.fsPath);

  // 1a) string alvo: require('X') / record='X' -> arquivo do model ou do modulo arken
  const lineText = document.lineAt(position).text;
  const strTarget = resolver.stringTargetAt(lineText, position.character);
  if (strTarget) {
    const target = idx.byClass.get(strTarget.value);
    if (target) return loc(target.file, target.line);
    const mod = resolver.apiModule(idx, strTarget.value);
    return mod && mod.absFile ? loc(mod.absFile, 0) : undefined;
  }

  // 1b) membro sob o cursor
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
  if (!range) return undefined;
  const word = document.getText(range);
  const linePrefix = lineText.substr(0, range.end.character);
  const receiver = resolver.resolve(idx, document.getText(), linePrefix);
  if (!receiver) return undefined;

  if (receiver.module || receiver.column) {
    const fn = resolver.findFn(membersOf(idx, receiver), word);
    return fn && fn.absFile ? loc(fn.absFile, fn.line) : undefined;
  }

  const model = receiver.model;

  if (receiver.op === '.') {
    const col = findColumn(model, word);
    if (col) return model.schemaFile ? loc(model.schemaFile, col.line) : loc(model.file, model.line);
    const sm = findMethod(model.methods.static, word);
    if (sm) return loc(model.file, sm.line);
  } else {
    const rel = findRelation(model, word);
    if (rel) {
      const target = idx.byClass.get(rel.record);
      return target ? loc(target.file, target.line) : loc(model.file, rel.line);
    }
    const im = findMethod(model.methods.instance, word);
    if (im) return loc(model.file, im.line);
  }

  // metodo herdado do ActiveRecord -> lib/arken/ActiveRecord.lua
  const ar = findMethod(arMethods(receiver.op === '.' ? 'static' : 'instance'), word);
  return ar && ar.absFile ? loc(ar.absFile, ar.line) : undefined;
}

// ---------------------------------------------------------------- signature help

function makeSignatureHelp(label, params, activeParam, doc) {
  const help = new vscode.SignatureHelp();
  const sig = new vscode.SignatureInformation(label);
  sig.parameters = params.map(function (p) { return new vscode.ParameterInformation(p); });
  if (doc) sig.documentation = doc;
  help.signatures = [sig];
  help.activeSignature = 0;
  help.activeParameter = Math.min(activeParam, Math.max(0, params.length - 1));
  return help;
}

function provideSignatureHelp(document, position) {
  const idx = contextForFile(document.uri.fsPath);
  const linePrefix = document.lineAt(position).text.substr(0, position.character);
  const call = resolver.parseCall(linePrefix);
  if (!call) return undefined;
  const receiver = resolver.resolve(idx, document.getText(), call.receiverExpr + call.op);
  if (!receiver) return undefined;

  if (receiver.module || receiver.column) {
    const fn = resolver.findFn(membersOf(idx, receiver), call.method);
    if (!fn) return undefined;
    return makeSignatureHelp(
      call.method + '(' + fnSignature(fn) + ')',
      fn.params.map(function (p) { return p.name + (p.optional ? '?' : ''); }),
      call.activeParam,
      fnDoc(receiver.module, fn, receiver));
  }

  const model = receiver.model;
  const list = call.op === '.' ? model.methods.static : model.methods.instance;
  const method = findMethod(list, call.method);
  if (!method) {
    const ar = findMethod(arMethods(call.op === '.' ? 'static' : 'instance'), call.method);
    if (!ar) return undefined;
    return makeSignatureHelp(
      call.method + '(' + fnSignature(ar) + ')',
      ar.params.map(function (p) { return p.name; }),
      call.activeParam, arDoc(ar));
  }

  const params = method.params.length
    ? method.params.split(',').map(function (p) { return p.trim(); })
    : [];
  return makeSignatureHelp(call.method + '(' + method.params + ')', params, call.activeParam, null);
}

// ---------------------------------------------------------------- diagnostics

function refreshDiagnostics(document) {
  if (!diagnostics || !document || document.languageId !== 'lua') return;
  const mode = vscode.workspace.getConfiguration('arkenLsp').get('diagnostics') || 'relations';
  if (mode === 'off') { diagnostics.delete(document.uri); return; }
  const idx = indexForFile(document.uri.fsPath);
  if (!idx) { diagnostics.delete(document.uri); return; }

  const text = document.getText();
  const items = [];

  // record = 'X' apontando para model inexistente
  const reRecord = /record\s*=\s*['"]([\w.]+)['"]/g;
  let m;
  while ((m = reRecord.exec(text)) !== null) {
    if (!idx.byClass.has(m[1])) {
      const start = m.index + m[0].indexOf(m[1]);
      const range = new vscode.Range(document.positionAt(start), document.positionAt(start + m[1].length));
      items.push(new vscode.Diagnostic(range,
        "Model '" + m[1] + "' não encontrado no índice arken.",
        vscode.DiagnosticSeverity.Warning));
    }
  }

  // (opt-in) colunas: self.<x> lido que nao existe no schema nem como metodo/relacao
  if (mode === 'all') {
    const model = modelOfFile(idx, document.uri.fsPath);
    if (model && model.columns.length) {
      const known = new Set();
      model.columns.forEach(function (c) { known.add(c.name); });
      model.relations.forEach(function (r) { known.add(r.name); });
      model.methods.instance.forEach(function (x) { known.add(x.name); });
      model.methods.static.forEach(function (x) { known.add(x.name); });
      arMethods('instance').forEach(function (f) { known.add(f.name); });
      // atributos atribuidos no proprio arquivo (self.x = ...) contam como conhecidos
      let a;
      const reAssign = /self\.([A-Za-z_]\w*)\s*=/g;
      while ((a = reAssign.exec(text)) !== null) known.add(a[1]);

      const reRead = /\bself\.([A-Za-z_]\w*)/g;
      while ((m = reRead.exec(text)) !== null) {
        const after = text[m.index + m[0].length];
        if (after === '=' || after === '(') continue; // atribuicao ou chamada
        if (!known.has(m[1])) {
          const start = m.index + m[0].indexOf(m[1]);
          const range = new vscode.Range(document.positionAt(start), document.positionAt(start + m[1].length));
          items.push(new vscode.Diagnostic(range,
            "'" + m[1] + "' não é coluna do schema nem método/relação conhecido.",
            vscode.DiagnosticSeverity.Information));
        }
      }
    }
  }

  diagnostics.set(document.uri, items);
}

function scheduleDiagnostics(document) {
  const key = document.uri.toString();
  if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key));
  debounceTimers.set(key, setTimeout(function () {
    debounceTimers.delete(key);
    refreshDiagnostics(document);
  }, 300));
}

// ---------------------------------------------------------------- status bar

function apiStatusLine() {
  const a = getApi();
  return a.modules.size + ' módulos da API do arken (' +
    (a.arkenPath || 'catálogo embutido') + ')';
}

function updateStatus() {
  if (!statusBar) return;
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'lua') { statusBar.hide(); return; }
  const root = rootForFile(ed.document.uri.fsPath);
  if (!root) {
    statusBar.text = '$(database) Arken: definir projeto';
    statusBar.tooltip = 'Nenhum projeto arken detectado — clique para definir o caminho\n' +
      apiStatusLine();
    statusBar.command = 'arkenLsp.setProjectPath';
    statusBar.show();
    return;
  }
  const idx = getIndex(root);
  statusBar.text = '$(database) Arken: ' + path.basename(root) + ' (' + idx.byClass.size + ')';
  statusBar.tooltip = idx.byClass.size + ' models · ' + root + '\n' + apiStatusLine() +
    '\nClique para reindexar';
  statusBar.command = 'arkenLsp.reindex';
  statusBar.show();
}

// ---------------------------------------------------------------- watchers

function reindexModelFile(fsPath) {
  const root = findRootUpwards(path.dirname(fsPath));
  if (root && indexes.has(root)) {
    indexer.reindexFile(indexes.get(root), fsPath);
    log('reindex model: ' + path.basename(fsPath));
  }
}
function reindexSchemaFile(fsPath) {
  const root = findRootUpwards(path.dirname(fsPath));
  if (root && indexes.has(root)) {
    indexer.reindexSchema(indexes.get(root), fsPath);
    log('reindex schema: ' + path.basename(fsPath));
  }
}

function activate(context) {
  output = vscode.window.createOutputChannel('Arken ActiveRecord');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  diagnostics = vscode.languages.createDiagnosticCollection('arken');
  context.subscriptions.push(output, statusBar, diagnostics);

  const sel = { language: 'lua' };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(sel, { provideCompletionItems: provideCompletion }, '.', ':', "'", '"'),
    vscode.languages.registerHoverProvider(sel, { provideHover: provideHover }),
    vscode.languages.registerDefinitionProvider(sel, { provideDefinition: provideDefinition }),
    vscode.languages.registerSignatureHelpProvider(sel, { provideSignatureHelp: provideSignatureHelp }, '(', ',')
  );

  // watchers incrementais
  const modelWatcher = vscode.workspace.createFileSystemWatcher('**/app/models/**/*.lua');
  modelWatcher.onDidChange(function (uri) { reindexModelFile(uri.fsPath); });
  modelWatcher.onDidCreate(function (uri) { reindexModelFile(uri.fsPath); });
  modelWatcher.onDidDelete(function (uri) { reindexModelFile(uri.fsPath); });
  const schemaWatcher = vscode.workspace.createFileSystemWatcher('**/db/schema/*.json');
  schemaWatcher.onDidChange(function (uri) { reindexSchemaFile(uri.fsPath); });
  schemaWatcher.onDidCreate(function (uri) { reindexSchemaFile(uri.fsPath); });
  context.subscriptions.push(modelWatcher, schemaWatcher);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(function (doc) {
      if (doc.languageId === 'lua' && doc.uri.fsPath.includes(path.join('app', 'models'))) {
        reindexModelFile(doc.uri.fsPath);
      }
    }),
    vscode.workspace.onDidOpenTextDocument(function (doc) { refreshDiagnostics(doc); }),
    vscode.workspace.onDidChangeTextDocument(function (e) { scheduleDiagnostics(e.document); }),
    vscode.workspace.onDidCloseTextDocument(function (doc) { if (diagnostics) diagnostics.delete(doc.uri); }),
    vscode.window.onDidChangeActiveTextEditor(function (ed) {
      updateStatus();
      if (ed) refreshDiagnostics(ed.document);
    }),
    vscode.workspace.onDidChangeConfiguration(function (e) {
      if (e.affectsConfiguration('arkenLsp.arkenPath')) api = null;
      if (e.affectsConfiguration('arkenLsp')) {
        updateStatus();
        if (vscode.window.activeTextEditor) refreshDiagnostics(vscode.window.activeTextEditor.document);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('arkenLsp.setProjectPath', async function () {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Selecionar raiz do projeto arken'
      });
      if (!picked || !picked.length) return;
      const dir = picked[0].fsPath;
      if (!isArkenRoot(dir)) {
        const go = await vscode.window.showWarningMessage(
          'A pasta não parece um projeto arken (falta app/models). Usar assim mesmo?', 'Usar', 'Cancelar');
        if (go !== 'Usar') return;
      }
      const target = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length)
        ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('arkenLsp').update('projectPath', dir, target);
      indexes.delete(dir);
      const idx = getIndex(dir);
      updateStatus();
      vscode.window.showInformationMessage('Arken: projeto = ' + dir + ' (' + (idx ? idx.byClass.size : 0) + ' models).');
    }),
    vscode.commands.registerCommand('arkenLsp.reindex', function () {
      const ed = vscode.window.activeTextEditor;
      const root = ed ? rootForFile(ed.document.uri.fsPath) : null;
      if (!root) { vscode.window.showWarningMessage('Arken: nenhum projeto detectado para o arquivo atual.'); return; }
      indexes.delete(root);
      const idx = getIndex(root);
      updateStatus();
      if (ed) refreshDiagnostics(ed.document);
      vscode.window.showInformationMessage('Arken: reindexado ' + path.basename(root) + ' (' + idx.byClass.size + ' models).');
    }),
    vscode.commands.registerCommand('arkenLsp.showIndexStats', function () {
      const ed = vscode.window.activeTextEditor;
      const root = ed ? rootForFile(ed.document.uri.fsPath) : null;
      if (!root) { vscode.window.showWarningMessage('Arken: nenhum projeto detectado para o arquivo atual.'); return; }
      const idx = getIndex(root);
      let rels = 0, cols = 0, meth = 0;
      for (const model of idx.byClass.values()) {
        rels += model.relations.length;
        cols += model.columns.length;
        meth += model.methods.instance.length + model.methods.static.length;
      }
      const a = getApi();
      let fns = 0;
      for (const mod of a.modules.values()) fns += mod.static.length + mod.instance.length;
      for (const g of a.globals.values()) fns += g.static.length;
      vscode.window.showInformationMessage(
        'Arken (' + path.basename(root) + '): ' + idx.byClass.size + ' models · ' +
        rels + ' relações · ' + cols + ' colunas · ' + meth + ' métodos · API do arken: ' +
        a.modules.size + ' módulos / ' + fns + ' funções.');
      output.show();
    }),
    vscode.commands.registerCommand('arkenLsp.reloadArkenApi', function () {
      api = null;
      const a = getApi();
      let fns = 0;
      for (const mod of a.modules.values()) fns += mod.static.length + mod.instance.length;
      for (const g of a.globals.values()) fns += g.static.length;
      vscode.window.showInformationMessage(
        'Arken: API recarregada — ' + a.modules.size + ' módulos, ' + fns + ' funções' +
        (a.arkenPath ? ' (fonte: ' + a.arkenPath + ')' : ' (catálogo empacotado)') + '.');
    }),
    vscode.commands.registerCommand('arkenLsp.setArkenPath', async function () {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        openLabel: 'Selecionar a raiz do arken (src/bindings + lib/arken)'
      });
      if (!picked || !picked.length) return;
      const dir = picked[0].fsPath;
      if (!arkenapi.isArkenSource(dir)) {
        vscode.window.showWarningMessage(
          'A pasta não parece o código do arken (faltam src/bindings e lib/arken).');
        return;
      }
      const target = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length)
        ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('arkenLsp').update('arkenPath', dir, target);
      api = null;
      const a = getApi();
      vscode.window.showInformationMessage(
        'Arken: API lida de ' + dir + ' (' + a.modules.size + ' módulos).');
    })
  );

  updateStatus();
  if (vscode.window.activeTextEditor) refreshDiagnostics(vscode.window.activeTextEditor.document);
  log('extensão ativada.');
}

function deactivate() {}

module.exports = { activate, deactivate };
