# Plano — Modo "Leitura de código de barras" (no mesmo projeto)

> Plano em **2026-06-09**. **Substitui** a ideia anterior de RFID (`portal_rfid_mvp`): agora é **leitura de código de barras por câmera**, implementada como um **modo de câmera** dentro do `visao_computacional_mvp`. Mesma base; muda a aplicação da câmera. **Sem código ainda.**

---

## 1. A visão
Uma **esteira** com **caixas passando** e **câmeras lendo os códigos de barras**. Como o código pode estar em qualquer lado da caixa, usa-se **N câmeras (ex.: 10) apontando para o MESMO ponto** da esteira — se **qualquer** uma ler, a caixa foi lida.

A estrutura do sistema é **quase igual** à atual; o que muda é **para que a câmera serve**:
- **Atividade** (hoje): mede ocupação/ociosidade/gargalo de um setor.
- **Leitura** (novo): decodifica o código de barras das caixas.

➡️ **Mesmo projeto, dois modos de câmera** → painéis diferentes e relatórios diferentes por modo.

---

## 2. Conceito-chave: Ponto de Leitura (cluster de câmeras)
- Um **Ponto de Leitura** = um trecho da esteira coberto por **N câmeras** de vários ângulos.
- Uma **caixa** é considerada **lida** se **qualquer** câmera do ponto leu seu código → **dedup** por `(ponto, código, janela de tempo)` (ex.: mesmo código em 200ms = mesma caixa).
- Métricas por ponto: **taxa de leitura %**, **throughput** (caixas/min), **no-reads** (caixa passou e ninguém leu), **multi-reads**, e **contribuição por câmera** (qual ângulo lê mais — ótimo para avaliar/posicionar câmeras).

---

## 3. O que muda tecnicamente (a "visão")
- Câmera em **modo Leitura** troca o pipeline de movimento/coco-ssd por **decodificação de código de barras** no feed:
  - **`BarcodeDetector` API** (nativa em Chrome/Edge) quando disponível; fallback **`@zxing/library`** (ZXing) nos demais navegadores.
  - Formatos configuráveis: **EAN‑13/8, Code128, Code39, ITF, QR, DataMatrix**.
- Cada leitura → evento `{ cameraId, pontoLeitura, code, format, conf, ts }` → hub → central (mesmo canal socket).
- **Detecção de no-read:** reusar o **detector de movimento atual** para saber que "passou uma caixa" no ROI; se houve passagem sem leitura na janela → **no-read** (alerta). É a sinergia entre os dois modos.

---

## 4. Telas (mesma base; painéis/relatórios por modo)

### 4.1 Central
- **Câmeras de leitura agrupadas por Ponto de Leitura.** O tile de cada câmera (modo leitura) mostra: últimos códigos lidos, **contribuição** (quantas leu), status (LENDO / SEM LEITURA / OFFLINE).
- **Card do Ponto** (agrega o cluster): **taxa de leitura %**, throughput, no-reads recentes, último código.
- **Drill-in do Ponto:** feed de códigos em tempo real · **cobertura por câmera** (% das leituras por ângulo) · no-reads recentes · alerta de **queda na taxa**.
- Câmeras em **modo atividade** seguem com a central atual (zonas/estados). A central mistura os dois conforme o modo de cada câmera.

### 4.2 Nó `/camera`
- Mesmo nó; em modo leitura, o feed mostra os **códigos lidos** sobrepostos (sem controles). Envia leituras ao hub.

### 4.3 Relatório
- **Seletor/filtro de modo** (Atividade × Leitura).
- **Modo Leitura — KPIs:** caixas lidas · **taxa de leitura %** · no-reads · throughput médio · multi-reads.
- **Abas:** **Quando** (throughput/no-reads por hora) · **Onde** (por Ponto de Leitura e **contribuição por câmera**) · **Tendência** (turno/dia) · **Leituras** (tabela: código, ponto, câmera, hora) e **No-reads**.
- Mesmo padrão (IndexedDB, só indicadores; export CSV/PDF).

