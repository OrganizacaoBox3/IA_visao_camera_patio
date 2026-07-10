# Visão de Pátio — Visão geral do projeto (estado atual)

> Consolidação em **2026-06-09**. Leitura única do projeto como um todo. POC de visão computacional industrial.
> Origem do conceito: `document_pdf.pdf` (proposta Box3.work / Tiago Lucena). Planos/análises em `docs/produto/`, manuais em `docs/produto/manuais/`.

---

## 1. O que é
POC web que transforma **câmeras em sensores de área**: detecta **ocupação, movimentação e ociosidade por zona**, sinaliza **gargalo** e dispara **alerta de "área parada"**, com **painel ao vivo (central de câmeras)** e **relatório de histórico**. Mede também **presença anônima** (contagem de pessoas + permanência).

**Posicionamento (inegociável):** inteligência operacional **por área, não vigilância individual**. **Privacy by design / LGPD:** processamento local, **sem upload persistente de vídeo, sem reconhecimento facial, sem identificação individual**; pessoas recebem IDs efêmeros ("Pessoa N"); o histórico guarda **só indicadores agregados, nunca imagens**.

---

## 2. Arquitetura

```
[ /camera ] nó (webcam)  ─JPEG ~8fps─┐
[ câmera IP/RTSP ] ─ffmpeg→JPEG─────┤→  HUB (Node + socket.io :4000)  ──frames──►  [ / ] CENTRAL (dashboard)
                                     ┘   (relé de frames; não processa/grava vídeo)        • processa TUDO (coco-ssd + movimento)
                                                                                           • zonas, estados, contagem, alertas
                                                                                           • grava indicadores → IndexedDB
                                                                                                      │
                                                                                                      ▼
                                                                                            [ /relatorio ] histórico (abas)
```

- **Central processa tudo** (decisão de arquitetura): a câmera só transmite o feed; o dashboard roda a IA e o pipeline por câmera, e grava indicadores.
- **Hub** é só relé de frames (socket.io) — câmeras de navegador **e** RTSP (via ffmpeg) chegam pelo mesmo canal.
- **Pipeline reutilizável** (`CameraView`) roda sobre qualquer fonte de frame (webcam, vídeo, RTSP), nos modos `tile` (grade) e `full` (aberta).

---

## 3. Telas (rotas)
- **`/` Central** (no app shell): grade adaptativa de câmeras (preenche o viewport); câmera aberta = overlay feed-dominante com drawer "Detalhes" (Áreas/Timeline/Presença). Os tiles **gravam histórico** continuamente.
- **`/relatorio` Relatório** (no app shell): topo fixo (KPIs + insights) + **abas** Quando para (heatmap hora×área) · Onde para (ranking por área + por atividade) · Tendência (14 dias + por turno) · Eventos (tabela). Dados **reais** (IndexedDB) com empty-state + "dados de demonstração" + CSV/PDF.
- **`/camera` Nó** (fora do shell): só o feed da webcam, sem controles; envia frames ao hub.
- **App shell**: rail lateral slim (Central/Relatório), vira bottom-nav no mobile.

---

## 4. Funcionalidades entregues
- **Detecção por zona:** movimento (diff de frames) + ocupação (coco-ssd: person/truck/car…).
- **5 estados:** ATIVA · **LENTA (baixa movimentação/gargalo)** · OCIOSA · VAZIA · **ALERTA** (parada > limite), com suavização + confirmação (anti-flicker).
- **Regras por área, na UI (a liderança define):** **limite de tempo parado** (presets) e **sensibilidade de movimento** (slider) por zona; **atividade** (Carga/Descarga/Expedição/…) por zona. Persistem por câmera (localStorage).
- **Presença anônima:** contagem de pessoas por zona + **permanência** (tracker efêmero) + **"pausar para inspecionar"** (quem está em cena ao pausar).
- **Alertas:** toast sobre o feed + beep + faixa de KPIs; texto no formato do documento ("…sem movimentação há X").
- **Central multi-câmera:** grade + drill-in; demo toggle (limite curto p/ alerta rápido).
- **Câmera IP/RTSP:** ingestão no hub via ffmpeg → frames JPEG (vira câmera comum). Manuais em `docs/produto/manuais/`.
- **Histórico real:** IndexedDB (só indicadores), gravado pelos tiles; relatório por turno/dia, horários críticos, ranking, evolução, por atividade, eventos, comparativo antes/depois.
- **UX:** SPA com shell, tokens de espaçamento, **sem scroll nas telas ao vivo**, relatório em abas (só a tabela/painel ativo rola), responsivo.

