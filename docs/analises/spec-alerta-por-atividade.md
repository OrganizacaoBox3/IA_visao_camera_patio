# SPEC — Alerta por ATIVIDADE (zona proibida/parada) — o espelho do alerta de inatividade

> Status: **proposta aguardando aval do dono** · Data: 2026-07-12
> Insumos: pesquisa de mercado VMS/analytics (Axis Object Analytics, Avigilon, Verkada, Hikvision/
> Dahua, Genetec, Milestone, Nx, Rhombus + ISA-18.2 — fontes no fim da pesquisa) + mapa completo do
> caminho do alarme atual (8 armadilhas, arquivo:linha).
> Frente irmã: `spec-turnos-por-zona.md` — o "armar/desarmar por horário" desta spec É o turno da outra.

## 0. O pedido e o que a auditoria revelou

Pedido do dono: zona flagada como "parada" não deve ter atividade; se tiver, alerta com o MESMO
comportamento do alerta de inatividade atual, sinal oposto. As duas direções convivendo e fáceis de
distinguir visualmente.

**O que o mapa revelou e muda o desenho:** o alerta de inatividade de hoje é **100% cliente**
(`AtividadeProcessor` roda no navegador, dirigido pelo laço de render; o único chamador de
`handleAlert` no servidor é o socket vindo do dashboard). **Câmera sem dashboard aberto não alerta
NADA.** Para inatividade isso passa (alguém está olhando a operação); para uma **zona proibida, o
momento mais importante é exatamente quando ninguém está olhando** (madrugada). Espelhar só o
cliente herdaria a cegueira → **o alerta de atividade nasce TAMBÉM no hub** (F2), e o hub já tem o
insumo (ele mede `people` por zona a cada ~3s no pipeline de `ativ` samples).

## 1. Decisões de design (o que o mercado já resolveu)

| # | Decisão | Precedente |
|---|---|---|
| **E1** | **Direção = TIPO NOMEADO, nunca flag invertida.** Novo modo de zona **`proibida`** + tipo de alarme **`presenca`** — evento irmão, não mutação do existente. | Avigilon tem o par literal *Objects in Area* / *Object Not Present in Area*; Axis/Verkada idem. E resolve a **armadilha A3**: a chave de dedup é `cam|zona|tipo` — com tipos distintos, os dois alertas na mesma zona **não se suprimem mutuamente** (com `tipo:"atividade"` para ambos, um calaria o outro por 60s). |
| **E2** | **Dwell antes de alertar + filtro de classe pessoa.** A violação exige permanência ≥ X s (preset, default ~10s; contador reseta se sai antes); o gatilho é PESSOA detectada (não motion bruto). | Hikvision time-threshold (2s típico); Axis *Time in area*; "filtro de classe é o anti-FP nº 1" (Lumana/Davantis). A direção atividade gera MAIS falso positivo que a inatividade — o dwell + classe são a defesa. |
| **E3** | **Evento com CICLO DE VIDA + throttle.** Violação abre UM evento (start), permanece aberto enquanto há presença, fecha com off-delay quando esvazia; re-notificação periódica opcional (atualiza a duração, não re-alerta). | Axis/Nx/Genetec (start/stop com histerese); Verkada (re-emissão por múltiplos do threshold); Nx *interval of action*. Evita estourar o flood (8/15s) com atividade contínua. |
| **E4** | **Armar/desarmar por horário = os TURNOS da frente irmã.** A zona proibida nasce **24/7**; opcionalmente arma-se por janela: `sempre` \| `dentro dos turnos X` \| `fora dos turnos X` (o caso "área normal no expediente, proibida à noite"). | Hikvision *Arming Schedule*, Dahua *Effective Period* (default 24/7), Milestone *Time Profiles*; ISA-18.2 chama isto de supressão por estado operacional. **Mesmo objeto `Shift`, mesmo gate no servidor — zero lógica duplicada.** |
| **E5** | **Nunca os dois sentidos armados na mesma zona no mesmo horário.** Estruturalmente garantido: a zona tem UM modo. (Par HI/LO exige racionalização — ISA-18.2.) Zonas sobrepostas com direções opostas → warning no save. | ISA-18.2. |
| **E6** | **Visual: "armada" ≠ "em alarme", e a distinção mora na LISTA de zonas.** Zona proibida: traço/hachura distintos + badge **ARMADA** quando o schedule está ativo; **apagada/dessaturada quando desarmada**; **vermelho (`--state-critical`) SÓ na violação** — going-gray da casa = convenção do setor (vermelho é violação, não decoração). | Axis (overlay vermelho só em violação), Rhombus/Verkada (armed/disarmed), requisito ISA-18.2 de estados de supressão visíveis. |

