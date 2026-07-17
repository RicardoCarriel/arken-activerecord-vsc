'use strict';
// Resolvedor de tipo: dado o documento e o prefixo da linha ate o cursor,
// descobre a qual model o acesso se refere e QUAL operador ('.' ou ':') foi
// usado. No arken:
//   coluna  -> propriedade com ponto:      reg.descricao
//   relacao -> metodo com dois-pontos:     reg:items()   (class[name]=function(self))
//   metodo  -> tambem dois-pontos:         reg:save()
// Encadeamento: reg:items()[1]:produto()  /  reg:items()[1].id

function scanLocals(docText) {
  const locals = new Map();

  // local X = require('A.B')  -> classe
  const reReq = /local\s+([A-Za-z_]\w*)\s*=\s*require\(\s*['"]([\w.]+)['"]\s*\)/g;
  let m;
  while ((m = reReq.exec(docText)) !== null) {
    locals.set(m[1], { className: m[2], kind: 'class' });
  }

  // local X = Class.new('A.B', 'ActiveRecord') -> classe (model do arquivo)
  const reClass = /local\s+([A-Za-z_]\w*)\s*=\s*Class\.new\(\s*['"]([\w.]+)['"]/g;
  while ((m = reClass.exec(docText)) !== null) {
    locals.set(m[1], { className: m[2], kind: 'class' });
  }

  // local r = <Var>.find{...} / :new(...) / :first(...) -> instancia do model de <Var>
  const reInst = /local\s+([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)[.:](find|new|first|last|all|create|where)\b/g;
  while ((m = reInst.exec(docText)) !== null) {
    const target = locals.get(m[2]);
    if (target) {
      locals.set(m[1], { className: target.className, kind: 'instance' });
    }
  }

  return locals;
}

// className do model declarado neste arquivo (para resolver 'self').
function selfClassName(docText) {
  const m = docText.match(/Class\.new\(\s*['"]([\w.]+)['"]\s*,\s*['"]ActiveRecord['"]\s*\)/);
  return m ? m[1] : null;
}

// Separa o operador final ('.'/':') e o que ja foi digitado depois dele.
// Retorna { op, partial, receiverExpr } ou null.
function parseAccess(linePrefix) {
  const m = linePrefix.match(/([.:])\s*([A-Za-z0-9_]*)$/);
  if (!m) return null;
  return {
    op: m[1],
    partial: m[2],
    receiverExpr: linePrefix.slice(0, m.index)
  };
}

// A partir do fim de receiverExpr, extrai a cadeia de acesso que forma o
// receiver: base + segmentos ".nome" / ":nome()" (ignorando () e [..]).
// Ex.: "print(reg:items()[1]:produto()" -> ['reg','items','produto']
function extractChain(receiverExpr) {
  const tail = receiverExpr.match(
    /([A-Za-z_]\w*)((?:\s*[.:]\s*[A-Za-z_]\w*\s*(?:\(\s*\))?\s*(?:\[[^\]]*\])?)*)\s*$/
  );
  if (!tail) return null;
  const chain = [tail[1]];
  const re = /[.:]\s*([A-Za-z_]\w*)/g;
  let m;
  while ((m = re.exec(tail[2])) !== null) chain.push(m[1]);
  return chain;
}

// Resolve o receiver: { model, kind, op, partial } ou null.
function resolve(index, docText, linePrefix) {
  const acc = parseAccess(linePrefix);
  if (!acc) return null;

  const chain = extractChain(acc.receiverExpr);
  if (!chain || chain.length === 0) return null;

  const locals = scanLocals(docText);
  const base = chain[0];
  const steps = chain.slice(1);

  let className = null;
  let kind = 'instance';

  if (base === 'self') {
    className = selfClassName(docText);
    kind = 'instance';
  } else if (locals.has(base)) {
    const l = locals.get(base);
    className = l.className;
    kind = l.kind;
  } else {
    return null;
  }

  if (!className) return null;
  let model = index.byClass.get(className);
  if (!model) return null;

  for (const step of steps) {
    const rel = model.relations.find(function (r) { return r.name === step; });
    if (!rel) return null; // parou num metodo/coluna/nome desconhecido
    const next = index.byClass.get(rel.record);
    if (!next) return null;
    model = next;
    kind = 'instance';
  }

  return { model: model, kind: kind, op: acc.op, partial: acc.partial };
}

// --- helpers para os providers (signature/definition/completions contextuais) ---

// Chamada em andamento: "<receiver>:metodo(arg1, arg" -> resolve receiver + metodo.
// Retorna { receiverExpr, op, method, activeParam } ou null.
function parseCall(linePrefix) {
  const m = linePrefix.match(/([.:])\s*([A-Za-z_]\w*)\s*\(([^()]*)$/);
  if (!m) return null;
  const argsText = m[3];
  return {
    receiverExpr: linePrefix.slice(0, m.index),
    op: m[1],
    method: m[2],
    activeParam: argsText.length ? argsText.split(',').length - 1 : 0
  };
}

// Cursor dentro de uma string alvo de navegacao: require('X') ou record='X'.
// Retorna { kind: 'require'|'record', value } se o char estiver na string.
function stringTargetAt(lineText, character) {
  const re = /(require\s*\(\s*|record\s*=\s*)['"]([\w.]+)['"]/g;
  let m;
  while ((m = re.exec(lineText)) !== null) {
    const quote = m.index + m[1].length;      // posicao da aspa de abertura
    const start = quote + 1;
    const end = start + m[2].length;           // fim do valor (exclusivo)
    if (character >= start && character <= end) {
      return { kind: m[1].indexOf('require') === 0 ? 'require' : 'record', value: m[2] };
    }
  }
  return null;
}

// Cursor digitando dentro de require('...') -> retorna o parcial ja digitado.
function inRequireString(linePrefix) {
  const m = linePrefix.match(/require\s*\(\s*['"]([\w.]*)$/);
  return m ? m[1] : null;
}

// Nome da variavel local imediatamente antes do require, se o cursor esta
// dentro do require('...'). Ex.: "local Pedido_Item = require('" -> "Pedido_Item".
function localVarForRequire(linePrefix) {
  const m = linePrefix.match(/\blocal\s+([A-Za-z_]\w*)\s*=\s*require\s*\(\s*['"][\w.]*$/);
  return m ? m[1] : null;
}

// Caminho de require inferido a partir do nome da variavel: '_' vira '.'.
// "Pedido_Item" -> "Pedido.Item" ; "Empresa" -> "Empresa"
function requirePathFromVar(varName) {
  return varName.split('_').join('.');
}

// Cursor digitando dentro de um campo de bloco de relacao (record/foreignKey/name).
// Retorna { field, partial } ou null.
function inRelationField(linePrefix) {
  const m = linePrefix.match(/\b(record|foreignKey|name)\s*=\s*['"]([\w.]*)$/);
  return m ? { field: m[1], partial: m[2] } : null;
}

module.exports = {
  resolve, scanLocals, extractChain, parseAccess, selfClassName,
  parseCall, stringTargetAt, inRequireString, inRelationField,
  localVarForRequire, requirePathFromVar
};
