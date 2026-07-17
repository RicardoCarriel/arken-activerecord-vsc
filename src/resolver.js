'use strict';
// Resolvedor de tipo: dado o documento e o prefixo da linha ate o cursor,
// descobre a qual model o acesso "<expr>." se refere, caminhando pelo grafo
// de relacoes (belongsTo/hasOne/hasMany). Sem dependencia do 'vscode'.

// Mapa de variaveis locais -> { className, kind } com base no fonte do doc.
// kind: 'class'  (var = require(...) ou Class.new(...))
//       'instance' (var = Model.find/new/first/... )
function scanLocals(docText) {
  const locals = new Map();

  // local X = require('A.B')  -> classe
  const reReq = /local\s+([A-Za-z_]\w*)\s*=\s*require\(\s*['"]([\w.]+)['"]\s*\)/g;
  let m;
  while ((m = reReq.exec(docText)) !== null) {
    locals.set(m[1], { className: m[2], kind: 'class' });
  }

  // local X = Class.new('A.B', 'ActiveRecord') -> classe (o proprio model do arquivo)
  const reClass = /local\s+([A-Za-z_]\w*)\s*=\s*Class\.new\(\s*['"]([\w.]+)['"]/g;
  while ((m = reClass.exec(docText)) !== null) {
    locals.set(m[1], { className: m[2], kind: 'class' });
  }

  // local r = <Var>.find{...} / :new(...) / .first(...) -> instancia do model de <Var>
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

// Extrai a cadeia de acesso antes do cursor: "a.b[1].c." -> ['a','b','c'].
// Retorna null se nao ha um acesso "<expr>." valido.
function extractChain(linePrefix) {
  // remove indexadores [ ... ] para tratar coleccoes como o elemento
  const cleaned = linePrefix.replace(/\[[^\]]*\]/g, '');
  const m = cleaned.match(/([A-Za-z_][\w.]*)\.\s*[A-Za-z0-9_]*$/);
  if (!m) return null;
  return m[1].split('.').filter(Boolean);
}

// Resolve o receiver final: { model, kind } ou null.
function resolve(index, docText, linePrefix) {
  const chain = extractChain(linePrefix);
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

  // caminha pelas relacoes intermediarias
  for (const step of steps) {
    const rel = model.relations.find(function (r) { return r.name === step; });
    if (!rel) return null; // parou numa coluna ou nome desconhecido
    const next = index.byClass.get(rel.record);
    if (!next) return null;
    model = next;
    kind = 'instance';
  }

  return { model: model, kind: kind };
}

module.exports = { resolve, scanLocals, extractChain, selfClassName };
