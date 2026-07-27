'use strict';
// Teste headless (sem VSCode): valida indexer + resolver contra o fusion2 real,
// e o catalogo da API do arken contra o checkout do arken.
const path = require('path');
const indexer = require('../src/indexer');
const resolver = require('../src/resolver');
const arkenapi = require('../src/arkenapi');

const FUSION = process.argv[2] || '/Users/rcarriel/Projetos/fusion2';
const ARKEN = process.argv[3] || process.env.ARKEN_PATH || '/Users/rcarriel/Projetos/arken';

function assert(cond, msg) {
  if (!cond) { console.error('  FALHOU: ' + msg); process.exitCode = 1; }
  else { console.log('  ok: ' + msg); }
}

console.log('== underscore ==');
assert(indexer.underscore('Pedido.Regra') === 'pedido_regra', 'Pedido.Regra -> pedido_regra');
assert(indexer.underscore('CrossDocking') === 'cross_docking', 'CrossDocking -> cross_docking');
assert(indexer.underscore('Web.Whatsapp.Template') === 'web_whatsapp_template', 'Web.Whatsapp.Template');

console.log('== build index ==');
const t0 = Date.now();
const index = indexer.buildIndex(FUSION);
console.log('  ' + index.byClass.size + ' models em ' + (Date.now() - t0) + 'ms');
assert(index.byClass.size > 500, 'indexou > 500 models');

const regra = index.byClass.get('Pedido.Regra');
assert(!!regra, 'achou model Pedido.Regra');
if (regra) {
  console.log('  Pedido.Regra: ' + regra.columns.length + ' colunas, ' +
              regra.relations.length + ' relacoes -> ' +
              regra.relations.map(function (r) { return r.name; }).join(', '));
  assert(regra.columns.length > 0, 'Pedido.Regra tem colunas do schema');
  assert(regra.relations.some(function (r) { return r.name === 'items'; }), 'tem relacao items');
}

console.log('== resolver: self.coluna (ponto) ==');
const docSelf =
  'local Pedido_Regra = Class.new("Pedido.Regra", "ActiveRecord")\n' +
  'Pedido_Regra.foo = function(self)\n' +
  '  return self.';
let r = resolver.resolve(index, docSelf, '  return self.');
assert(r && r.model.className === 'Pedido.Regra', 'self. resolve para Pedido.Regra');
assert(r && r.op === '.', 'op = "." em self.');

console.log('== resolver: self:relacao (dois-pontos) ==');
r = resolver.resolve(index, docSelf.replace(/self\.$/, 'self:'), '  return self:');
assert(r && r.op === ':' && r.kind === 'instance', 'self: -> op ":" instance');

console.log('== resolver: require class var (Regra.) ==');
const docReq =
  "local Regra = require('Pedido.Regra')\n" +
  'local x = Regra.';
r = resolver.resolve(index, docReq, 'local x = Regra.');
assert(r && r.model.className === 'Pedido.Regra', 'Regra. (require) resolve para Pedido.Regra');
assert(r && r.kind === 'class', 'kind = class para var de require');

console.log('== resolver: instancia via find (reg.) ==');
const docInst =
  "local Regra = require('Pedido.Regra')\n" +
  'local reg = Regra.find{ id = 1 }\n' +
  'print(reg.';
r = resolver.resolve(index, docInst, 'print(reg.');
assert(r && r.model.className === 'Pedido.Regra', 'reg. (find) resolve para Pedido.Regra');
assert(r && r.kind === 'instance', 'kind = instance para resultado de find');

console.log('== resolver: navegacao por relacao (reg:items()[1]:) ==');
const relRecord = regra ? (regra.relations.find(function (r) { return r.name === 'items'; }) || {}).record : null;
console.log('  items -> ' + relRecord);
const prefixChainRel = 'print(reg:items()[1]:';
r = resolver.resolve(index, "local Regra = require('Pedido.Regra')\nlocal reg = Regra.find{ id = 1 }\n" + prefixChainRel, prefixChainRel);
assert(r && r.model.className === relRecord, 'reg:items()[1]: navega para ' + relRecord);
assert(r && r.op === ':', 'op = ":" no fim da cadeia');

