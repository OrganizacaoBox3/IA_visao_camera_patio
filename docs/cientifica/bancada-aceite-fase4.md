# Bancada de simulação — aceite formal (§9) e revisão adversarial (Fase 4)

> Fecha o ciclo de `docs/cientifica/simulador.md` contra a regra a priori do próprio doc (§9:
> "v1 está pronta quando…"). Checklist conferido item a item com evidência executada (não
> relatada de segunda mão), + o resultado da revisão adversarial (2 revisores independentes com
> mandato de REFUTAR). Data: 2026-07-11.

## Checklist §9 (regra a priori do escopo)

| # | Critério | Veredito | Evidência |
|---|---|---|---|
| 9.1 | Os cenários atuais, reescritos como World Specs, reproduzem os pinos do CI **bit-a-bit** | ✅ | `world-spec.test.ts` — 13 testes, `toEqual` profundo dos 12 cenários de `FUSION_SCENARIOS` pelos dois caminhos; roda em todo CI |
| 9.2 | O MESMO player abre uma gravação sintética e uma sessão real existente | ✅ | Smoke test executado (2026-07-11) contra `server/bt/fusion-session.jsonl` REAL (leitura pura): 8 943 linhas (1 suja descartada), 19 509 ticks, 596 tracks, 3 câmeras vistas; o MESMO `derivePlayerFrame`/`sessionWorldDomain` do sintético rodou sem adaptação. Nota honesta: a gravação real tem `H:null` na câmera default (sem calibração salva no momento da gravação) → planta cai no fallback 8×6 declarado |
| 9.3 | Uma família ponta-a-ponta (≥20 seeds/ponto, IC) sai por um comando | ✅ | `npm run family -- <nome>` (scripts/family.mjs) — 4 famílias, todas rodadas de verdade com curva completa |
| 9.4 | Sessão real anotada no player exporta SessionTruth consumido por `replayFusionSession` sem adaptação manual | 🟡 **mecanicamente ✅, cientificamente pendente** | Encanamento validado com verdade dummy sobre a gravação real: `replayFusionSession(lines, truth)` rodou sem adaptação (19 344 ticks avaliados; associador absteve em todas as 1 144 oportunidades — honesto com verdade dummy e sem calibração). A validação CIENTÍFICA exige a gravação do teste de campo com verdade REAL anotada — segue gated pelo item nº 2 do backlog (disponibilidade do dono) |

## Previsões falseáveis do escopo (§8) — estado

- **(a)** dropout estruturado → assinatura de erro diferente do iid: **NÃO TESTADA ainda** (a
  oclusão estruturada existe em `sim.ts`, mas nenhum experimento comparou a distribuição de
  id-switches em bordas de oclusão vs uniforme — anotado como pendência de baixa prioridade).
- **(b)** curva precisão×pessoas tem joelho: **mais próxima de REFUTADA** (veredito corrigido
  pela revisão adversarial — ver seção abaixo): normalizado por decisões, `wrongRate` satura
  (2,4%→~5,5%, curva côncava) em vez de acelerar; o "wrong 10→87" era crescimento de denominador.
  O que degrada com densidade são cobertura (41%→17,7%) e precisão (89,6%→72,2%), suavemente.
- **(c)** erro de âncora não move precisão de identidade: **CONFIRMADA** — 86,5% em todos os
  pontos (0..2 m), decomposição bit-idêntica; virou sensor permanente no CI (se gate/blend
  voltarem aos defaults criando o acoplamento, o teste falha com "ACHADO: acoplamento escondido").

## Revisão adversarial — achados (2 revisores independentes, mandato de refutar)

A revisão pagou a fase: **2 achados CRÍTICOS que invalidaram números já reportados ao dono**, mais
2 críticos/altos de mecanismo e uma coleção de médios/menores. Todos corrigidos no mesmo dia
(3 frentes de correção paralelas, propriedade exclusiva de arquivo). Registro completo:

### CRÍTICOS (mudavam conclusão científica)

1. **Sinal do viés corporal INVERTIDO** (`sim.ts`): a fórmula somava `+bodyDb` quando atenuação
   corporal SUBTRAI (a docstring prometia atenuação; obstáculos ao lado já subtraíam). A curva
   ×viés corporal originalmente reportada ("84%→14,7%, o eixo mais agressivo") mediu um mundo
   anti-físico — **número retratado**. O bug estava até no doc-fonte (`simulador.md` §4 escrevia
   `+bodyBias(θ)` — corrigido com nota datada). **Curva RE-MEDIDA com o sinal correto (20
   seeds/ponto)**: 84,0% (0dB) → **sobe** para ~90% (4-12dB) → cai suave para 80,4% (24dB).
   Não-monotônica e fisicamente coerente: viés direcional moderado REFORÇA a correlação
   RSSI↔distância (andar de costas para a estação soma atenuação à queda de path-loss — mais
   sinal para o associador); doses altas adicionam variância não-radial e degradam. O eixo NÃO é
   "o mais agressivo" — era artefato.
