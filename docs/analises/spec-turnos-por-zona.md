# SPEC — Turnos de trabalho por zona (contexto operacional das métricas)

> Status: **proposta aguardando aval do dono** · Data: 2026-07-12
> Insumos: pesquisa de mercado (UKG/Kronos, When I Work, Deputy, Tanda, 7shifts, Pontomais/Pontotel/
> TOTVS, OEE.com/Sepasoft/Evocon — fontes no fim) + auditoria código-por-código dos pontos de
> integração (10 armadilhas mapeadas, arquivo:linha).
> Frente irmã: `spec-alerta-por-atividade.md` — as duas COMPÕEM (ver §7) e compartilham a decisão D6.

## 0. O problema em uma frase

O objetivo do produto é medir performance das ÁREAS de trabalho — e hoje o sistema não sabe QUANDO
uma área deveria estar trabalhando: 4 horas de zona vazia às 3h da manhã contam como "ociosidade"
igual a 4 horas vazias às 10h. O turno é o **denominador** que separa "parado normal" de "parado
anômalo" — exatamente o modelo OEE (ociosidade só existe dentro do *Planned Production Time* =
turno − pausas; fora do turno é *Schedule Loss*, excluído da conta).

**Bônus estrutural:** o sistema JÁ tem turnos — hardcoded (06/14/22, "Manhã/Tarde/Noite") e
**duplicados à mão** em `server/analysis/pipeline.js:32` e `src/report/calc/common.ts:8`, com o
próprio comentário admitindo o risco ("mudou lá, mude aqui"). Esta feature substitui esse débito
por uma fonte única configurável.

## 1. As decisões de design (o que o mercado já resolveu — não reinventar)

| # | Decisão | Convenção de mercado (fontes na pesquisa) |
|---|---|---|
| **D1** | **O turno pertence ao dia em que INICIA** (business date) | Unânime: UKG "day divide", When I Work (`22:00 ~ 6:00` com `~` sinalizando overnight), 7shifts, Tanda. Agregação e rótulo sempre pelo dia de início. |
| **D2** | **`fim ≤ início` ⇒ termina no dia seguinte. Teto: 24h por turno.** | WhenToWork/When I Work impõem 24h explícito. Com o teto, o par (início, fim) wall-clock é NÃO-AMBÍGUO: `duração = (fim − início) mod 24h`, `> 0`. **Plantão >24h = dois turnos encadeados** — nenhum produto mainstream modela turno único >24h; a UI mostra "+1 dia" no fim quando cruza. |
| **D3** | **Turno é CONTÊINER: 1 janela contínua + N pausas dentro.** | Deputy Break Planning; OEE Planned Production Time (turno 480min − pausa 30min = 450min esperados). Pausa (almoço/café) = janela em que zona vazia é ESPERADA. Split shift real (manhã+noite) = **dois turnos**, não um tipo novo. |
| **D4** | **A grade atribuída a uma zona não pode ter overlap.** | Deputy nem permite sobrescrever; MES exige partição do tempo. Validação no cadastro/atribuição; instante exatamente na borda pertence ao turno que INICIA nele. |
| **D5** | **Grade SEMANAL por dia-da-semana. Escala cíclica (12x36) fora do v1.** | Para métricas de visão o que importa é o POSTO, não a pessoa: num CD 24/7 os turnos do posto são fixos por dia; quem gira são as pessoas (que a 12x36 escala — Pontomais/TOTVS modelam por ciclo de N dias, extensão aditiva futura, não redesign). |
| **D6** | **Wall-clock local + timezone IANA do SITE (não do processo).** | Turnos se definem como a operação pensa ("22h às 6h"). Resolução SEMPRE no tz do galpão (`SITE_TZ`, default `America/Sao_Paulo`) — nunca `getHours()` do ambiente (armadilha 7: hoje hub e navegador carimbam com fusos potencialmente diferentes). Brasil sem DST desde 2019; se voltar, a lib IANA absorve. RRULE = overengineering documentado (Nylas: "deceptively complex") — grade própria. |
| **D7** | **Fora do turno não é downtime — é OUTRA COISA.** | Convenção OEE: ociosidade só conta dentro de turno−pausas; atividade fora do turno é evento com semântica própria (anomalia/hora-extra), nunca misturada no denominador. |

## 2. Modelo de dados

```ts
// Entidade GLOBAL nomeada (cadastrada 1×, atribuída a N zonas — não uma agenda por zona)
type Shift = {
  id: string;
  nome: string;              // "Turno 1", "Madrugada"
  dias: number[];            // dias da semana em que o turno INICIA (0=dom..6=sáb) — D1/D5
  inicio: string;            // "HH:MM" wall-clock do site — D6
  fim: string;               // "HH:MM"; fim ≤ início ⇒ +1 dia; duração ∈ (0, 24h] — D2
  pausas: { inicio: string; duracaoMin: number }[];  // dentro da janela — D3
  ativo: boolean;
  criadoEm: number;
};

// Atribuição: campo ADITIVO na zona existente (viaja no camcfg que já existe)
type Zone = { /* ...campos atuais... */ shiftIds?: string[] };  // ausente/[] = 24/7 (comportamento atual)
```