## 2. Modelo (tudo aditivo)

```ts
// src/zones.ts — modo novo (nomeado, E1)
type ZoneMode = "atividade" | "leitura" | "objetos" | "fadiga" | "exclusao" | "proibida";
type Zone = {
  /* ...campos atuais... */
  presencaAlertMs?: number;         // dwell (E2) — presets como idleAlertMs; default 10s
  arming?: "sempre" | "dentro-turnos" | "fora-turnos";   // E4; default "sempre" (24/7)
  // shiftIds reusado da spec irmã quando arming ≠ "sempre"
};
```

- **3 pontos de persistência obrigatórios** (armadilha A5 — campo fora da allowlist é descartado
  MUDO): `Zone`+`withDefaults` (src/zones.ts), **allowlist `cleanZone`+`ZONE_MODES`**
  (server/camcfg.js), e a projeção para o processador (CameraWorkspace).
- **Alarme**: o emit do cliente passa a carregar campos estruturados
  (`{text, ts, cameraId, zona, tipo}`) — hoje só `{text, ts}` e o servidor parseia o texto por
  regex (frágil, armadilha A3). Aditivo: `alarmPolicy.evaluate` já aceita os campos.
- **`tipo:"presenca"`** entra em: `classify()` (server/alarm/classify.js — hoje TUDO cai no default
  "atividade"), `TIPO_LABEL` (AlarmHealthPage — para o shelve por tipo funcionar), `settings.tipos`
  (template WhatsApp próprio: "Presença em área proibida — verificar"). O resto do caminho
  (dedup/flap/flood/shelve/fila/AlarmDrawer/Andon) é **agnóstico a tipo — zero mudança**.

## 3. Onde o alerta NASCE (a correção estrutural)

**F1 — cliente (espelho simétrico):** máquina de estados nova no processador, sinal oposto:
`ARMADA → (pessoa na zona por ≥ dwell) → VIOLADA → (vazia por ≥ off-delay) → ARMADA`, com os
mesmos mecanismos do atual (EMA/ocupação já existem; muda o alvo). Diferenças deliberadas do
espelho: a violação usa **ocupação por pessoa** (classe) como gatilho primário, não motion-EMA
(anti-FP, E2); confirmação = o próprio dwell (não o `confirmMs=0` do ALERTA de inatividade).

**F2 — hub (o produtor que cobre 24/7, armadilha A1):** o pipeline do hub JÁ computa
`people` por zona por janela de ~3s. Uma máquina de estados pequena por zona-proibida em
`server/analysis/pipeline.js` (dwell/off-delay sobre as janelas) chama `alarm/pipeline.handleAlert`
**direto no servidor** (novo produtor server-side — o caminho a jusante é o mesmo).
**Deduplicação hub×cliente:** quando o hub cobre a câmera, o cliente suprime a emissão (o padrão
`hubActive`/`shouldIngest` JÁ existe para ingest — reusar); e a chave de dedup `cam|zona|presenca`
absorve corrida residual.

**Gate de horário (E4):** camada `alarm/shift.js` no `alarmPolicy.evaluate`, logo após o shelve —
o MESMO gate da spec irmã (fora da janela armada → suprime com contador "desarmado por turno",
visível na Saúde de Alarmes).

## 4. Visualização (E6 — as duas direções convivendo)

- **Lista de zonas (ZonasTab):** badge de tipo por zona ("Atividade" | "Proibida") + estado
  ("armada" / "desarmada até 22h") — a distinção primária mora aqui (padrão do mercado).
- **Canvas (draw.ts):** zona proibida com traço tracejado/hachura própria; **ARMADA quieta** =
  contorno neutro + badge discreto; **desarmada** = dessaturada (como zona fora de turno na spec
  irmã); **VIOLADA** = `--state-critical` + fill saturado (o mapeamento por `ZoneState` já pinta
  critical de graça — reusa).
- **AlarmDrawer/relatório:** o card já mostra `tipo` cru — "presenca" aparece automaticamente;
  cor por priority (violação = critical, coerente com o `⚠` atual).

## 5. Critérios de aceite (críticos viram teste)

