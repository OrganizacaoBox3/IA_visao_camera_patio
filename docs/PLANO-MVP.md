# Plano de Desenvolvimento — MVP Visão de Pátio (inteligência operacional por área)

> Plano em **2026-06-08**. Baseado em `document_pdf.pdf` (proposta de conceito Box3.work / Tiago Lucena).
> Mira o mesmo nível de maturidade e estilo do `sensor_fadiga_mvp`: **web, em tempo real, 100% local no navegador, orientado a demonstração**, com thresholds calibráveis e roteiro de demo.
> Foco: **MVP pragmático que demonstra resultados técnicos exemplares** — "imagem → indicador → alerta → decisão".

---

## 1. Posicionamento (herdado do documento — inegociável)

- **Inteligência operacional por ÁREA**, não vigilância de pessoas. Mede **ocupação, movimentação e ociosidade por zona/turno/fluxo** — nunca ranking individual.
- **Privacy by design / LGPD:** processamento local, **sem upload de frames**, **sem reconhecimento facial**, **sem identificação individual**. Armazenar **indicadores**, não imagens.
- Frase-âncora na UI: *"O sistema não tem foco punitivo. Ajuda a liderança a identificar áreas paradas, gargalos e falhas de fluxo para agir mais rápido."*

> Esse posicionamento é requisito de produto **e** de demo: a tela deve deixá-lo explícito (badge "processamento local · sem identificação individual").

---

## 2. Objetivo do MVP — o que provar na demo

Provar, de ponta a ponta e ao vivo, o **núcleo de valor**:
1. A câmera vira **sensor de área**: o sistema sabe se uma zona está **ativa, ociosa ou vazia**.
2. Uma **regra de tempo parado** dispara **alerta** quando a zona fica sem movimentação além do limite.
3. O **painel gerencial** mostra status por área, tempo sem atividade, alertas e **histórico/relatório** (áreas mais paradas, horários críticos).
4. O **alerta chega à liderança** (preview de mensagem estilo WhatsApp; integração real é evolução).

**Critério de "resultado exemplar":** ao final de uma sessão de 3–5 min, a tela entrega um **resumo mensurável** — nº de alertas, tempo total parado por área, horário crítico, % de ociosidade — exatamente os indicadores do documento. É isso que transforma a demo em *case*.

---

## 3. Escopo fechado

**✅ Dentro do MVP**
- Entrada de vídeo: **webcam** (demo ao vivo) **e** **arquivo de vídeo** (clipe de pátio/expedição em loop, para resultado realista).
- **Editor de zonas (ROIs):** desenhar 2–4 áreas nomeadas sobre o frame (ex.: Expedição, Carga, Estoque, Espera).
- **Detecção por zona:** (a) **movimento** (diferença de frames / fluxo) e (b) **ocupação** por presença de objetos relevantes (pessoa, caminhão, carro via modelo client-side).
- **Estado por zona:** `ATIVA` / `OCIOSA` / `VAZIA` / `ALERTA` (parada > limite), com suavização e confirmação temporal (anti-flicker).
- **Alertas:** visual (overlay + frame) + sonoro + **preview de mensagem WhatsApp** ("Área de expedição sem movimentação há 18 min").
- **Painel gerencial:** status por área, tempo sem atividade, contador de alertas, **timeline de eventos**, indicadores de ociosidade.
- **Relatório de sessão:** resumo ao final (áreas mais paradas, horários críticos, nº de alertas, tempo parado total).
- **Config-driven:** todos os thresholds em `config.ts` (calibração pré-demo).
- Docs: roteiro de demo, guia de thresholds, checklist preflight (espelho do fadiga).

**❌ Fora do MVP (evolução pós-piloto, citada no doc)**
- Identificação individual, reconhecimento facial, ranking de pessoas (proibido por posicionamento).
- Multi-fábrica, processamento em nuvem/edge real, escalabilidade de produção.
- Integração WhatsApp **oficial**, ERP/MES/BI, mapa de calor histórico, comparativo entre turnos longos.
- Persistência server-side (o MVP é stateless/local; relatório é da sessão).

---

## 4. Stack & arquitetura (espelha o `sensor_fadiga_mvp`)

- **React 19 + TypeScript + Vite**, single-page. **Tudo no navegador**, sem backend.
- **Visão computacional client-side:**
  - **Detecção de movimento por zona:** diferença de frames em `<canvas>` (downscale + threshold + % de pixels alterados por ROI) — robusto, barato, **independente de classe** → é o sinal principal de "área sem movimentação".
  - **Detecção de objetos (ocupação):** **TensorFlow.js `coco-ssd`** (classes úteis: `person`, `truck`, `car`) para distinguir *ocupada* de *vazia* e reduzir falso positivo de movimento (sombra/luz). (MediaPipe não é necessário aqui — não há face/mão.)
