'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const indexer = require('./indexer');
const resolver = require('./resolver');

// Um indice por projeto arken (chave = raiz do projeto). Construido sob demanda.
const indexes = new Map();
let output = null;
let statusBar = null;
let diagnostics = null;
const debounceTimers = new Map();

function log(msg) {
  if (output) output.appendLine('[arken] ' + msg);
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
  return indexes.get(root);
}

function indexForFile(filePath) {
  return getIndex(rootForFile(filePath));
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

function makeArMethod(name) {
  const it = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
  it.detail = 'ActiveRecord';
  it.insertText = new vscode.SnippetString(name + '($0)');
  it.sortText = '2_' + name;
  return it;
}

function pushMethods(items, modelMethods, arMethods) {
  const seen = new Set();
  for (const method of modelMethods) {
    if (seen.has(method.name)) continue;
    seen.add(method.name);
    items.push(makeModelMethod(method));
  }
  for (const name of arMethods) {
    if (seen.has(name)) continue;
    seen.add(name);
    items.push(makeArMethod(name));
  }
}

// Op-aware: coluna usa '.', relacao/metodo usa ':'.
function buildMemberItems(receiver) {
  const model = receiver.model;
  const items = [];

  if (receiver.op === '.') {
    if (receiver.kind === 'class') {
      pushMethods(items, model.methods.static, indexer.AR_CLASS_METHODS);
    } else {
      for (const col of model.columns) items.push(makeColumn(model, col));
    }
    return items;
  }

  if (receiver.kind === 'class') {
    pushMethods(items, model.methods.static, indexer.AR_CLASS_METHODS);
  } else {
    for (const rel of model.relations) items.push(makeRelation(rel));
    pushMethods(items, model.methods.instance, indexer.AR_INSTANCE_METHODS);
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
  return items;
}

function provideCompletion(document, position) {
  const idx = indexForFile(document.uri.fsPath);
  if (!idx) return undefined;
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
  return buildMemberItems(receiver);
}

// ---------------------------------------------------------------- hover

function provideHover(document, position) {
  const idx = indexForFile(document.uri.fsPath);
  if (!idx) return undefined;
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
  if (!range) return undefined;
  const word = document.getText(range);
  const linePrefix = document.lineAt(position).text.substr(0, range.end.character);
  const receiver = resolver.resolve(idx, document.getText(), linePrefix);
  if (!receiver) return undefined;
  const model = receiver.model;

  if (receiver.op === '.') {
    const col = findColumn(model, word);
    if (col) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown('`' + word + '` — coluna de `' + model.tableName + '`\n\n');
      md.appendMarkdown('tipo: `' + (col.format || col.sql) + '`' +
        (col.notNull ? ' · not null' : '') + (col.primaryKey ? ' · PK' : ''));
      return new vscode.Hover(md, range);
    }
    const sm = findMethod(model.methods.static, word);
    if (sm) return new vscode.Hover(new vscode.MarkdownString(
      '`' + word + '(' + sm.params + ')` — método estático de `' + model.className + '`'), range);
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
  }
  return undefined;
}

// ---------------------------------------------------------------- definition

function loc(file, line) {
  return new vscode.Location(vscode.Uri.file(file), new vscode.Position(line || 0, 0));
}

function provideDefinition(document, position) {
  const idx = indexForFile(document.uri.fsPath);
  if (!idx) return undefined;

  // 1a) string alvo: require('X') / record='X' -> arquivo do model
  const lineText = document.lineAt(position).text;
  const strTarget = resolver.stringTargetAt(lineText, position.character);
  if (strTarget) {
    const target = idx.byClass.get(strTarget.value);
    return target ? loc(target.file, target.line) : undefined;
  }

  // 1b) membro sob o cursor
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
  if (!range) return undefined;
  const word = document.getText(range);
  const linePrefix = lineText.substr(0, range.end.character);
  const receiver = resolver.resolve(idx, document.getText(), linePrefix);
  if (!receiver) return undefined;
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
  return undefined;
}

// ---------------------------------------------------------------- signature help

function provideSignatureHelp(document, position) {
  const idx = indexForFile(document.uri.fsPath);
  if (!idx) return undefined;
  const linePrefix = document.lineAt(position).text.substr(0, position.character);
  const call = resolver.parseCall(linePrefix);
  if (!call) return undefined;
  const receiver = resolver.resolve(idx, document.getText(), call.receiverExpr + call.op);
  if (!receiver) return undefined;
  const model = receiver.model;

  const list = call.op === '.' ? model.methods.static : model.methods.instance;
  const method = findMethod(list, call.method);
  if (!method) return undefined;

  const help = new vscode.SignatureHelp();
  const sig = new vscode.SignatureInformation(call.method + '(' + method.params + ')');
  const params = method.params.length
    ? method.params.split(',').map(function (p) { return p.trim(); })
    : [];
  sig.parameters = params.map(function (p) { return new vscode.ParameterInformation(p); });
  help.signatures = [sig];
  help.activeSignature = 0;
  help.activeParameter = Math.min(call.activeParam, Math.max(0, params.length - 1));
  return help;
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
      indexer.AR_INSTANCE_METHODS.forEach(function (n) { known.add(n); });
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

function updateStatus() {
  if (!statusBar) return;
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'lua') { statusBar.hide(); return; }
  const root = rootForFile(ed.document.uri.fsPath);
  if (!root) {
    statusBar.text = '$(database) Arken: definir projeto';
    statusBar.tooltip = 'Nenhum projeto arken detectado — clique para definir o caminho';
    statusBar.command = 'arkenLsp.setProjectPath';
    statusBar.show();
    return;
  }
  const idx = getIndex(root);
  statusBar.text = '$(database) Arken: ' + path.basename(root) + ' (' + idx.byClass.size + ')';
  statusBar.tooltip = idx.byClass.size + ' models · ' + root + '\nClique para reindexar';
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
      vscode.window.showInformationMessage(
        'Arken (' + path.basename(root) + '): ' + idx.byClass.size + ' models · ' +
        rels + ' relações · ' + cols + ' colunas · ' + meth + ' métodos.');
      output.show();
    })
  );

  updateStatus();
  if (vscode.window.activeTextEditor) refreshDiagnostics(vscode.window.activeTextEditor.document);
  log('extensão ativada.');
}

function deactivate() {}

module.exports = { activate, deactivate };
