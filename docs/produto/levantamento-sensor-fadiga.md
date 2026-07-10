# Levantamento — `sensor_fadiga_mvp` (para integração ao `visao_computacional_mvp`)

> Leitura completa do projeto de fadiga (sem alterar nada). Objetivo: mapear qualidades, boas práticas e tecnologias que valem ser aproveitadas no projeto de visão, e o que o visão já tem de melhor. Data: 2026-06-09.

## 1. Visão geral
MVP web de **monitoramento visual de operador**: detecta **fadiga** (olhos fechados via EAR), **bocejo** (MAR), **uso de celular** e **gestos de mão**, com **alerta visual + sonoro em tempo real**. Processamento **100% local no navegador** (sem upload de frames). É **single-camera** (webcam do próprio operador), foco em profundidade de pipeline e demonstração técnica.

**Linhagem:** o `visao_computacional_mvp` foi criado "no molde" deste projeto — ambos compartilham `config.ts` de thresholds, coco-ssd, suavização EMA, janelas de confirmação, timeline com dedupe, beep com cooldown e CSP. Na prática: **fadiga = pipeline profundo de 1 câmera; visão = plataforma multi-câmera**. A integração é trazer a profundidade do fadiga para a plataforma do visão.

## 2. Stack / tecnologias
| Item | Fadiga | Visão (hoje) |
|---|---|---|
| Base | React 19 + TS + Vite 8 | igual |
| Modelos | **MediaPipe Tasks Vision** (FaceLandmarker + HandLandmarker, WASM, `runningMode:"VIDEO"`) + coco-ssd (celular) | coco-ssd (atividade/objetos) + ZXing (worker) + **OWL-ViT** (transformers.js, worker) |
| tfjs | webgl→cpu fallback explícito | webgl implícito |
| Estado servidor | **`@tanstack/react-query`** (dep presente) | socket.io-client |
| Arquitetura | **monólito single-file** (`App.tsx` 1377 LoC) | multi-arquivo, rotas, hub, workers |
| Persistência | nenhuma | IndexedDB + relatório |
| Testes | nenhum | nenhum |

> Obs.: `@tanstack/react-query` está nas deps mas não há uso evidente no `App.tsx` — provável resíduo do scaffold.

## 3. Estrutura
Compacta e plana: `src/App.tsx` (todo o app), `src/config.ts` (thresholds), `src/index.css` (319 linhas, CSS puro sem tokens), `src/main.tsx`. Docs maduras: `presentation-script.md` (roteiro de demo 3 min), `preflight-checklist.md`, `thresholds.md` (guia de calibração). `vite.config.ts` com **CSP/Permissions-Policy** (idêntico em espírito ao do visão).

## 4. Pipeline de visão — o coração e a maior qualidade
Um **único loop `requestAnimationFrame`** orquestra 3 modelos com **agendamento independente e inteligente**:
- **Intervalos por modelo** (`faceIntervalMs 66`, `handIntervalMs 90`, `objectIntervalMs 220`) — cada inferência roda na sua cadência.
- **Gate `hasNewFrame`** (`video.currentTime !== lastVideoTime`) — não reprocessa o mesmo frame.
- **Guard de in-flight** no detector de objeto (`objectInferenceInFlight`) — coco-ssd é async; evita sobreposição.
- **Telemetria**: FPS (contador por segundo) + **latência média por modelo** (buffers rolantes `rollingSamples 24`) exibidos num HUD. (O visão **não tem** telemetria nenhuma.)
- **Cleanup correto**: `faceLandmarker.close()`/`handLandmarker.close()` no unmount; guardas `isCancelled` em todos os efeitos async de carga de modelo.
- **Mapeamento de coordenadas robusto**: `getVideoViewport` (letterbox), `mapLandmark` (espelha o selfie view: `1 - x`), `mapVideoRect`. Overlay desenhado com precisão sobre o feed espelhado.

## 5. Lógica de domínio
- **EAR** (Eye Aspect Ratio) por olho a partir de 6 landmarks; **MAR** (Mouth Aspect Ratio). Índices de landmark centralizados no `config.ts`.
- **Reconhecimento de gesto de mão** (`inferManualSignal`): conta dedos estendidos (tip.y < pip.y), polegar por handedness → `JOINHA / MAO_ABERTA / PUNHO_FECHADO`. Capacidade que o visão não tem.
- **Motor de risco** (`updateRiskState`) — referência de qualidade:
  - **Janelas de confirmação** por sinal (olho fechado 1500ms, bocejo 900ms, celular 1000ms) — só vira alerta se o sinal **persistir**.
  - **Suavização EMA** (`signalSmoothingAlpha 0.35`) em EAR/MAR antes de aplicar limiar.
  - **Anti-flicker** de transição: `recoveryGraceMs` (carência ao voltar p/ OK) + `minAlertStateHoldMs` (não troca de alerta cedo demais).
  - **Estados compostos**: `OK / ALERTA_FADIGA / ALERTA_CELULAR / ALERTA_DUPLO` (fadiga+celular simultâneos).
