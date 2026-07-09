# Tags Bluetooth → identidade aumentada na câmera — avaliação + plano

> Pedido: pessoas usam tags BLE; uma "estação" (celular/PC/antena) detecta as tags; a câmera DESTACA a
> pessoa com o rótulo da tag (realidade aumentada). Substituir reconhecimento facial (mais barato). Medo
> declarado do dono: muitas tags em cena → o sistema confunde qual é qual. **Isto é uma avaliação + plano,
> sem código.** Honestidade técnica primeiro (CLAUDE.md §2.5).

## 1. A REFORMULAÇÃO que torna o problema tratável

O pedido, como descrito ("achar a antena na câmera e, a partir dela, definir a posição da tag e desenhar"),
esbarra na física: **um receptor BLE não dá posição — dá um RAIO** (distância grosseira por RSSI, ±2-5 m,
pior com o corpo na frente). Uma antena só = um anel, não um ponto. Desenhar a tag no pixel certo a partir
de UMA antena **não é fisicamente possível** com precisão.

**Mas a gente NÃO precisa disso.** A câmera **já detecta e rastreia pessoas com precisão de pixel** (é o
motor deste projeto). Então o problema real não é "onde a tag está na imagem" — é **ASSOCIAÇÃO**: _qual
pessoa rastreada (caixa) corresponde a qual tag._ Invertendo:

> **A câmera LOCALIZA (pixel-exato). O BLE só IDENTIFICA (dá nome a uma pessoa já rastreada).**

Com isso o rótulo segue a **caixa rastreada** da pessoa (preciso, de graça — reusa o `analysis-tracks`), e o
BLE só precisa ser bom o bastante pra **desambiguar** quem é quem — não pra posicionar. Isso transforma um
problema de localização (difícil) num de associação (tratável) e reusa tudo que já temos.

## 2. A física do BLE (o que define o custo e a precisão)

- **RSSI → distância é RUIDOSO:** multipath, absorção pelo corpo (tag no peito vs nas costas muda muito),
  orientação, interferência. Sozinho, ordena "perto/longe" mal.
- **1 estação = proximidade** (anel). **2D exige ≥3 estações (trilateração)** OU antena de **AoA** (BLE 5.1
  Direction Finding, hardware especial) OU **UWB** (banda ultralarga, precisão decimétrica, tag/âncora mais caras).
- **Sinais que AJUDAM a desambiguar (a chave contra o "confunde qual é qual"):**
  - **Movimento (tag com IMU/acelerômetro):** correlacionar "tag se moveu" com "a pessoa rastreada andou".
    Forte — muitas tags baratas já têm IMU.
  - **Tendência de RSSI:** pessoa se aproxima → caixa cresce E RSSI sobe juntos → casa o par.
  - **Entrada/saída:** tag entra no alcance ao mesmo tempo que uma pessoa entra no campo → match tentativo.
  - **Trilateração (≥3 estações):** XY grosseiro → projeta no chão via homografia → casa com o PÉ da pessoa
    mais próxima. O mais robusto p/ muitas pessoas.

## 3. "Medir distância na câmera" = CALIBRAÇÃO (homografia)

Pra mapear posição do mundo ↔ pixel (medir distância real, projetar XY do BLE), a câmera fixa sobre um chão
plano precisa de uma **homografia** (matriz 3×3 de 4+ pontos conhecidos no piso). É um setup 1×/câmera
(marcar 4 pontos no chão). Útil por si só (medir distância/velocidade/área em metros) e necessário só a
partir do Tier 2 (trilateração). No Tier 0-1 (associação por proximidade/movimento) **nem precisa**.

## 4. Tiers (ambição × custo — o dono escolhe até onde ir)

| Tier | Como associa | Aguenta quantas pessoas | Hardware | Custo |
|---|---|---|---|---|
| **0** | Proximidade RSSI, 1 estação | 1-2 (confunde com +) | 1 scanner (ESP32/celular) | ~R$25 |
| **1** | Fusão: RSSI-trend + MOVIMENTO (tag c/ IMU) × tracking da câmera | ~3-6 | 1 scanner + tags c/ IMU | baixo |
| **2** | Trilateração 3 estações + homografia → casa com o pé | muitas | 3 scanners/área + calibração | médio |
| **3** | BLE AoA ou **UWB** (decimétrico) | muitas, preciso | âncoras UWB + tags UWB | maior |

**O medo do dono é real no Tier 0.** RSSI de 1 antena não separa muita gente. A resposta é subir pro Tier 1
(fusão com o movimento — barato) ou Tier 2 (trilateração). O custo continua << facial só até o Tier 2.

