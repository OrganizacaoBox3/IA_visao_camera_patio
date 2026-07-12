# SPEC — Zonas poligonais (polígono fechado de N vértices)

> Status: **proposta aguardando aval do dono** · Data: 2026-07-12
> Insumos: pesquisa de UX de mercado (Axis AOA, Frigate, Dahua, UniFi Protect, Verkada, CVAT,
> ONVIF) + auditoria de TODOS os consumidores da geometria de zona (12 call-sites de contenção,
> 10 armadilhas, arquivo:linha).
> Frentes irmãs: `spec-turnos-por-zona.md` e `spec-alerta-por-atividade.md` — ortogonais em
> SEMÂNTICA (esta muda a GEOMETRIA), mas **tocam os mesmos arquivos** (ver §7, ordem de execução).

## 0. O pedido

Zonas hoje são retângulos (+ máscara de pincel em grade). O dono quer polígonos fechados: clicar
para acrescentar cantos, formando arestas, até fechar o polígono.

## 1. Decisões de design (o que o mercado já resolveu)

| # | Decisão | Precedente |
|---|---|---|
| **P1** | **Desenho: clique adiciona vértice; FECHA clicando no 1º vértice OU no botão "Concluir" (Enter como atalho); ESC cancela; "voltar" remove o último vértice.** Nenhum produto depende de um único gesto — redundância é o padrão (Frigate fecha no 1º vértice; Dahua no clique-direito; CVAT tem botão Done + tecla N). Pós-criação: **arrastar vértices** (Axis/UniFi). Inserir vértice numa aresta existente fica p/ v2 (o próprio Frigate admite que a inserção é imprecisa). | Frigate, CVAT, Axis, Dahua, UniFi |
| **P2** | **Validação: mínimo 3 vértices, máximo 20; polígono SIMPLES (auto-intersecção bloqueada no fechar/salvar); vértices clampados ao frame; não salva polígono aberto.** | ONVIF define FieldDetector como "simple non-intersecting polygon"; máximos do setor: Axis 10, Dahua 20, UniFi 8 — 20 cobre qualquer zona real. Frigate: "drawing must be finished before saving". |
| **P3** | **Côncavo PERMITIDO** (só "simples" é exigido). É o caso de uso real — o "L" em volta de um rack. Nenhum produto exige convexidade; ray-casting funciona igual. | Axis/Frigate/ONVIF |
| **P4** | **Retrocompat à Axis: o retângulo É um polígono de 4 vértices.** `Zone.points?: {x,y}[]` ADITIVO; zona sem `points` = caminho retângulo+máscara atual, intocado. O `x,y,w,h` continua existindo como **bbox DERIVADA** dos points (recalculada no save — exatamente como a máscara já faz via `maskBBoxNorm`): ela é o pré-filtro barato que TODOS os call-sites rodam antes do teste fino (armadilha 3). Zero migração de schema (`cam_zones` é jsonb). | Axis (rect = polígono de 4 cantos); Frigate (migração com conversão automática) |
| **P5** | **Contenção: `pointInPolygon` EXATO nos testes por ponto, mantendo a ÂNCORA de cada call-site** (centro do bbox onde hoje é centro — atribuição; PÉ onde hoje é pé — exclusão/automask; NÃO unificar, armadilha 4). O mercado usa o pé para pessoa (Frigate: "bottom center of the bounding box") — já é o que a nossa exclusão faz. **Precedência: `points` vence `mask`** quando ambos existem; com `points`, o pincel fica oculto (a máscara vira legado da zona). | Frigate; auditoria interna |
| **P6** | **O loop de movimento POR PIXEL não chama pointInPolygon** (custo O(pixels×vértices) por frame — armadilha 7): o polígono é **RASTERIZADO uma vez para a grade de máscara existente** (no load/save) e o caminho per-pixel continua consumindo a máscara como hoje. Um mecanismo, dois consumos: exato para pontos, rasterizado para pixels. | — (engenharia; reusa o maquinário de máscara) |
| **P7** | **Touch-friendly:** pointer events (mouse+touch unificados), alvos de toque generosos nos vértices, e NENHUMA função exclusiva de clique-direito (remoção de vértice tem botão) — VMS enterprise é hostil a touch; nosso operador pode usar tablet. | UniFi (app touch); lacuna documentada do setor |

## 2. Modelo (aditivo)

```ts
// src/zones.ts
type Zone = {
  /* ...campos atuais (x,y,w,h ficam como bbox DERIVADA)... */
  points?: { x: number; y: number }[];   // polígono fechado, normalizado 0..1 ao frame; ≥3, ≤20
};
```

- `pointInPolygon` JÁ EXISTE (`src/fusion/floor-polygon.ts:54` — puro, ray-casting, `<3 pontos →
  false`). O cliente importa direto; **o hub ganha espelho byte-a-byte** em
  `server/analysis/zones.js` (o hub CommonJS não consome o .ts — mesmo padrão dos helpers de
  máscara já espelhados ali).
- **Rede de paridade NOVA (não existe hoje):** um arquivo de **fixtures JSON compartilhado**
  (ponto, polígono, esperado — incluindo casos de borda/aresta) consumido pelos DOIS arquivos de
  teste (`zones.test.ts` e `zones.test.js`). Mata a armadilha 9 (divergência ε de float na borda
  colocaria a pessoa em zonas diferentes no cliente e no hub) e estreia o sensor cross-language
  que a casa nunca teve.

## 3. Onde toca (mapa dos 12 consumidores, da auditoria)