console.log('== resolver: coluna apos relacao (reg:items()[1].) ==');
const prefixChainCol = 'print(reg:items()[1].';
r = resolver.resolve(index, "local Regra = require('Pedido.Regra')\nlocal reg = Regra.find{ id = 1 }\n" + prefixChainCol, prefixChainCol);
assert(r && r.model.className === relRecord, 'reg:items()[1]. -> ' + relRecord);
assert(r && r.op === '.', 'op = "." para coluna do item');

function hasMethod(list, name) { return list.some(function (x) { return x.name === name; }); }
function getMethod(list, name) { return list.find(function (x) { return x.name === name; }); }

console.log('== metodos do model (Empresa) com params/linha ==');
const empresa = index.byClass.get('Empresa');
assert(!!empresa, 'achou model Empresa');
if (empresa) {
  console.log('  instancia: ' + empresa.methods.instance.length + ' · estaticos: ' + empresa.methods.static.length);
  assert(hasMethod(empresa.methods.instance, 'executarRotinasIntegracao'),
    'Empresa tem metodo de instancia executarRotinasIntegracao');
  assert(hasMethod(empresa.methods.static, 'where'), 'Empresa tem metodo estatico where');
  assert(hasMethod(empresa.methods.static, 'writeLogInfoRotina'), 'Empresa tem estatico writeLogInfoRotina');
  const eri = getMethod(empresa.methods.instance, 'executarRotinasIntegracao');
  console.log('  executarRotinasIntegracao(' + eri.params + ') @ linha ' + (eri.line + 1));
  assert(eri.params === 'params', 'capturou params de executarRotinasIntegracao');
  assert(eri.line > 0, 'capturou a linha do metodo');
  assert(empresa.line >= 0, 'capturou a linha do Class.new');
}

console.log('== colunas com linha e schemaFile ==');
if (regra) {
  assert(!!regra.schemaFile, 'Pedido.Regra tem schemaFile');
  assert(regra.columns.every(function (c) { return typeof c.line === 'number'; }), 'colunas tem linha');
}

console.log('== cenario do usuario: self:empresa():<metodo> em Pedido ==');
const pedido = index.byClass.get('Pedido');
const relEmpresa = pedido ? (pedido.relations.find(function (r) { return r.name === 'empresa'; }) || {}).record : null;
console.log('  Pedido empresa -> ' + relEmpresa);
const docPed =
  'local Pedido = Class.new("Pedido", "ActiveRecord")\n' +
  'Pedido.foo = function(self)\n' +
  '  self:empresa():';
r = resolver.resolve(index, docPed, '  self:empresa():');
assert(r && r.model.className === 'Empresa', 'self:empresa(): resolve para Empresa');
assert(r && hasMethod(r.model.methods.instance, 'executarRotinasIntegracao'),
  'completa executarRotinasIntegracao() apos self:empresa():');

console.log('== helpers dos novos providers ==');
const call = resolver.parseCall('  self:empresa():executarRotinasIntegracao(a, b');
assert(call && call.op === ':' && call.method === 'executarRotinasIntegracao', 'parseCall extrai metodo');
assert(call && call.activeParam === 1, 'parseCall conta o parametro ativo (b -> 1)');
assert(call && call.receiverExpr === '  self:empresa()', 'parseCall isola o receiver');

const st = resolver.stringTargetAt("  record     = 'Empresa'", 20);
assert(st && st.kind === 'record' && st.value === 'Empresa', 'stringTargetAt pega record=Empresa');
const st2 = resolver.stringTargetAt("local X = require('Pedido.Regra')", 25);
assert(st2 && st2.kind === 'require' && st2.value === 'Pedido.Regra', 'stringTargetAt pega require');

assert(resolver.inRequireString("local X = require('Pedi") === 'Pedi', 'inRequireString retorna parcial');
const rf = resolver.inRelationField("   record = 'Emp");
assert(rf && rf.field === 'record' && rf.partial === 'Emp', 'inRelationField detecta record=');

console.log('== require inteligente (nome da variavel -> caminho) ==');
assert(resolver.localVarForRequire("local Pedido_Regra = require('") === 'Pedido_Regra',
  'localVarForRequire pega o nome da variavel');
