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

console.log('\nConcluido.');