| grupo | call-sites | mudança |
|---|---|---|
| Contenção por ponto (cliente) | `pointInZone`/`assignZone` (zones.ts), exclusão-pé e ocupação (atividade.ts), objetos.ts | pré-filtro bbox (igual) → teste fino: `points` ? `pointInPolygon` : caminho atual |
| Contenção por ponto (hub) | `attributeZone` (centro), `inExclusionZone` (pé) em `server/analysis/zones.js` | idem, com o espelho |
| Movimento por pixel | `atividade.ts:225-238` | consome a máscara RASTERIZADA do polígono (P6) — código intocado |
| Gate de movimento (hub) | `buildMotionIgnore` — já usa só a bbox | continua bbox envolvente (grosseiro de propósito — documentado; já é assim para máscara) |
| Automask | grade própria, sugere rects | ponte: sugestão→zona gera polígono de 4 vértices (P4) |
| Desenho/edição | CameraWorkspace (palco), draw.ts | modo polígono (P1) + render por path `moveTo/lineTo` (fill/stroke poligonal; rótulo/estado seguem na bbox) |
| Persistência | `withDefaults` + **allowlist `cleanZone`** + jsonb | `points` validado (≥3, ≤20, clamp01, simples) — **armadilha 1: fora da allowlist o campo é descartado MUDO** |
| Relatório/eval/tripwires/calibração | — | ZERO mudança (não consomem geometria de zona; atenção só ao nome: `calibration.points` é outro objeto — armadilha 10) |

## 4. Critérios de aceite

- **CA-1 (desenho):** Given modo polígono; When clico 5 pontos e clico no 1º vértice; Then a zona
  fecha com 5 vértices, bbox derivada correta, e persiste (salvar → recarregar → polígono igual —
  round-trip pela allowlist).
- **CA-2 (validação):** não fecha com <3; bloqueia auto-intersecção ao fechar; 21º vértice
  recusado com aviso; ESC descarta o rascunho.
- **CA-3 (côncavo):** um "L" côncavo atribui corretamente pessoa dentro do L e NÃO atribui pessoa
  no vão do L (teste com fixtures).
- **CA-4 (paridade):** as fixtures compartilhadas passam idênticas no cliente (TS) e no hub (JS)
  — inclusive os casos de borda.
- **CA-5 (retrocompat):** todas as zonas existentes (rect ± máscara) comportam-se EXATAMENTE como
  antes (regressão em zones.test dos dois lados); zona com `points` ignora `mask`.
- **CA-6 (âncoras):** exclusão continua testando o PÉ e atribuição o CENTRO com polígono (testes
  espelhando os atuais).
- **CA-7 (edição):** arrastar vértice atualiza bbox derivada e persiste; funciona por touch
  (pointer events).

## 5. Fases

**F1 — Núcleo + persistência [depende de coordenação — ver §7]:** `Zone.points` +
`withDefaults` + `cleanZone` com validação (simples/clamp/limites) + espelho `pointInPolygon` no
hub + fixtures compartilhadas + precedência points>mask idêntica nos dois lados + bbox derivada no
save + rasterização polígono→máscara (P6). CA-3/4/5/6.

**F2 — UI de desenho [S após F1]:** modo polígono no palco (P1/P7), draft tracejado, drag de
vértices, validações interativas (CA-1/2/7), render poligonal em draw.ts, botão no ZonasTab, e2e
novo (`drawPolygonZone`).

**F3 — Pontes [S]:** automask sugestão→polígono-de-4; documentação do gate de movimento
(bbox envolvente); nota no changelog.

## 6. Fora de escopo v1

Inserir vértice em aresta existente (v2 — mercado admite imprecisão); buracos/multi-polígono por
zona; tripwires poligonais (são segmentos, outra feature); editar máscara de pincel numa zona com
`points` (o pincel some quando há polígono); migração automática das zonas antigas (ficam como
estão — viram polígono só se o usuário redesenhar); rasterizar o polígono no gate de movimento do
hub (continua bbox, como a máscara hoje).

## 7. ORDEM DE EXECUÇÃO das 3 frentes (a colisão de arquivos é real)

As três frentes tocam **os mesmos arquivos** (`zones.ts`, `camcfg.js/cleanZone`,
`ConfigZonaDialog`, `draw.ts`, `CameraWorkspace`). Paralelizar tudo violaria a regra de
dono-exclusivo-de-arquivo. Sequência proposta:

1. **Turnos-F1 ∥ Proibida-F1** — turnos-F1 é quase todo server+página nova (disjunto);
   proibida-F1 é dona dos arquivos de zona.
2. **Polígonos F1+F2** — depois que proibida-F1 pousa (mesmos arquivos).
3. **Integrações** (turnos-F2/F3 atribuição+gate; proibida-F2 hub; proibida-F3 arming) — na
   ordem das dependências declaradas nas specs.

Cada fase = um PR com `verify` + e2e verde (entregas pequenas e reversíveis).

## 8. Riscos (das 10 armadilhas da auditoria)

| risco | mitigação |
|---|---|
| Allowlist descarta `points` mudo (1) | `cleanZone` na MESMA task do tipo + CA-1 round-trip |
| mask×points ambíguos (2) | precedência definida (P5) idêntica nos 2 lados + CA-5 |
| bbox derivada velha quebra o pré-filtro (3) | bbox recalculada no save (padrão maskBBoxNorm) + testes |
| unificar âncoras centro/pé (4) | proibido por spec (P5) + CA-6 |
| custo per-pixel O(px×vértices) (7) | rasterização única p/ máscara (P6) |
| paridade TS↔JS diverge na borda (9) | espelho byte-a-byte + fixtures compartilhadas (CA-4) — sensor novo |
| zonas antigas sem points (8) | `points` ausente = caminho atual; malformado = descartado como `undefined`, nunca `[]` |
| colisão de nome com calibration.points (10) | nomes distintos nos comentários/validação; nenhuma colisão de objeto |