assert(resolver.localVarForRequire("local Pedido_Regra = require('Ped") === 'Pedido_Regra',
  'localVarForRequire funciona com parcial ja digitado');
assert(resolver.localVarForRequire("require('") === null,
  'localVarForRequire null sem declaracao local');
assert(resolver.requirePathFromVar('Pedido_Regra') === 'Pedido.Regra',
  'requirePathFromVar converte _ em .');
assert(index.byClass.has(resolver.requirePathFromVar('Pedido_Regra')),
  'o caminho inferido Pedido.Regra existe no indice (checagem de existencia)');
assert(!index.byClass.has(resolver.requirePathFromVar('Coisa_Inexistente')),
  'caminho inferido inexistente nao passaria na checagem');

// ---------------------------------------------------------------- API do arken

console.log('\n== catalogo da API do arken ==');
const catalog = arkenapi.isArkenSource(ARKEN)
  ? arkenapi.prepare(arkenapi.scan(ARKEN), ARKEN)
  : arkenapi.loadFile(path.join(__dirname, '..', 'data', 'arken-api.json'), null);
console.log('  fonte: ' + (catalog.arkenPath || 'catalogo empacotado') +
            ' · ' + catalog.modules.size + ' modulos');
assert(catalog.modules.size > 50, 'catalogo com > 50 modulos');
assert(catalog.globals.has('os') && catalog.globals.has('string'),
  'globais os e string do arken presentes');

function fnNames(list) { return list.map(function (f) { return f.name; }); }

const b64 = catalog.modules.get('arken.base64');
assert(!!b64 && fnNames(b64.static).join(',') === 'encode,decode', 'arken.base64: encode e decode');
assert(b64 && b64.static[0].params.length === 1 && b64.static[0].params[0].type === 'string',
  'base64.encode(data: string) com tipo do luaL_checkstring');

const date = catalog.modules.get('arken.chrono.Date');
assert(!!date, 'achou arken.chrono.Date');
assert(date && fnNames(date.static).indexOf('today') >= 0, 'Date.today e estatico');
assert(date && fnNames(date.instance).indexOf('strftime') >= 0, 'Date:strftime e de instancia');
assert(date && (resolver.findFn(date.static, 'today') || {}).returns === 'arken.chrono.Date',
  'Date.today() retorna arken.chrono.Date');

const httpc = catalog.modules.get('arken.net.HttpClient');
assert(httpc && fnNames(httpc.instance).indexOf('performGet') >= 0,
  'HttpClient tem performGet de instancia');
assert(httpc && (resolver.findFn(httpc.static, 'new') || {}).returns === 'arken.net.HttpClient',
  'HttpClient.new() retorna instancia');

const array = catalog.modules.get('arken.Array');
assert(array && array.kind === 'lua', 'arken.Array vem das libs Lua');
assert(array && fnNames(array.instance).indexOf('each') >= 0, 'Array:each mapeado');

const osGlobal = catalog.globals.get('os');
assert(osGlobal && fnNames(osGlobal.static).indexOf('glob') >= 0, 'global os.glob do arken');
assert(!!catalog.modules.get('arken.odebug'), 'metatable "odebug" normalizada para arken.odebug');

console.log('== resolver com a API do arken ==');
index.api = catalog;

function res(doc, prefix) { return resolver.resolve(index, doc, prefix); }

const docB64 = "local base64 = require('arken.base64')\nlocal x = base64.";
r = res(docB64, 'local x = base64.');
assert(r && r.module && r.module.name === 'arken.base64', 'base64. resolve para arken.base64');
assert(r && r.kind === 'class', 'require de modulo do arken -> kind class');
assert(r && resolver.apiMembers(r).some(function (f) { return f.name === 'encode'; }),
  'completa encode apos base64.');

const docDate =
  "local Date = require('arken.chrono.Date')\n" +
  'local hoje = Date.today()\n' +
  'print(hoje:';
r = res(docDate, 'print(hoje:');
assert(r && r.module && r.module.name === 'arken.chrono.Date' && r.kind === 'instance',
  'hoje: (de Date.today()) resolve para instancia de Date');
assert(r && resolver.apiMembers(r).some(function (f) { return f.name === 'strftime'; }),
  'completa strftime na instancia de Date');

