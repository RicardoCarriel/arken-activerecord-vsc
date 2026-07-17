# Arken / ActiveRecord IntelliSense

Autocomplete, navegação e verificação para projetos do framework **arken**
(models ActiveRecord em Lua). A extensão indexa **ao vivo** os models e schemas
do seu projeto e entende as convenções do arken — colunas, relacionamentos e
métodos — sem nenhum passo de geração de código.

Detecta o projeto automaticamente a partir do arquivo aberto e funciona com
**vários projetos arken** ao mesmo tempo.

## Como ela ajuda no dia a dia

### Colunas do schema (`.`)
Digite `.` num record e veja as colunas da tabela, com tipo e restrições:

```lua
local reg = Pedido_Regra.find{ id = 1 }
reg.          --> descricao, cancelado, categoria_id, created_at ...  (do db/schema)
```

### Relações e métodos (`:`)
Digite `:` para as relações (`hasMany`/`belongsTo`/`hasOne`) e os métodos:

```lua
reg:          --> items(), status(), alertas()   + save(), destroy(), populate() ...
```

### Métodos do próprio model — instância e estáticos
Os métodos definidos no model entram no autocomplete, separados dos nativos:

```lua
self:empresa():executarRotinasIntegracao()   -- método de instância de Empresa
Empresa.rotinaList()                          -- método estático de Empresa
```

### Navegação encadeada pelas relações
O tipo é resolvido ao longo da cadeia:

```lua
reg:items()[1]:produto():descricao   -- Pedido.Regra.Item -> Produto -> coluna
```

### Ir para a definição (F12 / Ctrl+clique)
- relação `:empresa()` → abre o model `Empresa`
- método `:executarRotinasIntegracao()` → vai até a definição
- coluna `reg.descricao` → abre o `db/schema/*.json` na coluna
- `require('Pedido.Regra')` e `record = 'Empresa'` → abrem o arquivo do model

### Assinatura dos métodos (signature help)
Ao abrir `(` num método do model, mostra os parâmetros reais e destaca o atual:

```lua
empresa:executarRotinasIntegracao(  --> executarRotinasIntegracao(params)
```

### Diagnósticos (detecção de erros)
- avisa quando `record = 'X'` aponta para um model que não existe (pega typo/rename)
- opcional (`all`): sinaliza `self.<coluna>` que não existe no schema

### `require` inteligente
Ao importar depois de nomear a variável, sugere o caminho convertendo `_` em `.`
— **somente se o model existir**:

```lua
local Pedido_Regra = require('   --> sugere 'Pedido.Regra' no topo
```

### Escrevendo relações
Dentro de um bloco de relação, `record =` sugere models e `foreignKey =` sugere
colunas.

## Instalação

- **Open VSX** (Antigravity, VSCodium, Gitpod…): busque por **"Arken"** em Extensões.
- **VS Code Marketplace**: busque por **"Arken / ActiveRecord IntelliSense"**.

## Configuração

| Setting | Padrão | Descrição |
|---|---|---|
| `arkenLsp.autoDetect` | `true` | Detecta a raiz do projeto arken subindo a partir do arquivo aberto. |
| `arkenLsp.projectPath` | `""` | Fallback opcional para arquivos fora da árvore do projeto. |
| `arkenLsp.diagnostics` | `relations` | `off` · `relations` (record inexistente) · `all` (+ colunas). |

Comandos (`Cmd/Ctrl+Shift+P`): **Arken: Reindexar**, **Arken: Definir raiz do
projeto**, **Arken: Mostrar estatísticas do índice**. A barra de status mostra o
projeto ativo e o número de models.

## Como funciona

Um índice em memória por projeto (`Model → { colunas, relações, métodos }`),
construído lendo `app/models/**` e `db/schema/*.json`. Watchers reindexam apenas
o arquivo alterado ao editar/salvar — o índice completo (centenas de models)
reconstrói em poucas centenas de milissegundos, o incremental é imperceptível.

## Desenvolvimento

```bash
node test/smoke.js       # testa o índice/resolvedor sem abrir o editor
```

Abra a pasta no editor e tecle **F5** para rodar em uma janela de
desenvolvimento. O núcleo (`src/indexer.js`, `src/resolver.js`) não depende da
API do editor.

## Licença

MIT © Ricardo Carriel
