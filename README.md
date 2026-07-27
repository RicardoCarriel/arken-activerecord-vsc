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

Os métodos herdados do ActiveRecord vêm do próprio `lib/arken/ActiveRecord.lua`,
com os parâmetros reais (`Model.sum(column, params)`, `Model.queryEach(name,
params)`, `Model.begin()`…) e **F12** abrindo a definição no arken.

### Métodos do valor da coluna, pelo tipo do schema
Depois de puxar uma coluna, `:` oferece os métodos que existem **para o tipo
daquela coluna**:

```lua
self.descricao:      --> camelCase(), underscore(), squish(), truncate() ... (arken.string)
                     --  + gsub(), lower(), sub() ... (string do Lua)
                     --  + toDate(), toasc() ... (extensões do seu profile/lib)
self.id:             --> nada: number não tem métodos de instância em Lua
```

O tipo sai do `db/schema/*.json` e reflete **o que a coluna guarda de fato**.
Colunas `date`/`datetime` ficam como a string crua do banco (é o que
`Adapter.dateParserValue` devolve), então elas recebem métodos de string. O
objeto de data vem pelo leitor do ActiveRecord:

```lua
self:read('data_emissao'):    --> addDays(), beginningOfMonth(), strftime() ... (arken.chrono.Date)
self:read('created_at'):      --> addHours(), addMinutes(), strftime() ...     (arken.chrono.Time)
```

O hover na coluna mostra o tipo SQL, o tipo do valor em Lua e para onde o
`read()` converte.

### Globais e extensões do seu projeto
O `config/profile.lua` e o `lib/` do projeto são lidos junto: métodos que você
acrescenta a `string`/`math`/`table`/`os` entram na lista do tipo, e globais
publicadas no profile resolvem sem `require` local:

```lua
DateTime.parse(x):   --> instância de arken.chrono.Time  (DateTime = require('arken.chrono.Time'))
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

### API nativa do arken (`os`, `base64`, `chrono`, `net`, `regex`…)
As bibliotecas do próprio arken também completam. A extensão lê a API direto do
código do arken — os bindings C++ (`src/bindings/**`) e as libs Lua
(`lib/arken/**`) — então a lista acompanha a sua versão instalada:

```lua
local base64 = require('arken.       --> arken.base64, arken.mvm, arken.regex, arken.Log ...
base64.                              --> encode(data), decode(data)

local Date = require('arken.chrono.Date')
Date.                                --> today(), currentDate(), parse(string, format)
Date.today():addDays(1):             --> strftime(format), beginningOfMonth(), wday() ...

local client = require('arken.net.HttpClient').new(url)
client:                              --> performGet(), setTimeout(timeout), status() ...

os.                                  --> glob(), find(), mkpath(), uuid(), microtime() ...
os.glob('*.lua'):                    --> each(), first(), size(), join()
```

O tipo de retorno vem do próprio binding, então o encadeamento funciona
(`Date.today():addDays(1):strftime(…)`, `os.find(dir, p):each()`). Hover mostra
os parâmetros com o tipo (`luaL_checkstring` → `string`), signature help
funciona em `(`, e **F12** abre o `.cpp`/`.lua` de origem.

## Instalação

- **Open VSX** (Antigravity, VSCodium, Gitpod…): busque por **"Arken"** em Extensões.
- **VS Code Marketplace**: busque por **"Arken / ActiveRecord IntelliSense"**.

## Configuração

| Setting | Padrão | Descrição |
|---|---|---|
| `arkenLsp.autoDetect` | `true` | Detecta a raiz do projeto arken subindo a partir do arquivo aberto. |
| `arkenLsp.projectPath` | `""` | Fallback opcional para arquivos fora da árvore do projeto. |
| `arkenLsp.diagnostics` | `relations` | `off` · `relations` (record inexistente) · `all` (+ colunas). |
| `arkenLsp.arkenPath` | `""` | Raiz do código do arken, para ler a API nativa da sua instalação. |

Para a API do arken, a extensão procura nesta ordem: `arkenLsp.arkenPath` →
`$ARKEN_PATH` → uma pasta `arken` ao lado do workspace → o catálogo embutido no
pacote. Só o catálogo embutido pode ficar defasado em relação ao seu binário;
apontar `arkenLsp.arkenPath` também habilita o **F12** para o fonte.

Comandos (`Cmd/Ctrl+Shift+P`): **Arken: Reindexar**, **Arken: Definir raiz do
projeto**, **Arken: Mostrar estatísticas do índice**, **Arken: Definir a raiz do
código do arken**, **Arken: Recarregar a API do arken**. A barra de status mostra
o projeto ativo, o número de models e a origem da API.

## Como funciona

Um índice em memória por projeto (`Model → { colunas, relações, métodos }`),
construído lendo `app/models/**` e `db/schema/*.json`. Watchers reindexam apenas
o arquivo alterado ao editar/salvar — o índice completo (centenas de models)
reconstrói em poucas centenas de milissegundos, o incremental é imperceptível.

O tipo de cada coluna vem do `format` do schema, mapeado para o valor que o
`ActiveRecord_Adapter` realmente entrega (`*ParserValue` para o campo,
`read_value_*` para o `read()`) — por isso `date` no campo é string e só vira
`Date` via `read()`.

A API do arken sai de um segundo índice (`src/arkenapi.js`), construído a partir
das tabelas `luaL_reg` dos bindings — `luaL_newmetatable(L, "arken.x")` vira a
tabela do módulo, `"arken.x.metatable"` vira os métodos de instância, e os
`luaL_check*` do corpo da função C dão nome e tipo aos parâmetros — mais as libs
Lua de `lib/arken/**`.

## Desenvolvimento

```bash
node test/smoke.js                       # índice, resolvedor e API, sem abrir o editor
node tools/gen-arken-api.js [../arken]   # regera data/arken-api.json (catálogo embutido)
```

Abra a pasta no editor e tecle **F5** para rodar em uma janela de
desenvolvimento. O núcleo (`src/indexer.js`, `src/resolver.js`,
`src/arkenapi.js`) não depende da API do editor.

## Licença

MIT © Ricardo Carriel