const chainDate = "local Date = require('arken.chrono.Date')\nprint(Date.today():addDays(1):";
r = res(chainDate, 'print(Date.today():addDays(1):');
assert(r && r.module && r.module.name === 'arken.chrono.Date' && r.kind === 'instance',
  'encadeia Date.today():addDays(1): -> instancia de Date');

const docHttp =
  "local HttpClient = require('arken.net.HttpClient')\n" +
  "local client = HttpClient.new('http://x')\n" +
  'client:';
r = res(docHttp, 'client:');
assert(r && r.module && r.module.name === 'arken.net.HttpClient' && r.kind === 'instance',
  'client: (de HttpClient.new) resolve para instancia de HttpClient');

r = res('local list = os.', 'local list = os.');
assert(r && r.module && r.module.name === 'os', 'os. resolve para a tabela global os do arken');

const docLog = "local log = require('arken.Log').new('/tmp/x.log')\nlog:";
r = res(docLog, 'log:');
assert(r && r.module && r.module.name === 'arken.Log' && r.kind === 'instance',
  "require('arken.Log').new(f) -> instancia de Log");
assert(r && resolver.apiMembers(r).some(function (f) { return f.name === 'info'; }),
  'completa info na instancia de Log');

const docInline = "local reg = require('Pedido.Regra').find{ id = 1 }\nreg.";
r = res(docInline, 'reg.');
assert(r && r.model && r.model.className === 'Pedido.Regra' && r.kind === 'instance',
  "require('Pedido.Regra').find{...} -> instancia do model");

const docMvm = "local mvm = require('arken.mvm')\nmvm.";
r = res(docMvm, 'mvm.');
assert(r && r.module && r.module.name === 'arken.mvm', 'mvm. resolve para arken.mvm');
assert(r && resolver.apiMembers(r).some(function (f) { return f.name === 'path'; }),
  'arken.mvm expõe path()');

console.log('== submodulos (arken.concurrent.task.*) ==');
const docTask = "local task = require('arken.concurrent.task')\ntask.singular.";
r = res(docTask, 'task.singular.');
assert(r && r.module && r.module.name === 'arken.concurrent.task.singular',
  'task.singular. navega para o submodulo');
const taskMod = catalog.modules.get('arken.concurrent.task');
assert(resolver.apiSubmodules(index, taskMod).length >= 5,
  'arken.concurrent.task expõe os submódulos (fifo, priority, singular...)');

console.log('== metodos do ActiveRecord lidos do arken ==');
const ar = catalog.activeRecord;
assert(!!ar && ar.static.length > 15, 'extraiu > 15 métodos estáticos do ActiveRecord');
assert(fnNames(ar.static).indexOf('where') >= 0 && fnNames(ar.static).indexOf('sum') >= 0,
  'ActiveRecord.where e .sum presentes');
const sum = resolver.findFn(ar.static, 'sum');
assert(sum && sum.params.length === 2 && sum.params[0].name === 'column',
  'sum(column, params) com os parametros reais');
assert(fnNames(ar.instance).indexOf('save') >= 0 && fnNames(ar.instance).indexOf('populate') >= 0,
  'ActiveRecord:save e :populate presentes');
assert(indexer.AR_CLASS_METHODS.every(function (n) {
  return fnNames(ar.static).indexOf(n) >= 0 || ['new', 'first', 'select'].indexOf(n) >= 0;
}), 'lista embutida coberta pelo catalogo (menos os vindos do Class/metatable)');

console.log('== tipo da coluna -> metodos do arken ==');
const docCol =
  'local Pedido_Regra = Class.new("Pedido.Regra", "ActiveRecord")\n' +
  'function Pedido_Regra:foo()\n';
function col(prefix) { return resolver.resolve(index, docCol + prefix, prefix); }

r = col('  self.descricao:');
assert(r && r.module && r.module.name === 'arken.string',
  'coluna string -> métodos de arken.string');
assert(r && r.lua === 'string' && r.column && r.column.name === 'descricao',
  'receiver carrega a coluna e o tipo Lua');
assert(r && resolver.apiMembers(r).some(function (f) { return f.name === 'camelCase'; }),
  'completa camelCase numa coluna string');

