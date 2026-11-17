'use strict';
// Teste portavel (sem VSCode, sem projeto real): roda contra test/fixtures/loja
// e o catalogo empacotado em data/arken-api.json. E o que roda no CI.
const path = require('path');
const indexer = require('../src/indexer');
const resolver = require('../src/resolver');
const arkenapi = require('../src/arkenapi');

const LOJA = path.join(__dirname, 'fixtures', 'loja');

function assert(cond, msg) {
  if (!cond) { console.error('  FALHOU: ' + msg); process.exitCode = 1; }
  else { console.log('  ok: ' + msg); }
}

function names(list) { return list.map(function (x) { return x.name; }).join(','); }

console.log('== indexer ==');
const index = indexer.buildIndex(LOJA);
assert([...index.byClass.keys()].sort().join(',') === 'Cliente,Pedido,Pedido.Item', 'indexou os 3 models');
assert(index.byTable.get('pedido_item') === 'Pedido.Item', 'Pedido.Item -> tabela pedido_item');

const cliente = index.byClass.get('Cliente');
assert(names(cliente.columns) === 'id,nome,sobrenome,nascimento,ativo', 'colunas de Cliente vindas do schema');
assert(cliente.columns[1].notNull === true, 'nome e notNull');
assert(cliente.columns[0].primaryKey === true, 'id e primaryKey');
assert(names(cliente.relations) === 'pedidos', 'Cliente hasMany pedidos');
assert(cliente.relations[0].record === 'Pedido' && cliente.relations[0].kind === 'hasMany', 'relacao pedidos -> Pedido (hasMany)');
assert(names(cliente.methods.instance) === 'nomeCompleto', 'metodo de instancia nomeCompleto');
assert(cliente.methods.instance[0].params === 'separador', 'params de nomeCompleto');
assert(cliente.methods.instance[0].line === 4, 'linha de nomeCompleto');
assert(names(cliente.methods.static) === 'ativos', 'metodo estatico ativos');

const pedido = index.byClass.get('Pedido');
assert(names(pedido.relations) === 'cliente,itens', 'Pedido belongsTo cliente e hasMany itens');
assert(names(pedido.methods.static) === 'abertos', 'estatico por atribuicao (Pedido.abertos = function)');

console.log('== extensoes e globais do projeto ==');
assert(names(index.extensions.string).split(',').sort().join(',') === 'maiusculo,semEspacos',
  'string.semEspacos (profile) e string.maiusculo (lib/ext)');
assert(index.globalAliases.DateTime === 'arken.chrono.Time', 'DateTime = require(arken.chrono.Time)');

console.log('== resolver: models ==');
const docBase = "local Cliente = require('Cliente')\nlocal c = Cliente.find{ id = 1 }\n";

let r = resolver.resolve(index, docBase + 'print(c.', 'print(c.');
assert(r && r.model.className === 'Cliente' && r.kind === 'instance' && r.op === '.', 'c. (find) -> instancia de Cliente');

r = resolver.resolve(index, docBase + 'print(c:pedidos()[1]:itens()[1].', 'print(c:pedidos()[1]:itens()[1].');
assert(r && r.model.className === 'Pedido.Item', 'navega Cliente -> pedidos -> itens');

r = resolver.resolve(index, "local Cliente = require('Cliente')\nCliente.", 'Cliente.');
assert(r && r.model.className === 'Cliente' && r.kind === 'class', 'Cliente. -> classe');

const docSelf = 'local Pedido = Class.new("Pedido", "ActiveRecord")\nfunction Pedido:x()\n  self:cliente():';
r = resolver.resolve(index, docSelf, '  self:cliente():');
assert(r && r.model.className === 'Cliente', 'self:cliente(): dentro de Pedido -> Cliente');

console.log('== resolver: helpers ==');
const call = resolver.parseCall('  c:nomeCompleto(a, b');
assert(call && call.method === 'nomeCompleto' && call.activeParam === 1, 'parseCall: metodo e parametro ativo');
const st = resolver.stringTargetAt("  record = 'Cliente'", 14);
assert(st && st.kind === 'record' && st.value === 'Cliente', 'stringTargetAt pega record=Cliente');
assert(resolver.localVarForRequire("local Pedido_Item = require('") === 'Pedido_Item', 'localVarForRequire');

console.log('== catalogo empacotado da API do arken ==');
const catalog = arkenapi.loadFile(path.join(__dirname, '..', 'data', 'arken-api.json'), null);
assert(catalog.modules.has('arken.base64') && catalog.modules.has('arken.chrono.Date'), 'catalogo tem base64 e chrono.Date');
index.api = catalog;

r = resolver.resolve(index, "local base64 = require('arken.base64')\nlocal x = base64.", 'local x = base64.');
assert(r && r.module && r.module.name === 'arken.base64', 'base64. resolve para arken.base64');

r = resolver.resolve(index, "local Date = require('arken.chrono.Date')\nprint(Date.today():", 'print(Date.today():');
assert(r && r.module && r.module.name === 'arken.chrono.Date' && r.kind === 'instance', 'Date.today(): -> instancia de Date');

console.log(process.exitCode ? '\nFalhou.' : '\nConcluido.');