- Os "vários intervalos" do pedido = **N turnos atribuídos à zona** (a união dá a grade do dia) +
  **pausas dentro de cada turno**. Duas necessidades, dois mecanismos — como o mercado faz.
- `shiftIds` ausente = **zona 24/7 = comportamento de hoje**. Default seguro; nada muda sem opt-in.

**Persistência** (padrão da casa, molde `bt-tags`): tabela `shifts` (PG, aditiva no `schema.sql`) +
fallback `shifts.json` + cache no boot + CRUD `/api/shifts` (GET `requireAuth`, escrita
`requireConfigurer`). Atribuição viaja no `cam_zones.data` (jsonb) já existente — **zero contrato
novo de socket** (o `camcfg-updated kind:"zones"` já recarrega o hub).

## 3. A resolução — UMA fonte, no servidor (mata as armadilhas 1 e 7)

Módulo novo `server/shift-clock.js`, puro e testado:

```js
resolveShift(ts, shifts, siteTz) → { shiftId, businessDate, inPause } | null   // null = fora de turno
```

- Overnight/borda/pausa resolvidos AQUI e em nenhum outro lugar. Timezone via `Intl` (IANA).
- **O front NUNCA resolve turno.** Consome resultados: o hub anexa `inShift` por zona no
  `analysis-tracks` (overlay ao vivo — aditivo) e carimba `shiftId`+`businessDate` nos
  ingest/eventos; o relatório filtra pelo carimbo, não recalcula.
- O `shiftOf` hardcoded morre nas DUAS pontas (F5) — substituído pela resolução central; os dados
  históricos com "Manhã/Tarde/Noite" NÃO são migrados (ver retrocompat, §6).

## 4. Onde o turno CONTRIBUI (o pedido central — não é feature isolada)

