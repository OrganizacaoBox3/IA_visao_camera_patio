# SPEC — A zona é um polígono (e sempre foi)

> Status: **proposta aguardando aval do dono** · Data: 2026-07-13
> Pedido: *"vamos usar zona e polígono totalmente. quero que o polígono seja a nova zona, com os
> mesmos recursos. analise os dois e unifique. quero poder EDITAR OS PONTOS depois."*
> Insumos: auditoria do código (consumidor a consumidor) + pesquisa de mercado (ONVIF, Axis, Frigate,
> Hanwha, Dahua, Verkada · Mapbox, Leaflet-Geoman, CVAT, Roboflow, ArcGIS).

## 0. A prova que estava no dado de produção

A única zona com **máscara pintada à mão** (`cam-50fa5758e7`, "Área 1") é uma **faixa diagonal** que
o pincel entregou como escada serrilhada — **5 componentes desconexos**, 35 células de 576:

```
...................##...........
................##.....##.......
..................###...........
...............##.#.............
.............####...............
...........#####................
.........######.................
.......########.................
```

É um polígono de ~6 vértices sendo aproximado à mão numa grade 32×18. **O pincel é um workaround do
polígono que faltava.** O operador já estava brigando com a ferramenta; o dado registrou a briga.

## 1. A tese, confirmada e endurecida

Não são **dois** caminhos — são **três**: `StageTarget = "rect" | "paint" | "polygon"`
(`useStageModes.ts:27`). E a divergência que a unificação previne **já aconteceu**:

| primitiva | criar | mover vértice | inserir vértice | remover vértice | mover a forma | redimensionar |
|---|---|---|---|---|---|---|
| **retângulo** | arraste | — | — | — | **✗** | **✗** |
| **polígono** | clique a clique | **✓** | ✗ | ✗ | ✗ | (via vértices) |
| **pincel** | pintar | n/a | n/a | n/a | ✗ | ✗ |

**O retângulo não tem edição NENHUMA.** Nasce por arraste, morre no X. **É a primitiva pobre** — e é
a que 21 das 22 zonas de produção usam.

## 2. O mercado (e por que ele decide)

**Em CFTV, ninguém trata retângulo como TIPO — ele é o *preset inicial* do polígono.** Literal, da Axis:
> *"The default include area **rectangle** can be changed to a **polygon with up to 10 corners**."*

**ONVIF** (o padrão) nem tem "tipo retângulo" no contrato: a regra de área é *"a simple
non-intersecting polygon"*, e o dispositivo só declara `PolygonLimits` (min/max de lados).

**Quem separa os dois são as ferramentas de ANOTAÇÃO** (CVAT, Roboflow, Label Studio) — e a razão é o
**artefato de saída**: bbox e polígono viram formatos de ML e tarefas diferentes (detecção ×
segmentação). **Essa razão não nos alcança:** nossa zona não é rótulo de treino, é um teste de
contenção. A saída é sempre a mesma pergunta — *"o ponto está dentro?"*. **Logo: unificar.**

### O buraco do mercado (e a nossa chance)
Os VMS são o **piso**, não o teto: o **Frigate literalmente não implementa inserção de vértice**; a
Axis só documenta como **remover** (e só por **botão direito** — inacessível no dedo, e o nosso
operador usa **tablet**). **Quem resolveu "editar pontos depois" foi o mundo de MAPAS** (Mapbox GL
Draw, Leaflet-Geoman, Google Maps) e de anotação (Roboflow).

| | inserir vértice | remover | mover a forma | auto-interseção |
|---|---|---|---|---|
| **Frigate** | ✗ **não existe** | ✗ | arrasta o grupo | não valida |
| **Axis** | não documentado | botão direito | click-and-drag | não documentado |
| **Mapbox GL Draw** | **midpoint fantasma** | Delete/Backspace | arrasta o interior | recusa bloquear |
| **Leaflet-Geoman** | **midpoint** | ✓ | ✓ | **bloqueia na colocação** |
| **Roboflow** | **clique na ARESTA** | ✓ | ✓ | — |
| **NÓS (hoje)** | ✗ | ✗ | ✗ | **✓ bloqueia** (`isSimplePolygon`) |

## 3. O que NÃO muda (a boa notícia)

**O contrato de dado.** `points` já existe, já é validado **dos dois lados** (`src/zones.ts` e o
espelho `server/analysis/zones.js`), coordenadas já são **normalizadas 0..1** (imune a troca de
resolução — o mesmo desenho do Frigate, e o correto).

**A bbox NÃO morre — e não precisa.** Ela **já é derivada** dos `points` no save (`withDefaults`,
`cleanZone`). E não pode morrer, porque **três consumidores fisicamente não aceitam polígono**:

| consumidor | por quê |
|---|---|
| crop da **FADIGA** (`CameraWorkspace.tsx:589`) | `drawImage` recorta **retângulo**. Polígono não se recorta |
| ROI da **LEITURA** (`processors/leitura.ts:52`) | idem |
| laço **por pixel** da atividade (`processors/atividade.ts:225`) | precisa de um *bound* para não varrer o frame inteiro |

+ o **desempate** de `assignZone`/`attributeZone` (área da bbox), **pinado em teste**
(`src/zones.test.ts:403`).

> **A regra a pinar: `points` é a fonte da verdade; `x/y/w/h` é CACHE da envolvente — derivado,
> nunca autorado.** Nenhum campo novo, em camada nenhuma. **Não é mudança de contrato: é UI + migração.**

