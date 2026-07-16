# SPEC — "Está na zona de trabalho?" só com BLE (+ base da taxa de ocupação)

> Data: 2026-07-15 · Prazo do dono: **~2 h** · Origem: pedido direto ("uma tela — o mapa 2D — em que
> eu diga com certa precisão se a tag/operador está ou não numa zona de trabalho, perto ou longe da
> antena; depois, uma aba no dash com taxa de ocupação da zona").
> Fonte de verdade desta entrega. Relacionados: `docs/analises/tags-bluetooth/guia-hibrido-camera-ble.md`
> (§11.2: zona é o uso recomendado do BLE), `requisitos-localizacao-planta-2d.md`, memória de campo jul/15.

## 1. A resposta à pergunta de viabilidade

**SIM — só com BLE dá, PARA ZONA (não para X,Y métrico).** É exatamente o caso que o projeto já
validou em campo: classificação de zona por fingerprinting (kNN em dB) acertou **15/15 em 3 rodadas
cegas** com margens de 30–40 dB entre zonas (jul/15, 3 antenas + 10 tags reais). Zona é o que o RSSI
compra sem inventar; X,Y contínuo é o que ele não compra (refutado 2×).

Ressalvas honestas (Regra 10/11):
- A validação 15/15 foi no caso FÁCIL (pontos em cima das antenas). **Zona longe de antena** usa o
  mesmo mecanismo (ponto de survey intermediário — o botão já existe), mas a margem cai — o gate de
  campo desta entrega (§5-F4) é quem diz a precisão real, com n e IC.
- Zonas muito próximas entre si e longe de qualquer antena (< ~5 m de separação) podem confundir —
  o spread medido entre tags coladas é 13 dB. Se o gate reprovar uma zona: mais amostras de survey
  ou reposicionar/adicionar antena.
- Tags com advertising mais rápido (o dono está configurando agora) melhoram TUDO aqui: mais
  medições distintas por captura e por poll → assinatura mais estável, decisão mais rápida.
  **Recomendação: 300–500 ms.** Abaixo de ~500 ms o app da estação começa a descartar o excedente
  (guarda a última leitura por MAC por POST de 500 ms) — não prejudica a zona (é média), mas não
  ganha mais nada; e advertising ≤200 ms come bateria sem retorno para este caso de uso.

## 2. O que JÁ existe (não construir de novo)

- Mapa 2D com antenas posicionadas + tags ao vivo (`/planta-ble`).
- Captura de assinatura por ponto (`ZoneCalibration` + `useFingerprints.capture` — ~10 s, pool por
  estação) com auto-validação; pontos em cima de antena ganham x,y da antena.
- Classificação ao vivo por tag (`liveByMac` → `classify()` kNN em dB) com confiança
  `alta/media/baixa/nenhuma` exigindo ajuste absoluto (commit `c4b7b6a`).
- Zona já aparece como texto na lista da tela ("📍 zona · confiança").

## 3. Os 3 buracos que esta entrega fecha

1. **A decisão oscila**: a classificação é por poll (~2 s), sem memória — a zona da tag pode piscar
   entre polls. Falta histerese temporal (decisão ESTÁVEL entra/sai).
2. **Ponto intermediário não tem x,y** (`ZoneCalibration.tsx:129` passa `xy=null`) — a zona longe de
   antena não aparece no mapa.
3. **Não há a leitura de produto**: "operador X está na zona Y há N min" — hoje é rótulo técnico por
   tag, sem estado nem tempo.

## 4. Critérios de aceite

- **CA-1 (decisão estável):** Given tag parada numa zona calibrada; When a classificação aponta a
  zona com confiança ≥ media por K polls consecutivos; Then a tag entra no estado "na zona Y" e NÃO
  oscila com 1 poll divergente (sai só após K polls apontando outra/nenhuma).
- **CA-2 (honestidade):** Given classificação com confiança `baixa`/`nenhuma`; Then ela NUNCA conta
  para entrar numa zona (rótulo errado é pior que nenhum); ausência de leituras → estado "incerto"
  (não derruba a zona imediatamente; TTL).
- **CA-3 (zona longe de antena):** Given ponto intermediário calibrado com x,y marcado no mapa; Then
  ele aparece desenhado na planta e funciona como zona igual às das antenas.
- **CA-4 (leitura de produto):** a tela mostra, por operador (tag): zona atual (ou fora/incerto) e
  **desde quando** — no mapa (cor/badge) e na lista lateral.
- **CA-5 (gate de campo):** 3 rodadas cegas nas zonas REAIS (incluindo ≥1 longe de antena),
  resultado reportado como proporção com n e IC de Wilson. É o gate de "com certa precisão".

## 5. Plano das 2 h

- **F0 (dono, em paralelo — JÁ em curso):** reconfigurar as tags (alvo 300–500 ms).
- **F1 (~35 min, código):** `src/fusion/zone-presence.ts` — módulo PURO + testes. Entrada: sequência
  de `{ts, zona, confianca}` por tag. Estado: `{zona: string|null, estado: "na-zona"|"fora"|"incerto",
  desde: ts}`. Knobs: `entrarAposPolls=3` (~6 s), `sairAposPolls=3`, `ttlIncertoMs=10000`, confiança
  mínima `media`. Sem UI, sem IO — testável em minutos.
- **F2 (~40 min, código):** fiação e UI na Planta BLE:
  (a) ponto intermediário ganha x,y — botão "Calibrar ponto" passa a pedir um clique no mapa (ou
  digitar x,y) antes de capturar; fingerprint salvo com `x,y`; desenhado na planta com nome;
  (b) `useFloorplanMap`/página alimentam `zone-presence` com o `liveByMac` a cada poll;
  (c) tag no mapa colorida pelo estado (na zona de trabalho = ok; fora = neutro; incerto = tracejado
  — going-gray) + lista lateral "operador → zona → há quanto tempo".
- **F3 (~20 min, campo, dono+tela):** calibrar as zonas de trabalho REAIS (em cima das antenas +
  pontos intermediários das zonas longe), já com as tags rápidas. ~10 s por ponto, 1–3 amostras por
  zona.
- **F4 (~15 min, gate):** rodadas cegas do CA-5. Se alguma zona reprovar → mais amostras ou mover
  antena (walk-test); reportar o número honesto.
- Folga: ~10 min.

## 6. Fase seguinte: "operador na mesa + tempo no turno" (pendências detalhadas, 2026-07-15)

> Alvo declarado pelo dono: tela que mostra o operador na mesa trabalhando e o tempo que ele passou
> lá no turno do dia. Estado após a entrega das 2 h: presença estável por zona JÁ existe no cliente
> (`zone-presence.ts` + mapa/lista). O que falta, numerado:

- **P1 — Acumulador de tempo-por-zona no HUB (a pendência central, ~2–4 h).** A presença hoje roda
  no NAVEGADOR (poll de 2 s) e morre quando a aba fecha — "tempo do turno" exige cômputo 24/7 sem
  espectador (a MESMA lição do ADR-009 para o vídeo). Trabalho: espelhar `classify()` +
  `zone-presence` em JS no hub (`server/bt/`, espelho declarado — precedente `precision.js`⇄eval,
  risco de deriva registrado); loop de ~2 s sobre o snapshot `bt-readings` + fingerprints; acumular
  intervalos `{tag, zona, entradaTs, saidaTs}`. **ADR curto antes de persistir** (primeira vez que
  trajetória-de-zona vira histórico; é metadado da classe dos alarm-events — permitido pelo espírito
  do ADR-002, mas a decisão + retenção precisam de registro). Tabela aditiva `bt_zone_sessions` no
  `schema.sql` + fallback JSON (padrão da casa).
- **P2 — Corte por turno (~1 h).** O hub JÁ tem turnos (`shifts.js`/`shift-clock.js`). Falta a
  função pura "soma de intervalos ∩ janela do turno de hoje" por (operador, zona) + endpoint
  aditivo `GET /api/bt/ocupacao`.
- **P3 — A tela (~1–2 h).** Aba no dash: operador × zona × tempo no turno (+%), com os estados
  honestos SEPARADOS — tempo confirmado "na zona" ≠ tempo "incerto/sem cobertura" (nunca somar
  incerto como presença). Nomes de métrica: **"taxa de ocupação de zona"**, nunca "eficiência do
  operador" (PENDENCIAS §8 — "ocioso" é acusação; o sistema mostra presença medida, o humano
  conclui).
