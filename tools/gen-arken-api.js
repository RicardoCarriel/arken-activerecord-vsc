#!/usr/bin/env node
'use strict';
// Gera data/arken-api.json a partir de um checkout do arken.
//
//   node tools/gen-arken-api.js [caminho-do-arken]
//
// Sem argumento usa $ARKEN_PATH e depois ../arken.

const fs = require('fs');
const path = require('path');
const arkenapi = require('../src/arkenapi');

const candidates = [
  process.argv[2],
  process.env.ARKEN_PATH,
  path.resolve(__dirname, '..', '..', 'arken')
].filter(Boolean);

const arkenPath = candidates.find(arkenapi.isArkenSource);
if (!arkenPath) {
  console.error('nao achei um checkout do arken (src/bindings + lib/arken) em:');
  candidates.forEach(function (c) { console.error('  ' + c); });
  process.exit(1);
}

const catalog = arkenapi.scan(arkenPath);
// O caminho da maquina de quem gerou nao vai para o pacote: em runtime o
// arkenPath vem da configuracao/deteccao do usuario.
delete catalog.arkenPath;

const outDir = path.resolve(__dirname, '..', 'data');
const outFile = path.join(outDir, 'arken-api.json');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(catalog, null, 1) + '\n');

let stat = 0, inst = 0;
for (const name of Object.keys(catalog.modules)) {
  stat += catalog.modules[name].static.length;
  inst += catalog.modules[name].instance.length;
}
let glob = 0;
for (const name of Object.keys(catalog.globals)) glob += catalog.globals[name].static.length;

console.log('fonte : ' + arkenPath);
console.log('saida : ' + outFile + ' (' + (fs.statSync(outFile).size / 1024).toFixed(1) + ' KB)');
console.log('modulos: ' + Object.keys(catalog.modules).length +
            ' · estaticos: ' + stat + ' · instancia: ' + inst);
console.log('globais: ' + Object.keys(catalog.globals).join(', ') + ' (' + glob + ' funcoes)');