## 5. O que precisa ser construído (componentes)

1. **Registro de tags (o que você pediu):** tabela `bt_tags` (id, bt_name, rótulo/pessoa, ativo). Cadastro
   pelo nome do Bluetooth. `schema.sql` aditivo, queries parametrizadas (invariante SQL).
2. **Estação/scanner:** um dispositivo que varre BLE e reporta `{tagId, rssi, ts, stationId}` ao hub. Melhor
   fit: **ESP32** (barato ~R$25, WiFi+BLE, firmware scanner, fixo e confiável) — celular escaneia mas o SO
   estrangula BLE em background; PC com dongle serve pra bancada. Contrato socket/HTTP novo, ADITIVO.
3. **Calibração de câmera (homografia)** — Tier 2+: UI pra marcar 4 pontos do chão + storage. (Fase depois.)
4. **Camada de FUSÃO/associação** (o núcleo difícil): custo por par (tag × pessoa rastreada) combinando
   proximidade + correlação de movimento + posição; atribuição (Hungarian). Saída: cada pessoa rastreada
   ganha uma identidade de tag (ou nenhuma). É onde o "confunde qual é qual" se resolve — de verdade e medido.
5. **Overlay AR:** desenha o rótulo da tag na caixa da pessoa associada (reusa `analysis-tracks` — pixel-exato).

## 6. Plano faseado (spike → plumbing → fusão → AR)

- **Fase 0 — SPIKE (de-riscar a física ANTES de construir):** medir RSSI real no ambiente do CD — 1 scanner,
  2-3 tags, pessoas andando. _RSSI separa 2-3 pessoas às distâncias reais?_ Isso decide qual Tier é viável.
  Barato, e a doutrina manda (medir o gargalo — aqui é a localização — antes de investir). **Sem isso, o
  resto é chute.**
- **Fase 1 — Registro + ingest:** tabela `bt_tags` + cadastro por bt_name (UI) + estação reportando RSSI ao
  hub + tela crua "tags vistas + RSSI". Prova a ponta-a-ponta do BLE, baixo risco, entrega visível.
- **Fase 2 — Fusão Tier 1:** associar tag↔pessoa por proximidade + movimento (tags c/ IMU), medido no eval
  (quantas pessoas antes de errar). Overlay AR do rótulo na caixa. **É aqui que "aponta a tag na câmera" vira real.**
- **Fase 3 — Escala (Tier 2, se preciso):** 3 estações + homografia → trilateração → casa com o pé. Só se a
  Fase 0/2 mostrar que 1 estação não basta pra densidade do CD.

## 7. Riscos e LGPD (declarados)

- **Ruído de RSSI** (corpo, orientação) — o maior; a Fase 0 mede. Se reprovar, Tier 2/UWB.
- **Sincronização** BLE (~1 Hz) × câmera (fps) — alinhar por timestamp (temos o `latencyMs` do overlay).
- **Ambiguidade com aglomeração** (caixas sobrepostas + RSSI parecido) — a fusão precisa de confiança + "não
  sei" honesto (melhor sem rótulo que rótulo errado).
- **LGPD:** rastrear pessoa nomeada por tag é MENOS invasivo que biometria facial (sem dado biométrico), mas
  a tag↔pessoa É dado pessoal. Aplicam-se os invariantes (só metadados, sem imagem persistida) + consentimento/
  finalidade. Registrar como o facial exigiria (a tag é a alternativa deliberada, mais barata E menos invasiva).

## 8. Recomendação

1. **Fase 0 (spike de RSSI)** primeiro — 1 tag, 1 scanner, medir. De-risca tudo por ~R$25.
2. Em paralelo, **Fase 1 (registro + ingest)** — é plumbing seguro e independente da física (a tabela que
   você pediu + a estação + tela crua). Entrega valor cedo e não depende do resultado do spike.
3. **Fusão (Fase 2)** guiada pelo número do spike — Tier 1 se RSSI+movimento bastar; Tier 2 se precisar escala.
4. O rótulo AR sai **de graça** no fim (reusa o overlay) — o difícil é a associação, não o desenho.

**Decisões que definem custo/complexidade (preciso de você):** (a) densidade típica — quantas pessoas COM
tag numa mesma cena? (b) as tags têm **IMU/acelerômetro**? (c) topo do orçamento — dá pra 3 estações/área
(Tier 2) ou tem que ser 1 (Tier 0-1)? (d) precisão desejada — "destacar a pessoa certa" (associação) basta,
ou querem posição métrica (metros)?