## 4. O medo de performance é FANTASMA (medido)

| | 4 vértices | 8 | 20 (teto) | retângulo |
|---|---|---|---|---|
| ns por ponto | 34 | 50 | **106** | 12 |

Rodada típica do hub (10 tracks × 5 zonas = 50 testes): **5,3 µs**. A 8 fps: **0,004% de um core**.
O inimigo do hub é o D-FINE — *centenas de ms*. **Enterrem o medo.**

Onde **não** é fantasma (e já está resolvido): o laço **por pixel** — por isso o polígono é
**rasterizado 1×** para a grade (`rasterizePolygonMask`, ~61 µs, cacheado por assinatura de vértices).
**Um mecanismo, dois consumos.**

## 5. O RISCO REAL — e é a mordida de hoje, de novo

**`server/analysis/engine.js:171` — `buildMotionIgnore` DESCARTA `points` calado.** Ele mapeia a zona
de exclusão para `{x,y,w,h}`: uma exclusão **poligonal** vira o **retângulo envolvente** no gate de
movimento. Hoje o dano é **zero** (nenhuma exclusão é polígono). **Depois da unificação, TODA exclusão
é polígono** ⇒ o gate ignoraria muito mais área do que deveria (*fail direction*: **o motor pode não
acordar**).

É a **mesma classe** do bug do `stations` consertado hoje: **um consumidor descartando um campo em
silêncio.** Conserto **na mesma onda**, com teste.

**Segundo risco:** `usePolygonEditor.ts` **não tem teste unitário** (só e2e do fluxo de criação).
Estender esse contrato sem teste é a regressão nº 1 da doutrina, literal. **Teste antes de estender.**

## 6. O DESENHO — copiar mapas, não VMS

**Um só objeto: `points[]`.** O **retângulo vira um PRESET** que semeia 4 vértices (exatamente a Axis).
`StageTarget.rect` some. O **pincel some** como ferramenta; a **máscara sobrevive** só como
rasterização **interna** (já é o que `rasterizePolygonMask` faz).

**Dois modos, como o Mapbox:**
- **Seleção** (`simple_select`): clicar na zona seleciona; **arrastar o interior MOVE a forma inteira**.
- **Edição de vértice** (`direct_select`): vértices sólidos + **midpoints semitransparentes** no meio
  de cada aresta. **Arrastar o midpoint INSERE** um vértice. Arrastar o vértice move.

**Remover vértice:** `Delete`/`Backspace` com o vértice selecionado **+ Alt+clique** (Mapbox + CVAT).
**NUNCA só botão direito** — o `usePolygonEditor` já declara "nenhuma função exclusiva de clique-direito
(P7)" porque **o operador usa tablet**. Mínimo de 3 vértices (já em `zones.ts`).

**Auto-interseção: bloquear na COLOCAÇÃO (Geoman), não no commit.** Já temos `isSimplePolygon` +
reversão do arraste; falta a **aresta ficar vermelha antes de soltar** — avisar é mais barato que desfazer.

**Acessibilidade (barata, e NINGUÉM em CFTV tem):** uma **tabela de vértices** editável na
`ConfigZonaDialog` (padrão ArcGIS) — `#1 (0.31, 0.42)` com setas para *nudge* e botão remover.
**Resolve o teclado E dá precisão fina sem zoom.** É o nosso diferencial de graça.

## 7. A MIGRAÇÃO (contada, não estimada)

**22 zonas / 17 câmeras: 21 retângulos puros · 1 polígono (4 vértices) · 1 com máscara.**

Regra: `rect → [{x,y}, {x+w,y}, {x+w,y+h}, {x,y+h}]`. Não auto-intersecta; o `pointInPolygon`
(ray-casting) é insensível ao *winding*; a envolvente volta idêntica (≤1 ulp).

**Onde:** em `cleanZone` (`server/camcfg.js`), no **load/save** — idempotente, **sem script, sem
downtime**. (`camcfg.json` é runtime/gitignored; não se edita à mão.)

**A exceção — 1 conversa com o operador:** a zona da máscara **não** vira polígono automaticamente,
porque o retângulo dela **não é a área real** (a área real é a faixa diagonal). São **21 automáticas
+ 1 redesenhada em 6 cliques** — e vai ficar melhor do que está.

## 8. Fases

**F1 — o gate ANTES da UI (senão repetimos a mordida de hoje):**
teste unitário do `usePolygonEditor` · fixture de 4 vértices no espelho `zones.ts` ↔
`server/analysis/zones.js` · **conserto do `buildMotionIgnore`** (o hub tem de honrar `points`) ·
o assert "`points` é fonte da verdade, bbox é derivada".

**F2 — a migração** (`cleanZone`: rect → 4 pontos, idempotente) + o teste de round-trip.

**F3 — o editor** (o pedido do dono): midpoint fantasma (inserir) · Delete/Alt+clique (remover) ·
arrastar o interior (mover a forma) · aresta vermelha na auto-interseção · preset "Retângulo".

**F4 — a tabela de vértices** (teclado + precisão) na `ConfigZonaDialog`.

**F5 — a poda:** `StageTarget.rect` e o pincel saem do palco. A máscara vive como rasterização interna.

## 9. Fora de escopo

Buracos/ilhas no polígono (nenhum consumidor pede) · snap entre zonas adjacentes (o mercado tem; nós
não temos demanda medida) · mudar o teto de 20 vértices (o mercado vive com 8-10; 20 é generoso).