- **Loop por frame** via `requestAnimationFrame`; **estado quente em refs** (sinais por zona, suavização, dedupe, timers); **estado de UI em React state** — mesmo padrão do fadiga.
- **Áudio:** beep via `AudioContext`/oscilador, com cooldown.
- **`config.ts`** centraliza thresholds e intervalos (igual ao fadiga).
- **Segurança de demo:** CSP/Permissions-Policy no dev/preview; HTTPS para demo externa; nada sai do dispositivo.

```
camera/vídeo → frame → [motion por zona] + [coco-ssd ocupação] →
   suavização (EMA) → idle timer por zona → máquina de estados por zona →
      overlay + beep + painel + timeline + relatório de sessão
```

---

## 5. Modelo de domínio (o coração)

```ts
type ZoneState = "ATIVA" | "OCIOSA" | "VAZIA" | "ALERTA";

type Zone = {
  id: string;
  label: string;                 // "Expedição", "Carga"...
  rect: Rect;                    // ROI normalizada no frame
  idleAlertMs: number;          // limite de tempo parado (por zona)
  motionThreshold: number;      // sensibilidade de movimento
};

type ZoneRuntime = {
  motionScore: number;          // % pixels alterados (suavizado)
  occupied: boolean;            // há person/truck na ROI?
  lastActivityAt: number;       // timestamp da última movimentação
  idleMs: number;               // agora - lastActivityAt
  state: ZoneState;
  alertsCount: number;
  totalIdleMs: number;          // acumulado na sessão (p/ relatório)
};
```

**Regras de estado (por zona):**
- `movimento > limite` → marca atividade (`lastActivityAt = now`), estado `ATIVA`.
- sem movimento mas **ocupada** (objeto presente parado) → `OCIOSA`.
- sem movimento e **vazia** → `VAZIA`.
- `idleMs > idleAlertMs` (em OCIOSA ou VAZIA, conforme regra) → `ALERTA` + dispara alerta (com cooldown).
- **Anti-flicker:** suavização EMA do `motionScore`, confirmação temporal (estado só muda após N ms), hold mínimo e grace de recuperação — exatamente o padrão do fadiga (`signalSmoothingAlpha`, `minAlertStateHoldMs`, `recoveryGraceMs`).

**Eventos/timeline:** cada transição relevante vira evento `{ts, zona, de→para, severidade}` com dedupe por janela (igual fadiga).

---

## 6. Telas / UX

1. **Setup (30s):** escolher fonte (webcam | vídeo), conceder permissão; badge de privacidade.
2. **Editor de zonas:** desenhar/nomear 2–4 ROIs; definir limite de tempo parado por zona (slider).
3. **Operação ao vivo:** vídeo + overlay (ROIs coloridas por estado, score de movimento, idle timer, FPS/latência) + **frame vermelho** em alerta.
4. **Painel gerencial (lateral/inferior):** cards por área (estado, tempo parado, alertas), **timeline** de eventos, **preview WhatsApp** do último alerta.
5. **Relatório de sessão (encerramento):** áreas mais paradas, horário crítico, nº de alertas, tempo parado total, % ociosidade — exportável (print/JSON/CSV).

Estilo visual: mesmo DNA do fadiga (overlay sobre canvas, badges de estado, métricas de FPS/latência, timeline) — leitura rápida pela liderança.

---

## 7. `config.ts` (thresholds calibráveis)

```ts
export const APP_CONFIG = {
  detection: {
    motionDownscale: 8,             // fator de redução p/ diff de frames
    motionPixelDelta: 22,           // delta de luminância p/ "pixel mudou"
    motionActiveRatio: 0.012,       // % da ROI alterada p/ contar movimento
    objectIntervalMs: 300,          // cadência do coco-ssd
    occupancyScoreThreshold: 0.5,   // confiança p/ person/truck/car
    signalSmoothingAlpha: 0.35,
    stateConfirmationMs: 1200,      // confirma transição de estado
    minAlertStateHoldMs: 1500,
    recoveryGraceMs: 1500,
  },
  zonesDefault: { idleAlertMs: 15 * 60_000 },  // 15 min (demo: usar 8–15s)
  audio: { alertBeepCooldownMs: 4000, alertFrequencyHz: 880, alertDurationMs: 220 },
  alerts: { whatsappCooldownMs: 30_000 },
  timeline: { maxItems: 10, dedupeWindowMs: 2000 },
  metrics: { rollingSamples: 24 },
} as const;
```

> **Modo demo:** `idleAlertMs` de 15 min vira **8–15 s** para o alerta caçar ao vivo (perfil "demo" no config). O texto do alerta exibe o tempo real ("18 minutos") via fator de escala configurável, para a narrativa industrial.

---

## 8. Plano de execução (faseado, pragmático)