2. **A conclusão "joelho na decomposição" NÃO sobreviveu à normalização** (achado C1 do revisor
   2): o `wrong` 10→87 na curva ×pessoas era majoritariamente crescimento do DENOMINADOR (nº de
   decisões cresce ~3,5× no eixo). Normalizado, `wrongRate` **satura** (2,4%→5,3%→platô ~5,5%),
   curva côncava — o oposto de aceleração. E `people=2` é incomparável (1 tag → swap impossível;
   ali wrong=falseLabels). **Previsão (b) do escopo re-avaliada: mais próxima de REFUTADA** — o
   que degrada de verdade com densidade são cobertura (41%→17,7%) e precisão (89,6%→72,2%), em
   declive suave. Correção estrutural: `FamilyPoint` agora carrega `wrongRate`/`swap`/
   `opportunities` — a armadilha da contagem absoluta não se repete.
3. **AR(1) sub-ruidoso no transitório** (`sim.ts`): estado iniciava em 0 (var[k]=1−ρ^2k) — para
   τ=32s, variância era 6% do nominal no tick 0 e 45% ao fim do warmup. Corrigido: 1ª atualização
   semeia o estado estacionário (ε puro). Medido pós-correção: var normalizada 0,980 no tick 0.
   Era bomba armada, não detonada (nenhuma família comitada usava τ ainda).

### MÉDIOS (comportamento surpreendente/enganoso — corrigidos ou documentados)

- Legenda do CLI mentia: "wrong (pessoa↔pessoa)" quando `falseLabels ⊂ wrong` (dupla contagem
  em quem somasse as colunas). Corrigido: coluna `swap` (=wrong−falseLabels, o pessoa↔pessoa
  real) + legenda "wrong (total, inclui falseLabels)".
- IC "95%" por bootstrap percentil com n=20 tem cobertura real medida de ~88-93% — agora
  declarado no header e na legenda do CLI; o teste-sentinela da previsão (c) ganhou nota de
  baixo poder (detecta só acoplamento grosseiro; o sinal forte é a decomposição bit-idêntica).
- `sessionWorldDomain` com gravação que começa vazia (câmera ligada antes do roteiro) enquadrava
  só a estação — TODOS os tracks fora do canvas. Corrigido: amostra os primeiros N ticks COM
  tracks.
- Semântica de obstáculo documentada (não corrigida — decisão de modelagem): segmento
  inteiramente dentro do polígono = transparente; walkers atravessam obstáculos; obstáculo que
  contém a estação → modelar como `rssiRegions`.
- Teste "byte-compat" do AR(1) testava determinismo, não compat — renomeado; a byte-compat real
  é selada pelos 12 pinos do CI.

### MENORES (corrigidos)

- `parseSessionTruthJson` aceitava chave `""`→track 0 (corrupção silenciosa), hex, notação
  científica, fracionários — agora exige `/^-?\d+$/` e normaliza o valor (trim+uppercase).
- `exportSessionTruth` com MAC de espaços produzia `""` (= "tag inalcançável" na métrica, e
  descartado no re-import — round-trip quebrado) — agora omite do export.
- Import de truth com trackIds órfãos inflava o resumo — filtrado na página com aviso.
- Pintura null vs ausente indistinguíveis — agora 3 estados visuais (tag=verde, sem-tag=âmbar,
  não-anotado=neutro).
- Docstring de `bodyBiasDb` com justificativa errada da guarda; margem de 5% do span do fit no
  eixo do anchor-error sem guarda — ambos documentados + teste-guarda do span.

### Verificados CORRETOS (ausência de defeito com evidência)

`anchorPosErrorM` nunca invalida o fit no eixo 0..2m (dist mínima 0,6m > corte 0,3m; span máx
0,3802 < 0,4 — com teste-guarda novo); convenção angular do bodyBias correta (fora o sinal);
nenhuma assimetria esquecida com `stationAtCamera`; CLI robusto a exit codes (falha nunca vira
exit 0 silencioso); determinismo bit-a-bit das famílias; fallbacks do domínio; wiring do player
(bail-out de re-render, LGPD do arquivo no cliente, reset coerente ao trocar de fonte).

## Veredito da Fase 4

Aceite §9: 3 de 4 critérios ✅ plenos; §9.4 mecanicamente ✅ (cientificamente gated pelo teste de
campo). Revisão adversarial: executada com dentes — 2 números já reportados foram retratados e
re-medidos, 3 mecanismos corrigidos, e a infraestrutura ganhou os sensores que impedem os mesmos
erros de voltarem (colunas normalizadas, teste-guarda do span, sensor da previsão (c) no CI).
**A bancada v1 está aceita** — com o gate de sempre: números de simulador informam construção;
DEFAULT de produção só com dado real.