- **Score adaptativo por contexto** (redução de falso positivo de celular): o score bruto do coco-ssd é **reforçado** se a bbox do celular sobrepõe zona da **orelha** (`phoneAdaptiveBoostEar`) ou da **mão** (`phoneAdaptiveBoostHand`), com IoU/overlap; aceita por score ajustado **OU** bruto; **janela de retenção** (`phoneRetainMs 420`) evita piscar. ← Diretamente útil para a task #27 (falso positivo industrial) do visão.

## 6. Boas práticas notáveis (candidatas a migrar)
1. **Padrão ref-espelha-state**: cada estado React usado dentro do loop rAF tem um `...Ref` sincronizado por `useEffect` → o loop lê refs (sempre atuais) sem recriar o callback nem causar re-render. O visão usa isso parcialmente; o fadiga é mais sistemático.
2. **Agendador de inferência** (intervalo + hasNewFrame + in-flight) — genérico, reaproveitável para qualquer modo do visão.
3. **Telemetria FPS/latência por modelo** — o visão precisa disso (você já pediu indicador de fps).
4. **Aquisição de câmera robusta**: checagem de **contexto seguro** (HTTPS/localhost), **Permissions API** pré-checagem, **escada de constraints** (1280→960→`true`), **facingMode** por Android, **mapeamento granular de DOMException** (NotAllowed/NotFound/Overconstrained/Security). O `CameraPage` do visão é bem mais simples → migrar isso o deixa pronto para campo.
5. **Motor de estado formalizado** (confirmação + EMA + grace + min-hold) centralizado numa função — o visão tem lógica equivalente espalhada no `CameraView`; valeria extrair um motor compartilhado.
6. **Cleanup/lifecycle de modelos** (`close()`, `isCancelled`) — o visão carrega coco-ssd uma vez e nunca libera.
7. **Toggles por sinal** (Face/Maos/Celular/Risco ON-OFF) — útil para depurar/demonstrar.
8. **Timeline com dedupe** (janela 1200ms) — o visão tem timeline, mas o dedupe do fadiga é mais limpo.
9. **Docs de demonstração** (roteiro, preflight, guia de thresholds) — replicar para os modos do visão ajuda nas apresentações.

## 7. UI/UX
Layout fixo de 1 tela: header (badges de status + risco), `video-shell` com `aspect-ratio` dinâmico (canvas overlay sobre `<video>`), painel com pipeline-chips, métricas em texto mono, ações (reiniciar/pausar/som) e toggles, e timeline lateral. **CSS puro, sem design tokens** (cores hardcoded, paleta slate/azul própria). O visão é **superior aqui**: tokens `--sp-*`, paleta semântica, componentização, SPA com rotas e modos.

## 8. Qualidade / processo
- **tsconfig mais rígido** que o visão: além de `strict`+`noUnusedLocals`, tem **`noUnusedParameters`, `erasableSyntaxOnly`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`**. Vale alinhar o visão a esse nível.
- **Sem testes** (igual visão) — dívida comum.
- **Build** `tsc && vite build` (igual).
- Resíduos: `tmp_mvp_*.log` vazios versionados; `react-query` não usado; assets de template (vite.svg, typescript.svg).

## 9. O que o VISÃO já faz melhor (não regredir na integração)
Multi-câmera (hub socket.io + nó/central), RTSP, **Web Workers** para trabalho pesado, **persistência + relatórios** (IndexedDB, agregações, CSV/PDF, abas), **rotas + app shell + 3 modos**, transporte **binário + ImageBitmap**, **zero-shot OWL-ViT**, design tokens/paleta semântica, enquadramento **LGPD**, zonas/setores configuráveis.

## 10. Recomendação de integração (a discutir antes de codar)
Dois eixos, independentes:

**A) Fadiga como 4º MODO de câmera ("Operador / Fadiga")** no visão — reusando hub/central/relatório/shell. A câmera de operador é um nó como os outros; o `FadigaView` (irmão de `ReadingView`/`ObjectsView`) roda o pipeline MediaPipe + motor de risco; alertas viram toasts + eventos; histórico/relatório de fadiga entram no seletor de modo. **Atenção:** MediaPipe precisa do rosto próximo → é uma câmera dedicada, não as de área. CSP do visão precisa liberar os hosts do MediaPipe (`storage.googleapis.com` já está; conferir wasm `cdn.jsdelivr.net`).

**B) Cross-pollination de engenharia (vale mesmo sem o modo)** — extrair do fadiga e aplicar a TODO o visão: telemetria FPS/latência, agendador de inferência (interval+hasNewFrame+in-flight), aquisição de câmera robusta, motor de estado EMA+histerese compartilhado, score adaptativo por contexto (task #27), cleanup de modelos, tsconfig mais rígido, docs de demo.

**Sugestão:** começar por **B** (ganho transversal de qualidade, baixo risco) e depois **A** (novo modo). A ordem fina fica para a próxima etapa.