r = col('  self.id:');
assert(r && r.column && r.lua === 'number' && r.module === null,
  'coluna number: tipo number, sem métodos de instância');
assert(r && resolver.apiMembers(r).length === 0, 'number não oferece métodos (math é estático)');

r = col('  self.cancelado:');
assert(r && r.lua === 'boolean' && r.module === null, 'coluna boolean sem métodos');

// date/datetime ficam como STRING crua no campo (Adapter.*ParserValue).
r = col('  self.created_at:');
assert(r && r.module && r.module.name === 'arken.string' && r.lua === 'string',
  'coluna datetime no campo é string, não Date');

r = col("  self:read('created_at'):");
assert(r && r.module && r.module.name === 'arken.chrono.Time' && r.converted,
  "read('created_at') converte datetime -> arken.chrono.Time");
r = col("  self:get('created_at', nil):");
assert(r && r.module && r.module.name === 'arken.chrono.Time',
  "get('col', default) também resolve, ignorando os demais argumentos");
assert(r && resolver.apiMembers(r).some(function (f) { return f.name === 'strftime'; }),
  'completa strftime no datetime convertido');

const comData = [...index.byClass.values()].find(function (mo) {
  return mo.columns.some(function (c) { return c.format === 'date'; });
});
if (comData) {
  const dc = comData.columns.find(function (c) { return c.format === 'date'; });
  const t = resolver.columnType(index, comData, dc, true);
  assert(t && t.module && t.module.name === 'arken.chrono.Date',
    "read() de coluna date -> arken.chrono.Date (" + comData.className + '.' + dc.name + ')');
}

r = col('  self.descricao:');
assert(r && resolver.projectMembers(index, r).some(function (f) { return f.name === 'toDate'; }),
  'extensões do config/profile.lua entram no tipo string (toDate)');
assert(resolver.projectMembers(index, r).every(function (f) {
  return f.params.length === 0 || f.params[0].name !== 'value';
}), 'o self é removido dos parâmetros da extensão em contexto de instância');

console.log('  string: ' + resolver.apiMembers(col('  self.descricao:')).length + ' do arken + ' +
  resolver.projectMembers(index, col('  self.descricao:')).length + ' do projeto');

r = col('  self.descricao:');
assert(resolver.builtinMembers(r).some(function (f) { return f.name === 'gsub'; }),
  'string do Lua (gsub/lower/upper) também entra na lista da coluna');
assert(resolver.builtinMembers(col('  self.id:')).length === 0,
  'number não recebe os métodos de string do Lua');
assert(resolver.projectMembers(index, r).some(function (f) { return f.name === 'toasc'; }),
  'extensões de lib/ext/string.lua entram no tipo (toasc)');

console.log('== extensoes globais do profile.d do arken ==');
assert(!!resolver.findFn(catalog.globals.get('os').static, 'exec'),
  'os.exec do profile.d do arken entrou nos globais');
assert(!!catalog.globals.get('table'), 'table.shuffle do profile.d criou a global table');

console.log('== globais publicadas pelo profile do projeto ==');
assert(index.globalAliases && index.globalAliases.DateTime === 'arken.chrono.Time',
  "profile.lua: DateTime = require('arken.chrono.Time')");
r = res('local x = DateTime.', 'local x = DateTime.');
assert(r && r.module && r.module.name === 'arken.chrono.Time',
  'DateTime. resolve para arken.chrono.Time sem require local');
r = res('local x = JSON.', 'local x = JSON.');
assert(r && r.module && r.module.name === 'arken.jsonp', 'JSON. resolve para arken.jsonp');
r = res("local d = DateTime.parse('2026-01-01')\nd:", 'd:');
assert(r && r.module && r.module.name === 'arken.chrono.Time' && r.kind === 'instance',
  'DateTime.parse(...) devolve instância de Time');

console.log('== API nao atrapalha os models ==');
r = res(docReq, 'local x = Regra.');
assert(r && r.model && r.model.className === 'Pedido.Regra', 'model continua resolvendo apos a API');
r = res("local Foo = require('Nao.Existe')\nFoo.", 'Foo.');
assert(r === null, 'require desconhecido continua devolvendo null');

console.log('\nConcluido.');