---

## 5. Fluxo de dados
`câmera (webcam/RTSP) → frame JPEG → hub → central` → por câmera: `movimento + ocupação → estado da zona + idle + contagem` → `alertas (toast/beep)` e `amostras a cada 3s → IndexedDB (buckets por câmera|zona|hora + eventos)` → `/relatorio agrega (KPIs, heatmap, ranking, turno, atividade, eventos)`. Nada de imagem é persistido.

---

## 6. Mapa de arquivos
```
src/
  main.tsx                 router (shell → / e /relatorio; /camera fora)
  components/AppShell.tsx  rail + Outlet
  CameraView.tsx           ★ pipeline (motion+coco-ssd, estados, presença, zonas, overlay, tile/full)
  routes/
    DashboardPage.tsx      central: socket, grade, overlay, grava histórico
    ReportPage.tsx         relatório em abas (lê do store)
    CameraPage.tsx         nó: webcam → frames
  vision/model.ts          coco-ssd (carregado 1×)
  report/
    mock.ts                tipos + agregações (windows/kpis/heatmap/ranking/evolution/insights) + seed
    store.ts               IndexedDB (buckets+events), record/load, só indicadores
  config.ts                thresholds calibráveis (detecção, zonas, presença, rede)
  index.css                tema dark + tokens + layouts
server/
  index.js                 hub socket.io
  rtsp.js                  ingestão RTSP via ffmpeg
  rtsp.sources.example.json
```

---

## 7. Como rodar
```bash
# hub
cd server && npm install && npm run dev        # :4000
# frontend
npm install && npm run dev                     # Vite (ex.: :5173), --host
# abrir: /  (central) · /camera (nó, autoriza webcam) · /relatorio
```
Câmera IP: instalar ffmpeg + `server/rtsp.sources.json` (ver `docs/produto/manuais/`).

---

## 8. Estado vs documento da proposta
**Atendido:** monitoramento por áreas · ocupação (vazia/ocupada/baixa movimentação) · regra de tempo parado **definida pela liderança por área** · painel ao vivo · alerta · **histórico/relatório (turno, horários críticos, ranking, antes/depois)** · leitura por **atividade e turno** · **câmera IP/RTSP** · central multi-câmera · contagem/permanência anônima.

**Pendente (tasks abertas):** **#25** acesso restrito ao painel (login, LGPD) · **#27** validar robustez a falso positivo industrial (sombra/empilhadeira/poeira) · **#28** definir processamento edge/local/nuvem (produção).

**Adiado a pedido:** alertas **WhatsApp**; **reconhecimento facial** (Nível 3 — condicional, biometria/LGPD); **multi-tenant**.

**Evolução:** relatório Etapa C (insights automáticos avançados / PDF nativo); **WebRTC** (go2rtc/mediamtx) para vídeo de baixa latência; conector de **leitores industriais** (Sick/Cognex) por evento.

---

## 9. Stack
React 19 + TypeScript + Vite · TensorFlow.js coco-ssd · socket.io · IndexedDB · Node (hub) + ffmpeg (RTSP). Sem backend de dados (indicadores no navegador). Build `tsc && vite build` verde.

---

## 10. Índice de documentos
- **Conceito/planos:** `PLANO-MVP.md`, `plano-tela-relatorio.md`, `plano-ux-redesign.md`
- **Análises:** `cobertura-vs-documento.md` (gaps × documento), `avaliacao-reconhecimento-presenca.md` (biometria/LGPD)
- **Backlog:** `pendencias.md`
- **Manuais (consulta):** `manuais/` — RTSP geral, Intelbras, leitores industriais (Sick/Cognex)
- **Este documento:** `VISAO-GERAL.md`
