'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const indexer = require('./indexer');
const resolver = require('./resolver');

let index = null;
let output = null;

function log(msg) {
  if (output) output.appendLine('[arken] ' + msg);
}

// Descobre a raiz do fusion2: setting explicito ou pasta da workspace que
// contenha app/models e db/schema.
function detectFusionPath() {
  const cfg = vscode.workspace.getConfiguration('arkenLsp').get('fusionPath');
  if (cfg && cfg.trim() !== '') return cfg.trim();
  const folders = vscode.workspace.workspaceFolders || [];
  for (const f of folders) {
    const root = f.uri.fsPath;
    if (fs.existsSync(path.join(root, 'app', 'models')) &&
        fs.existsSync(path.join(root, 'db', 'schema'))) {
      return root;
    }
  }
  return folders.length ? folders[0].uri.fsPath : null;
}

function rebuild() {
  const fusionPath = detectFusionPath();
  if (!fusionPath) {
    log('Nao encontrei a raiz do fusion2 (app/models + db/schema).');
    index = null;
    return;
  }
  const t0 = Date.now();
  index = indexer.buildIndex(fusionPath);
  log('Indice construido em ' + (Date.now() - t0) + 'ms: ' +
      index.byClass.size + ' models a partir de ' + fusionPath);
}

function columnDetail(col) {
  const parts = [col.format || col.sql || '?'];
  if (col.primaryKey) parts.push('PK');
  if (col.notNull) parts.push('not null');
  return parts.join(' · ');
}

function buildCompletionItems(receiver) {
  const model = receiver.model;
  const items = [];

  // colunas
  for (const col of model.columns) {
    const it = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
    it.detail = columnDetail(col);
    it.documentation = new vscode.MarkdownString(
      '**coluna** de `' + model.tableName + '`'
    );
    it.sortText = '1_' + col.name;
    items.push(it);
  }

  // relacoes
  for (const rel of model.relations) {
    const it = new vscode.CompletionItem(rel.name, vscode.CompletionItemKind.Reference);
    it.detail = rel.kind + ' → ' + rel.record;
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**' + rel.kind + '** para `' + rel.record + '`');
    if (rel.foreignKey) md.appendMarkdown('\n\nforeignKey: `' + rel.foreignKey + '`');
    it.documentation = md;
    it.sortText = '0_' + rel.name;
    items.push(it);
  }

  // metodos do ActiveRecord
  const methods = receiver.kind === 'class'
    ? indexer.AR_CLASS_METHODS
    : indexer.AR_INSTANCE_METHODS;
  for (const name of methods) {
    const it = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
    it.detail = 'ActiveRecord';
    it.sortText = '2_' + name;
    items.push(it);
  }

  return items;
}

function activate(context) {
  output = vscode.window.createOutputChannel('Arken ActiveRecord');
  context.subscriptions.push(output);
  rebuild();

  const completion = vscode.languages.registerCompletionItemProvider(
    { language: 'lua' },
    {
      provideCompletionItems(document, position) {
        if (!index) return undefined;
        const linePrefix = document.lineAt(position).text.substr(0, position.character);
        const receiver = resolver.resolve(index, document.getText(), linePrefix);
        if (!receiver) return undefined;
        return buildCompletionItems(receiver);
      }
    },
    '.'
  );
  context.subscriptions.push(completion);

  const hover = vscode.languages.registerHoverProvider(
    { language: 'lua' },
    {
      provideHover(document, position) {
        if (!index) return undefined;
        const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
        if (!range) return undefined;
        const word = document.getText(range);
        // prefixo ate o fim da palavra sob o cursor
        const linePrefix = document.lineAt(position).text.substr(0, range.end.character);
        const receiver = resolver.resolve(index, document.getText(), linePrefix);
        if (!receiver) return undefined;
        const model = receiver.model;
        const col = model.columns.find(function (c) { return c.name === word; });
        if (col) {
          const md = new vscode.MarkdownString();
          md.appendMarkdown('`' + word + '` — coluna de `' + model.tableName + '`\n\n');
          md.appendMarkdown('tipo: `' + (col.format || col.sql) + '`' +
            (col.notNull ? ' · not null' : '') + (col.primaryKey ? ' · PK' : ''));
          return new vscode.Hover(md, range);
        }
        const rel = model.relations.find(function (r) { return r.name === word; });
        if (rel) {
          const md = new vscode.MarkdownString();
          md.appendMarkdown('`' + word + '` — **' + rel.kind + '** para `' + rel.record + '`');
          if (rel.foreignKey) md.appendMarkdown('\n\nforeignKey: `' + rel.foreignKey + '`');
          return new vscode.Hover(md, range);
        }
        return undefined;
      }
    }
  );
  context.subscriptions.push(hover);

  // watchers incrementais: models e schema
  const modelWatcher = vscode.workspace.createFileSystemWatcher('**/app/models/**/*.lua');
  const onModel = function (uri) {
    if (!index) return;
    indexer.reindexFile(index, uri.fsPath);
    log('reindex model: ' + path.basename(uri.fsPath));
  };
  modelWatcher.onDidChange(onModel);
  modelWatcher.onDidCreate(onModel);
  modelWatcher.onDidDelete(function (uri) {
    if (index) indexer.reindexFile(index, uri.fsPath);
  });
  context.subscriptions.push(modelWatcher);

  const schemaWatcher = vscode.workspace.createFileSystemWatcher('**/db/schema/*.json');
  const onSchema = function (uri) {
    if (index) {
      indexer.reindexSchema(index, uri.fsPath);
      log('reindex schema: ' + path.basename(uri.fsPath));
    }
  };
  schemaWatcher.onDidChange(onSchema);
  schemaWatcher.onDidCreate(onSchema);
  context.subscriptions.push(schemaWatcher);

  // reindexa o buffer aberto ao salvar (pega edicoes ainda nao no disco via watcher)
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(function (doc) {
    if (index && doc.languageId === 'lua' && doc.uri.fsPath.includes(path.join('app', 'models'))) {
      indexer.reindexFile(index, doc.uri.fsPath);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('arkenLsp.reindex', function () {
    rebuild();
    vscode.window.showInformationMessage('Arken: indice reconstruido (' +
      (index ? index.byClass.size : 0) + ' models).');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('arkenLsp.showIndexStats', function () {
    if (!index) {
      vscode.window.showWarningMessage('Arken: indice nao construido.');
      return;
    }
    let rels = 0, cols = 0;
    for (const m of index.byClass.values()) {
      rels += m.relations.length;
      cols += m.columns.length;
    }
    vscode.window.showInformationMessage(
      'Arken: ' + index.byClass.size + ' models · ' + rels + ' relacoes · ' + cols + ' colunas.'
    );
    output.show();
  }));

  log('extensao ativada.');
}

function deactivate() {}

module.exports = { activate, deactivate };
