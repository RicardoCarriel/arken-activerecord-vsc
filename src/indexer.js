'use strict';
// Indexador puro (sem dependência do 'vscode'). Varre app/models e db/schema
// e constroi um grafo em memoria: Model -> { colunas, relacoes, metodos },
// cada um com o numero da linha (para go-to-definition) e parametros.

const fs = require('fs');
const path = require('path');

// Metodos de instancia do ActiveRecord expostos a completar num record.
const AR_INSTANCE_METHODS = [
  'save', 'update', 'destroy', 'reload', 'dup', 'populate', 'validate',
  'changes', 'was', 'read', 'get', 'set', 'cacheKey', 'fileUpload',
  'config', 'tcall'
];

// Metodos estaticos/de classe (acessados via a classe retornada por require).
const AR_CLASS_METHODS = [
  'find', 'where', 'new', 'first', 'last', 'all', 'count', 'select', 'create'
];

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

// Lookup de linha (0-based) a partir de um offset, via posicoes de '\n'.
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

function pick(block, key) {
  const re = new RegExp(key + "\\s*=\\s*['\"]([^'\"]+)['\"]");
  const m = block.match(re);
  return m ? m[1] : null;
}

// Relacoes: hasMany { name='x', record='A.B', foreignKey='y' }
function parseRelations(source, lineAt) {
  const relations = [];
  const re = /\.(hasMany|hasOne|belongsTo)\s*(\{[^}]*\})/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const name = pick(m[2], 'name');
    const record = pick(m[2], 'record');
    if (name && record) {
      relations.push({
        name: name,
        kind: m[1],
        record: record,
        foreignKey: pick(m[2], 'foreignKey') || null,
        line: lineAt(m.index)
      });
    }
  }
  return relations;
}

// className + variavel local do Class.new (os metodos usam essa variavel).
function parseModelHeader(source) {
  const m = source.match(
    /local\s+([A-Za-z_]\w*)\s*=\s*Class\.new\(\s*['"]([\w.]+)['"]\s*,\s*['"]ActiveRecord['"]\s*\)/
  );
  if (m) return { className: m[2], classVar: m[1], index: m.index };
  const c = source.match(/Class\.new\(\s*['"]([^'"]+)['"]\s*,\s*['"]ActiveRecord['"]\s*\)/);
  return c ? { className: c[1], classVar: null, index: c.index } : null;
}

// Metodos definidos no model, com params e linha.
//   instancia: function <var>:nome(params)
//   estatico : function <var>.nome(p)   |   <var>.nome = function(p)
function parseMethods(source, classVar, lineAt) {
  const instance = [];
  const staticM = [];
  if (!classVar) return { instance: instance, static: staticM };
  const v = classVar;
  const seenI = new Set();
  const seenS = new Set();
  let m;

  const reInst = new RegExp('function\\s+' + v + '\\s*:\\s*([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)', 'g');
  while ((m = reInst.exec(source)) !== null) {
    if (seenI.has(m[1])) continue;
    seenI.add(m[1]);
    instance.push({ name: m[1], params: m[2].trim(), line: lineAt(m.index) });
  }

  const reStaticFn = new RegExp('function\\s+' + v + '\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)', 'g');
  while ((m = reStaticFn.exec(source)) !== null) {
    if (seenS.has(m[1])) continue;
    seenS.add(m[1]);
    staticM.push({ name: m[1], params: m[2].trim(), line: lineAt(m.index) });
  }

  const reStaticAssign = new RegExp(v + '\\s*\\.\\s*([A-Za-z_]\\w*)\\s*=\\s*function\\s*\\(([^)]*)\\)', 'g');
  while ((m = reStaticAssign.exec(source)) !== null) {
    if (seenS.has(m[1])) continue;
    seenS.add(m[1]);
    staticM.push({ name: m[1], params: m[2].trim(), line: lineAt(m.index) });
  }

  return { instance: instance, static: staticM };
}

// Carrega colunas do schema JSON, com a linha de cada coluna no arquivo.
function loadSchema(projectPath, tableName) {
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
    return { file: file, columns: [] };
  }
  const lineAt = makeLineLookup(raw);
  const cols = json && json.columns ? json.columns : {};
  const columns = Object.keys(cols).map(function (name) {
    const c = cols[name] || {};
    const at = raw.indexOf('"' + name + '"');
    return {
      name: name,
      format: c.format || null,
      sql: c.sql || null,
      notNull: !!c.notNull,
      primaryKey: !!c.primaryKey,
      default: c.default,
      line: at >= 0 ? lineAt(at) : 0
    };
  });
  return { file: file, columns: columns };
}

function buildModel(projectPath, file, source) {
  const header = parseModelHeader(source);
  if (!header) return null;
  const className = header.className;
  const tableName = underscore(className);
  const lineAt = makeLineLookup(source);
  const schema = loadSchema(projectPath, tableName);
  return {
    className: className,
    tableName: tableName,
    file: file,
    line: lineAt(header.index),
    schemaFile: schema ? schema.file : null,
    relations: parseRelations(source, lineAt),
    columns: schema ? schema.columns : [],
    methods: parseMethods(source, header.classVar, lineAt)
  };
}

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
    const model = buildModel(projectPath, file, source);
    if (!model) continue;
    byClass.set(model.className, model);
    byTable.set(model.tableName, model.className);
    byFile.set(path.resolve(file), model.className);
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
    return null;
  }
  const model = buildModel(index.projectPath, file, source);
  if (!model) return null;
  index.byClass.set(model.className, model);
  index.byTable.set(model.tableName, model.className);
  index.byFile.set(resolved, model.className);
  return model;
}

function reindexSchema(index, schemaFile) {
  const base = path.basename(schemaFile, '.json');
  const className = index.byTable.get(base);
  if (!className) return null;
  const model = index.byClass.get(className);
  if (!model) return null;
  const schema = loadSchema(index.projectPath, base);
  model.columns = schema ? schema.columns : [];
  model.schemaFile = schema ? schema.file : null;
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