- **P4 — Campo: calibrar as MESAS como zonas (30 min + gate).** Cada mesa de trabalho vira ponto de
  survey (com X,Y para aparecer no mapa). **ORDEM IMPORTA: só depois de fechar a configuração das
  tags** (potência/intervalo mudam o RSSI médio → survey capturado antes fica inválido). Depois, o
  gate CA-5 (rodadas cegas, n + IC).
- **P5 — Vínculo tag→operador: PRONTO** (`bt_tags.rotulo`); só manter o cadastro em dia.
- **P6 — Honestidade de cobertura (~1 h).** Estação calada = "sem dados", NÃO "fora da mesa": o
  relatório de turno precisa marcar janelas sem cobertura de antena (o bug B6 — estação cega sem
  alarme — vira mentira de relatório aqui). Mínimo: faixas "sem cobertura" na tabela + total de
  tempo não observado.
- **P7 — Config das tags (dono, INTERROMPIDA em 2026-07-15).** O app DX-SMART no S24
  (`com.dxlq.ibeacon`) mostra as CP27 anunciando 4 frames (iBeacon/UID/URL/TLM) com intervalo
  efetivo ~300–500 ms por MAC. Alvo recomendado: 1 frame (iBeacon) a 300–500 ms, TX power igual em
  todas, sem mudar MAC/nome. Não bloqueia P1–P3; bloqueia P4 (survey depois da config).

Ordem: ADR + P1 → P2 → P3 (código, ~1 dia) · P7 → P4 (campo) · P6 junto do P3.

## 7. Fora de escopo desta entrega

X,Y métrico melhorado; filtro de movimento (G1 dos requisitos); planta com imagem/paredes; câmera e
fusão (o híbrido do guia); multi-turno/relatório histórico; alarmes de zona.

## 8. Riscos declarados

| risco | tratamento |
|---|---|
| Zona longe de antena com margem baixa | O gate F4 mede; mitigação: mais amostras de survey, reposicionar antena. Não prometer antes do gate. |
| Zonas vizinhas se confundem | Idem — e o estado "incerto" existe exatamente para empate (a histerese não troca de zona por 1 poll). |
| Tags reconfiguradas mudam o RSSI médio (potência/intervalo novos) | **Recalibrar o survey DEPOIS da reconfiguração** (F3 vem depois de F0 por isso — assinaturas capturadas com a config antiga podem não transferir). |
| 10 tags no mesmo ponto durante captura | O pool por estação já agrega todas as tags do ponto (desenho atual) — ok por construção. |
