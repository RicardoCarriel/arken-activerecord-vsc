'use strict';
// Teste headless (sem VSCode): valida indexer + resolver contra o fusion2 real.
const indexer = require('../src/indexer');
const resolver = require('../src/resolver');

const FUSION = process.argv[2] || '/Users/rcarriel/Projetos/fusion2';

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

console.log('\nConcluido.');
