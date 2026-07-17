# Arken / ActiveRecord IntelliSense (protótipo)

Extensão VSCode que indexa **ao vivo** os models e schemas de um projeto arken
(fusion2) e oferece autocomplete de colunas, relacionamentos e métodos do
ActiveRecord — sem passo de geração de definições.

## Arquitetura

- `src/indexer.js` — **cérebro**, Node puro (sem `vscode`). Varre `app/models/**`
  e `db/schema/*.json` e monta o grafo `Model → { colunas, relações }`.
  Portável para dentro de um Language Server no futuro.
- `src/resolver.js` — resolve o tipo do receiver antes do `.` (self, var de
  `require`, instância de `.find{}`), caminhando pelas relações.
- `src/extension.js` — cola do VSCode: providers de completion/hover, watchers
  incrementais e comandos.

## Como testar

### Lógica (headless, sem abrir o VSCode)

```bash
node test/smoke.js            # usa /Users/rcarriel/Projetos/fusion2
node test/smoke.js /outro/fusion2
```

### Na interface do VSCode

1. Abra esta pasta (`arken-vscode`) no VSCode.
2. Tecle **F5** → abre uma janela "Extension Development Host" já com o fusion2
   carregado (ver `.vscode/launch.json`).
3. Abra um model, ex. `app/models/Pedido/Regra.lua`, e digite dentro de uma
   função `self.` → devem aparecer colunas, relações e métodos.
4. Teste também:
   ```lua
   local Regra = require('Pedido.Regra')
   local reg   = Regra.find{ id = 1 }
   reg.            -- colunas + relações + métodos de instância
   reg.items[1].   -- navega para Pedido.Regra.Item
   ```

Comandos (Cmd+Shift+P): **Arken: Reindexar** e **Arken: Mostrar estatísticas**.

## Escopo atual / próximos passos

- [x] Índice ao vivo de models + colunas (schema JSON) + relações
- [x] Resolução: `self`, `require`, instância via finder, navegação encadeada
- [x] Watchers incrementais (edição/salvar/criar/remover)
- [ ] Módulos arken (`arken.doc.Excel`, etc.) — inclui stubs dos módulos C/C++
- [ ] Go-to-definition em `record = '...'` e nas relações
- [ ] Migrar `indexer.js`/`resolver.js` para um Language Server (multi-editor)