**Marco 0 — Esqueleto (espelhar o fadiga):** scaffold React19+TS+Vite, `App.tsx` + `config.ts`, captura de webcam/vídeo, loop RAF, overlay base, badge de privacidade. *(meio dia)*

**Marco 1 — Detecção de movimento por zona:** editor de ROIs + diff de frames + `motionScore` suavizado por zona + estado ATIVA/parada. **Já demonstra "área parada".** *(1–2 dias)*

**Marco 2 — Máquina de estados + alertas:** idle timer por zona, ATIVA/OCIOSA/VAZIA/ALERTA com confirmação/hold/grace, beep + frame vermelho + preview WhatsApp. *(1 dia)*

**Marco 3 — Ocupação (coco-ssd):** distinguir OCIOSA×VAZIA por presença de objeto; reduzir falso positivo de movimento. *(1 dia)*

**Marco 4 — Painel + timeline + relatório de sessão:** cards por área, timeline, **resumo final mensurável** (o "resultado exemplar"). *(1–2 dias)*

**Marco 5 — Polimento de demo:** clipe de pátio em loop, perfil "demo" de thresholds, docs (`presentation-script.md`, `thresholds.md`, `preflight-checklist.md`), HTTPS. *(meio dia)*

> Total pragmático: **~1 semana** para um MVP demonstrável e robusto. Ordem maximiza valor cedo (Marco 1 já mostra o núcleo).

---

## 9. Demonstração (roteiro ~4 min, estilo do fadiga)

1. **Abertura (30s):** abrir, conceder câmera, destacar processamento local / sem identificação individual.
2. **Zonas (40s):** desenhar "Expedição" e "Carga"; mostrar status ATIVA com movimento.
3. **Área parada (60s):** parar a movimentação na Expedição → contador de tempo parado sobe → transição para ALERTA → beep + frame vermelho + **mensagem WhatsApp** "Expedição sem movimentação há X".
4. **Vazia × ociosa (40s):** mostrar zona VAZIA vs OCIOSA (objeto presente, parado).
5. **Painel + relatório (50s):** abrir o resumo da sessão — áreas mais paradas, horário crítico, nº de alertas. **É o resultado que vira case.**
6. **Encerramento (20s):** reforçar evolução (heatmap, turnos, multi-câmera, ERP, WhatsApp oficial).

---

## 10. Critérios de excelência / aceite

- **Robustez a falso positivo:** sombra, mudança de luz, empilhadeira passando, poeira — mitigados por suavização + confirmação temporal + checagem de ocupação. Demo não dispara alerta espúrio.
- **Tempo real:** ≥ ~15 FPS no loop de movimento; coco-ssd em cadência menor (300ms) sem travar a UI.
- **Clareza gerencial:** liderança entende o painel em < 5s; alerta tem ação clara.
- **Resultado mensurável:** ao fim, números concretos por área (o diferencial pedido).
- **Privacidade explícita:** nenhum frame sai do dispositivo; UI comunica isso.
- **Calibração trivial:** trocar `config.ts` + reload ajusta a demo a qualquer ambiente.

---

## 11. Riscos & mitigações

| Risco | Mitigação |
|---|---|
| Falso positivo (sombra/luz/empilhadeira/poeira) | Movimento suavizado + confirmação temporal + ocupação por objeto; sensibilidade por zona |
| Webcam não representa "pátio" | Suportar **clipe de vídeo** de expedição/pátio em loop para resultado realista |
| Percepção de vigilância (LGPD/cultural) | Posicionamento por área, sem rosto/indivíduo, badge de privacidade, frase-âncora |
| coco-ssd não tem "empilhadeira" | MVP usa `person/truck/car` + movimento (não depende de classe específica); modelo custom é evolução |
| Latência/ FPS em máquina fraca | Downscale agressivo no diff; coco-ssd em intervalo; perfis de qualidade no config |

---

## 12. Evolução pós-MVP (do documento)

Mapa de calor histórico, comparativo por turno, análise de gargalos, **WhatsApp oficial**, integração ERP/MES/BI, modelo custom (empilhadeira/EPI), múltiplas câmeras, processamento edge/servidor, multi-fábrica — e o **relatório do piloto como case** para fomento (FIEC/SENAI/FINEP/EMBRAPII) citado na proposta.

---

## 13. Entregáveis deste MVP
- App web demonstrável (`src/App.tsx` + `src/config.ts`) no padrão do fadiga.
- `docs/presentation-script.md`, `docs/thresholds.md`, `docs/preflight-checklist.md`.
- Clipe de demo + perfil de thresholds "demo".
- **Relatório de sessão** como artefato de resultado (o que vira material de validação).

> Nome de trabalho sugerido: **"Visão de Pátio"** (ou *PátioVision* / *Sentinela Operacional*) — a definir.