### 4.4 App shell
- Igual (rail Central/Relatório).

---

## 5. Estados (modo leitura)
- **Câmera:** LENDO (decodificando) · SEM LEITURA (passou caixa, não leu) · OCIOSO (esteira parada) · OFFLINE.
- **Ponto:** OK (taxa alta) · ATENÇÃO (taxa caindo) · CRÍTICO (no-reads acima do limite) · PARADO (sem caixas).

---

## 6. Configurações novas (por câmera / por ponto)
- **Por câmera:** `modo` (atividade | leitura) · **Ponto de Leitura** (a que cluster pertence) · **formatos** habilitados · **ROI de leitura** (onde na imagem decodificar).
- **Por ponto:** janela de dedup · throughput esperado · **limite de taxa** p/ alerta (ex.: alertar se taxa < 98%) · nº de câmeras.

---

## 7. Estrutura no mesmo projeto (sem novo repo)
- `Camera`/zona ganham `modo` e `pontoLeitura`.
- `CameraView` ramifica por modo: **atividade** = pipeline atual; **leitura** = decodificação + emissão de códigos (pode virar um `LeituraView` reusando o shell de feed/tile/full).
- **Central** agrupa por Ponto quando há câmeras de leitura.
- **Relatório**: o `store` ganha tipo de registro (atividade × leitura); agregações próprias por modo.
- **Hub**: mesmo (relé de frames + agora também eventos de leitura).

---

## 8. Modelo de domínio (leitura)
- **Leitura** = `{ code, format, pontoLeitura, cameraId, conf, ts }`.
- **Caixa** (inferida) = uma passagem pela esteira; **lida** se houve leitura na janela; **no-read** se passou sem leitura.
- **Ponto de Leitura** = `{ id, label, unidade, cameras[], throughputEsperado, limiteTaxa, formatos[] }`.
- *(Opcional/futuro)* **Conferência por código**: se houver um manifesto/pedido esperado, comparar códigos lidos × esperados (herda a ideia do RFID) → OK/divergência.

---

## 9. POC sem hardware
- **Webcam apontada para códigos impressos** já lê de verdade (BarcodeDetector no Chrome).
- **Clipe de esteira** em loop como fonte de uma câmera.
- **Simulador de leituras**: gera caixas passando, com taxa de no-read configurável, para demonstrar taxa/throughput/alertas sem hardware.

---

## 10. Fases
- **F0** — `modo` na câmera + seletor na config; Ponto de Leitura no modelo.
- **F1** — pipeline de leitura (BarcodeDetector/ZXing) + emissão + **dedup por ponto** + **central agrupada por ponto** (card do ponto + taxa/throughput). *Primeiro valor.*
- **F2** — relatório modo leitura (KPIs, abas, contribuição por câmera).
- **F3** — **no-read** (cruzar movimento × leitura) + alertas de queda de taxa.
- **F4** — manuais (formatos, posicionamento das câmeras), multi-unidade, export.

---

## 11. Pontos a confirmar
- **Formatos** de código usados (EAN? Code128? QR? DataMatrix?).
- **Throughput** (caixas/min) e **taxa de leitura alvo**.
- Há um **esperado/manifesto** por caixa (para conferência por código) ou só **taxa de leitura/no-read** (sem comparar a um esperado)?
- Integração **ERP/WMS** (enviar as leituras? comparar?).
- **Nº de câmeras por ponto** e **nº de pontos por unidade**.
- Câmeras (IP/RTSP já suportado) — modelo, FPS, resolução p/ leitura.

---

## 12. Stack
Mesma do `visao_computacional_mvp` (React 19 + TS + Vite · socket.io · IndexedDB · Node hub) + **BarcodeDetector / @zxing/library** para decodificação. Telas sem scroll, relatório em abas, app shell. Ver `VISAO-GERAL.md`.

> **Status:** plano. Próximo: **F0+F1** (modo leitura + ponto + central agrupada) — dá para validar com a webcam lendo códigos impressos, sem hardware.