- **CA-1 (violação):** Given zona `proibida` armada, dwell 10s; When uma pessoa entra e permanece
  12s; Then UM alarme `tipo:"presenca"`, priority critical, com evento de início; When ela
  permanece mais 10min; Then o MESMO evento atualiza duração (sem novo alarme).
- **CA-2 (travessia):** When uma pessoa atravessa em 4s (< dwell); Then NENHUM alarme.
- **CA-3 (coexistência/A3):** Given a MESMA câmera com zona A (atividade) e zona B (proibida);
  When ambas disparam no mesmo minuto; Then DOIS alarmes independentes (chaves de dedup distintas)
  — teste explícito de não-colisão.
- **CA-4 (24/7 sem espectador):** Given hub analisando a câmera e NENHUM dashboard aberto; When
  pessoa viola a zona; Then o alarme dispara (WhatsApp/Andon/fila) mesmo assim. **[F2]**
- **CA-5 (armar por turno):** Given zona proibida com `arming:"fora-turnos"` e turno 06–22; When
  pessoa entra às 23h; Then alarme. When entra às 10h; Then silêncio + contador "desarmado".
- **CA-6 (off-delay):** When a zona esvazia por 3s e a pessoa volta; Then o evento NÃO fecha nem
  reabre (histerese); só fecha após off-delay completo.
- **CA-7 (retrocompat):** zonas existentes (todos os modos atuais) não mudam NADA de
  comportamento; `cleanZone` salva e relê os campos novos (teste de round-trip).

## 6. Fases

**F1 [P — pode andar em paralelo à F1 de turnos]:** modo `proibida` fim-a-fim no CLIENTE:
tipos+allowlist+defaults (3 pontos da A5) · processador espelhado (dwell/off-delay/ciclo de vida)
· painel no ConfigZonaDialog (dwell presets; SEM slider de sensibilidade — o gatilho é pessoa, não
motion; armadilha A4 evitada por design; o preview `predictAlertsPerDay` fica oculto neste modo —
a premissa dele é ociosidade, armadilha do preview) · draw.ts (hachura/badge/critical) · emit
estruturado com `tipo` · classify/TIPO_LABEL/template · testes CA-1/2/3/6/7 + e2e do cadastro.

**F2 [S após F1]:** o produtor no HUB (pipeline.js sobre as janelas de people por zona) +
supressão do emissor cliente quando o hub cobre + CA-4. *(Bônus estrutural: abre o caminho para o
alerta de INATIVIDADE também nascer no hub — pendência registrada, fora do escopo desta spec.)*

**F3 [S após F2 da spec irmã]:** arming por turno (`arming` + `shiftIds`) usando o gate
`alarm/shift.js` compartilhado + CA-5.

**F4:** relatório: KPI "violações por zona" pela dimensão ALARMES (já agnóstica — filtra
`tipo:"presenca"`); **NÃO gravar no bucket `ativ.alerts`** (armadilha A7: misturaria com os
alertas de ociosidade e poluiria o KPI existente).

## 7. Fora de escopo v1

Separação detecção×notificação (Verkada-style); tamanho mínimo de objeto; filtro de classe além de
pessoa (veículo/empilhadeira — extensão do `selectedClasses` já existente, adiada); histerese dupla
de motion (Genetec); loitering com trajetória; migração do alerta de INATIVIDADE para o hub
(pendência própria, destravada pela F2); re-notificação por múltiplos configurável (v1: fixo).

## 8. Riscos e mitigações (das 8 armadilhas do mapa)

| risco | mitigação |
|---|---|
| A1/A2 — alerta só nasce no cliente | F2: produtor no hub sobre dado que ele JÁ tem (people/zona) |
| A3 — colisão de dedup entre direções | tipo próprio `presenca` + emit estruturado + CA-3 |
| A4 — sensibilidade compartilhada com semântica invertida | modo proibida NÃO usa o slider; gatilho = pessoa + dwell |
| A5 — allowlist descarta campo novo mudo | os 3 pontos na mesma task + teste round-trip (CA-7) |
| A6 — `⚠`=critical + confirm 0ms + flood com atividade contínua | dwell é a confirmação; ciclo de vida com off-delay + throttle (E3) |
| A7 — bucket ativ.alerts misturaria direções | violações vão à dimensão ALARMES; bucket intacto |
| A8 — turno fora do caminho de alarme | gate único `alarm/shift.js` compartilhado com a spec irmã |
| FP de atividade > FP de inatividade | classe pessoa + dwell + off-delay (E2/E3) — o kit padrão do setor |
