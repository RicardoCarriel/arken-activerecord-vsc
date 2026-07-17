'use strict';
// Indexador puro (sem dependência do 'vscode'). Varre app/models e db/schema
// e constroi um grafo em memoria: Model -> { colunas, relacoes, metodos }.
// Este modulo e o "cerebro" e pode ser movido para dentro de um LSP depois.

const fs = require('fs');
const path = require('path');

// Metodos de instancia do ActiveRecord expostos a completar num record.
// (extraidos de arken/lib/arken/ActiveRecord.lua + lib/ext/ActiveRecord.lua)
const AR_INSTANCE_METHODS = [
  'save', 'update', 'destroy', 'reload', 'dup', 'populate', 'validate',
  'changes', 'was', 'read', 'get', 'set', 'cacheKey', 'fileUpload',
  'config', 'tcall'
];

// Metodos estaticos/de classe (acessados via a classe retornada por require).
const AR_CLASS_METHODS = [
  'find', 'where', 'new', 'first', 'last', 'all', 'count', 'select', 'create'
];

// Replica arken String:underscore() -> quebra CamelCase e pontos, minusculo.
// "Pedido.Regra" -> pedido_regra ; "CrossDocking" -> cross_docking
function underscore(className) {
  return className
    .split('.')
    .map(function (seg) {
      return seg
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
    })
    .join('_')
    .toLowerCase();
}

function walkLuaFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkLuaFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.lua')) {
      out.push(full);
    }
  }
  return out;
}

// Extrai as relacoes de um bloco: hasMany { name='x', record='A.B', ... }
function parseRelations(source) {
  const relations = [];
  const re = /\.(hasMany|hasOne|belongsTo)\s*(\{[^}]*\})/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const kind = m[1];
    const block = m[2];
    const name = pick(block, 'name');
    const record = pick(block, 'record');
    const foreignKey = pick(block, 'foreignKey');
    if (name && record) {
      relations.push({ name, kind, record, foreignKey: foreignKey || null });
    }
  }
  return relations;
}

function pick(block, key) {
  const re = new RegExp(key + "\\s*=\\s*['\"]([^'\"]+)['\"]");
  const m = block.match(re);
  return m ? m[1] : null;
}

function parseClassName(source) {
  const m = source.match(/Class\.new\(\s*['"]([^'"]+)['"]\s*,\s*['"]ActiveRecord['"]\s*\)/);
  return m ? m[1] : null;
}

function loadColumns(projectPath, tableName) {
  const file = path.join(projectPath, 'db', 'schema', tableName + '.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  const cols = json && json.columns ? json.columns : {};
  return Object.keys(cols).map(function (name) {
    const c = cols[name] || {};
    return {
      name: name,
      format: c.format || null,
      sql: c.sql || null,
      notNull: !!c.notNull,
      primaryKey: !!c.primaryKey,
      default: c.default
    };
  });
}

// Constroi o indice completo a partir da raiz de um projeto arken.
function buildIndex(projectPath) {
  const modelsDir = path.join(projectPath, 'app', 'models');
  const files = walkLuaFiles(modelsDir, []);
  const byClass = new Map();
  const byTable = new Map();
  const byFile = new Map();

  for (const file of files) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (e) {
      continue;
    }
    const className = parseClassName(source);
    if (!className) continue;
    const tableName = underscore(className);
    const model = {
      className: className,
      tableName: tableName,
      file: file,
      relations: parseRelations(source),
      columns: loadColumns(projectPath, tableName) || []
    };
    byClass.set(className, model);
    byTable.set(tableName, className);
    byFile.set(path.resolve(file), className);
  }

  return {
    projectPath: projectPath,
    byClass: byClass,
    byTable: byTable,
    byFile: byFile,
    AR_INSTANCE_METHODS: AR_INSTANCE_METHODS,
    AR_CLASS_METHODS: AR_CLASS_METHODS
  };
}

// Re-parseia um unico arquivo de model e atualiza o indice (incremental).
function reindexFile(index, file) {
  const resolved = path.resolve(file);
  const prevClass = index.byFile.get(resolved);
  if (prevClass) {
    const prev = index.byClass.get(prevClass);
    if (prev) index.byTable.delete(prev.tableName);
    index.byClass.delete(prevClass);
    index.byFile.delete(resolved);
  }
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null; // arquivo removido
  }
  const className = parseClassName(source);
  if (!className) return null;
  const tableName = underscore(className);
  const model = {
    className: className,
    tableName: tableName,
    file: file,
    relations: parseRelations(source),
    columns: loadColumns(index.projectPath, tableName) || []
  };
  index.byClass.set(className, model);
  index.byTable.set(tableName, className);
  index.byFile.set(resolved, className);
  return model;
}

// Recarrega as colunas de um schema alterado, achando o model dono.
function reindexSchema(index, schemaFile) {
  const base = path.basename(schemaFile, '.json');
  const className = index.byTable.get(base);
  if (!className) return null;
  const model = index.byClass.get(className);
  if (!model) return null;
  model.columns = loadColumns(index.projectPath, base) || [];
  return model;
}

module.exports = {
  underscore,
  buildIndex,
  reindexFile,
  reindexSchema,
  AR_INSTANCE_METHODS,
  AR_CLASS_METHODS
};