1. **Gate de ociosidade** (o exemplo do dono): alerta de inatividade de zona **só dispara dentro do
   turno e fora das pausas**. O gate mora em `server/alarm/pipeline.js` (o socket `alert` do
   cliente JÁ passa por lá → fonte única mesmo para alertas nascidos no navegador). Fora do
   turno/na pausa: suprimido com contador (aparece na Saúde de Alarmes como "suprimidos por
   turno" — visibilidade sem ruído).
2. **Atividade FORA do turno = evento próprio** (D7): métrica nova `atividade-fora-de-turno`
   (min/ocorrências por zona/dia) no relatório; alarme opcional **nascendo desligado** — a frente
   irmã (`spec-alerta-por-atividade.md`) entrega o mecanismo de alerta-por-atividade que esta
   janela reusa.
3. **Relatório na régua certa**: KPI "ocupação dentro do turno" (ocupação ÷ tempo-de-turno−pausas,
   não ÷ 24h); filtro de turno populado do CADASTRO (fim das 3 strings hardcoded); comparação
   entre turnos (padrão Evocon Shift View).
4. **Overlay ao vivo**: zona fora de turno aparece dessaturada/etiquetada ("fora de turno") — cor é
   informação (doutrina going-gray): zona cinza-neutra fora do turno, estado normal dentro.

## 5. Critérios de aceite (Given/When/Then — os críticos viram teste)

- **CA-1 (overnight/D1-D2):** Given turno 22:00–06:00 seg-sex atribuído à zona Z; When um sample de
  atividade chega ter 03:00 de QUARTA; Then ele resolve para o turno com `businessDate` = TERÇA (dia
  em que o turno iniciou) e `inShift=true`.
- **CA-2 (gate de ociosidade):** Given zona Z com turno 06:00–14:00 e `idleAlertMs=10min`; When a
  zona fica vazia 11min às 10:00; Then alerta dispara. When fica vazia das 15:00 às 05:00; Then
  NENHUM alerta e o contador "suprimido por turno" incrementa.
- **CA-3 (pausa/D3):** Given turno com pausa 12:00–13:00; When a zona fica vazia 12:10–12:50; Then
  nenhum alerta de ociosidade (pausa = vazio esperado).
- **CA-4 (borda/D4):** Given turnos A (06–14) e B (14–22) na mesma zona; When um evento chega
  exatamente às 14:00:00.000; Then pertence a B (turno que inicia). E When se tenta atribuir turnos
  com janelas sobrepostas à mesma zona; Then o PUT é rejeitado com erro claro.
- **CA-5 (default seguro):** Given zona sem `shiftIds`; Then comportamento IDÊNTICO ao atual
  (24/7) em alertas, ingest e relatório — verificado por teste de regressão.
- **CA-6 (fuso/D6):** Given hub rodando com TZ do processo ≠ `SITE_TZ`; When um evento é
  carimbado; Then o turno resolve pelo `SITE_TZ`, não pelo relógio do processo.
- **CA-7 (24h/D2):** cadastro rejeita duração 0 e > 24h; UI exibe "+1 dia" quando fim ≤ início.
- **CA-8 (retrocompat):** relatório com dados antigos (strings "Manhã/Tarde/Noite") continua
  funcionando com o filtro legado; dados novos filtram por turno cadastrado.

## 6. Mapa requisito→implementação (fases; [S]=sequencial [P]=paralelizável)

**F1 — Fundação [P]:** `server/shifts.js` (store, molde `bt-tags.js`) + tabela `shifts` aditiva +
`server/routes/shifts.js` (CRUD, RBAC) + `server/shift-clock.js` (resolução pura + testes dos
CA-1/4/6/7) + `src/api.ts` client + página `/turnos` (rota em `main.tsx`, nav gated `canConfigure`
em `AppShell` grupo adm, molde `BtTagsPage`). Editor: lista de turnos; cada um nome + dias da
semana + início/fim (com "+1 dia" calculado) + pausas.

**F2 — Atribuição [S após F1]:** `Zone.shiftIds` em `src/zones.ts` (`withDefaults`) + **allowlist
`cleanZone` em `server/camcfg.js:61-81`** (armadilha 6: sem isso o campo é descartado MUDO) +
seletor de turnos no `ConfigZonaDialog` (bloco modo=atividade) + validação de overlap (CA-4).

**F3 — Contexto no motor [S após F2]:** hub carimba `shiftId`/`businessDate`/`inShift` nos
`ativ` samples (`pipeline.js`) — **dupla escrita**: mantém `shift` legado (string) E adiciona os
campos novos (aditivo, nada quebra); `ativ_buckets` ganha a dimensão turno na chave
(`cameraId|zoneId|hourStart|shiftId` — resolve a armadilha 4: turno com minutos corta o bucket, e
a atribuição por SAMPLE de ~3s dá a precisão); gate de ociosidade em `server/alarm/pipeline.js`
(CA-2/3) com contador de suprimidos; `inShift` por zona no `analysis-tracks` (overlay).

**F4 — Relatório [S após F3]:** filtro populado de `/api/shifts` + legado; KPI
ocupação-dentro-do-turno; linha "atividade fora de turno"; `Shift` union type vira `string`
(armadilha 2 — ~8 arquivos `calc/*`, mudança mecânica); CSV com turno cadastrado.

**F5 — Matar o hardcode [S após F4]:** `shiftOf` das duas pontas substituído pela resolução
central (flow: ver "decisão pendente" abaixo); teste de paridade garante que dado novo ≡ resolução
única.

**Verificação:** cada CA crítico vira Vitest; e2e do cadastro (criar turno overnight + atribuir à
zona + ver o "+1 dia"); `npm run verify` + Playwright por fase (entregas pequenas e reversíveis —
uma fase = um PR).

## 7. Composição com a frente irmã (alerta por atividade)

A direção do alerta (inatividade|atividade) é ORTOGONAL à janela de turno. A matriz completa:

| | dentro do turno | fora do turno |
|---|---|---|
| **zona de trabalho** (alerta inatividade) | ociosidade → **alerta** | vazio esperado → silêncio |
| **zona proibida/parada** (alerta atividade) | conforme config | atividade → **alerta/anomalia** |

O gate de turno e a direção do alerta se encontram no MESMO lugar (`server/alarm/pipeline.js`) —
por isso as duas specs compartilham a fase de gate e nenhuma duplica lógica.

## 8. Fora de escopo v1 (explícito)

Escala cíclica por pessoa (12x36/6x2 — extensão futura "ciclo de N dias", aditiva); feriados e
exceções por data; day-divide configurável; grace periods de entrada/saída; RRULE; turnos por
TRIPWIRE (flow continua com o `shift` legado no v1 — cruzamento é por linha, não por zona; a
migração do flow para turnos cadastrados fica registrada como pendência com a decisão de COMO
atribuir turno a uma linha); migração de dados históricos (strings antigas ficam como estão).

## 9. Riscos e mitigações (das 10 armadilhas auditadas)

| risco | mitigação |
|---|---|
| Duas fontes de turno divergirem (armadilha 1) | resolução única no servidor; front nunca resolve; F5 mata o hardcode |
| Campo novo descartado mudo pela allowlist (6) | `cleanZone` na MESMA task da F2 + teste que salva e relê `shiftIds` |
| Fuso hub × navegador (7) | `SITE_TZ` único (D6) + CA-6 |
| Bucket por hora × turno com minutos (4) | dimensão `shiftId` na chave do bucket ativ, atribuída por sample |
| União `Shift` fechada em ~8 arquivos (2, 9) | F4 mecânica, tipo vira `string`, filtro legado preservado |
| `predictAlertsPerDay` superestima com gate (10) | ajustar o preview do slider para considerar só janelas de turno (F4) |
| Flow sem zona (8) | fora de escopo v1 + pendência registrada |
| Alerta só nasce no cliente (5) | herdada pela frente irmã (que move a produção de alerta para o hub); o gate desta spec já nasce no servidor |
