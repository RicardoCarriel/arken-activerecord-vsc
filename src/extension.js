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

function log(msg) {
  if (output) output.appendLine('[arken] ' + msg);
}

// Marcador de raiz de projeto arken: tem app/models e algum sinal de config/db.
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

// Sobe a partir de startDir ate achar a raiz de um projeto arken.
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

// Descobre a qual projeto arken pertence um arquivo.
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

// Retorna (e cacheia) o indice de um projeto.
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

function makeMethod(name, detail, sortPrefix) {
  const it = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
  it.detail = detail;
  it.insertText = new vscode.SnippetString(name + '($0)');
  it.sortText = sortPrefix + name;
  return it;
}

// Adiciona metodos do model e depois os do ActiveRecord, sem duplicar nomes.
function pushMethods(items, modelMethods, arMethods) {
  const seen = new Set();
  for (const name of modelMethods) {
    if (seen.has(name)) continue;
    seen.add(name);
    items.push(makeMethod(name, 'método do model', '1_'));
  }
  for (const name of arMethods) {
    if (seen.has(name)) continue;
    seen.add(name);
    items.push(makeMethod(name, 'ActiveRecord', '2_'));
  }
}

// Op-aware: coluna usa '.', relacao/metodo usa ':'.
function buildCompletionItems(receiver) {
  const model = receiver.model;
  const items = [];

  if (receiver.op === '.') {
    if (receiver.kind === 'class') {
      pushMethods(items, model.staticMethods || [], indexer.AR_CLASS_METHODS);
    } else {
      for (const col of model.columns) items.push(makeColumn(model, col));
    }
    return items;
  }

  if (receiver.kind === 'class') {
    pushMethods(items, model.staticMethods || [], indexer.AR_CLASS_METHODS);
  } else {
    for (const rel of model.relations) items.push(makeRelation(rel));
    pushMethods(items, model.instanceMethods || [], indexer.AR_INSTANCE_METHODS);
  }
  return items;
}

function updateStatus() {
  if (!statusBar) return;
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== 'lua') {
    statusBar.hide();
    return;
  }
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
  context.subscriptions.push(output);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusBar);

  const completion = vscode.languages.registerCompletionItemProvider(
    { language: 'lua' },
    {
      provideCompletionItems(document, position) {
        const idx = indexForFile(document.uri.fsPath);
        if (!idx) return undefined;
        const linePrefix = document.lineAt(position).text.substr(0, position.character);
        const receiver = resolver.resolve(idx, document.getText(), linePrefix);
        if (!receiver) return undefined;
        return buildCompletionItems(receiver);
      }
    },
    '.', ':'
  );
  context.subscriptions.push(completion);

  const hover = vscode.languages.registerHoverProvider(
    { language: 'lua' },
    {
      provideHover(document, position) {
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
          const col = model.columns.find(function (c) { return c.name === word; });
          if (col) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown('`' + word + '` — coluna de `' + model.tableName + '`\n\n');
            md.appendMarkdown('tipo: `' + (col.format || col.sql) + '`' +
              (col.notNull ? ' · not null' : '') + (col.primaryKey ? ' · PK' : ''));
            return new vscode.Hover(md, range);
          }
        } else {
          const rel = model.relations.find(function (r) { return r.name === word; });
          if (rel) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown('`' + word + '()` — **' + rel.kind + '** para `' + rel.record + '`');
            if (rel.foreignKey) md.appendMarkdown('\n\nforeignKey: `' + rel.foreignKey + '`');
            return new vscode.Hover(md, range);
          }
          if ((model.instanceMethods || []).indexOf(word) !== -1) {
            return new vscode.Hover(new vscode.MarkdownString(
              '`' + word + '()` — método de instância de `' + model.className + '`'), range);
          }
        }
        if ((model.staticMethods || []).indexOf(word) !== -1) {
          return new vscode.Hover(new vscode.MarkdownString(
            '`' + word + '()` — método estático de `' + model.className + '`'), range);
        }
        return undefined;
      }
    }
  );
  context.subscriptions.push(hover);

  // watchers globais: acham o projeto dono do arquivo e reindexam so o cache dele
  const modelWatcher = vscode.workspace.createFileSystemWatcher('**/app/models/**/*.lua');
  modelWatcher.onDidChange(function (uri) { reindexModelFile(uri.fsPath); });
  modelWatcher.onDidCreate(function (uri) { reindexModelFile(uri.fsPath); });
  modelWatcher.onDidDelete(function (uri) { reindexModelFile(uri.fsPath); });
  context.subscriptions.push(modelWatcher);

  const schemaWatcher = vscode.workspace.createFileSystemWatcher('**/db/schema/*.json');
  schemaWatcher.onDidChange(function (uri) { reindexSchemaFile(uri.fsPath); });
  schemaWatcher.onDidCreate(function (uri) { reindexSchemaFile(uri.fsPath); });
  context.subscriptions.push(schemaWatcher);

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(function (doc) {
    if (doc.languageId === 'lua' && doc.uri.fsPath.includes(path.join('app', 'models'))) {
      reindexModelFile(doc.uri.fsPath);
    }
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(function () {
    updateStatus();
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (e) {
    if (e.affectsConfiguration('arkenLsp')) updateStatus();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('arkenLsp.setProjectPath', async function () {
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
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('arkenLsp').update('projectPath', dir, target);
    indexes.delete(dir);
    const idx = getIndex(dir);
    updateStatus();
    vscode.window.showInformationMessage('Arken: projeto = ' + dir + ' (' + (idx ? idx.byClass.size : 0) + ' models).');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('arkenLsp.reindex', function () {
    const ed = vscode.window.activeTextEditor;
    const root = ed ? rootForFile(ed.document.uri.fsPath) : null;
    if (!root) {
      vscode.window.showWarningMessage('Arken: nenhum projeto detectado para o arquivo atual.');
      return;
    }
    indexes.delete(root);
    const idx = getIndex(root);
    updateStatus();
    vscode.window.showInformationMessage(
      'Arken: reindexado ' + path.basename(root) + ' (' + idx.byClass.size + ' models).');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('arkenLsp.showIndexStats', function () {
    const ed = vscode.window.activeTextEditor;
    const root = ed ? rootForFile(ed.document.uri.fsPath) : null;
    if (!root) {
      vscode.window.showWarningMessage('Arken: nenhum projeto detectado para o arquivo atual.');
      return;
    }
    const idx = getIndex(root);
    let rels = 0, cols = 0;
    for (const m of idx.byClass.values()) {
      rels += m.relations.length;
      cols += m.columns.length;
    }
    vscode.window.showInformationMessage(
      'Arken (' + path.basename(root) + '): ' + idx.byClass.size + ' models · ' +
      rels + ' relações · ' + cols + ' colunas.');
    output.show();
  }));

  updateStatus();
  log('extensão ativada.');
}

function deactivate() {}

module.exports = { activate, deactivate };
