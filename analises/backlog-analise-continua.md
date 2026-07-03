# Backlog — Análise contínua sem espectador (pós-padronização da UI)

> Pedido do usuário (jul/2026): **a análise tem que continuar rodando mesmo sem alguém
> assistindo.** Hoje ela é acoplada ao navegador por DESIGN (CLAUDE.md §1: "IA roda 100% no
> navegador"): detecção/motion/ingest nascem no rAF do CameraWorkspace — sem dashboard aberto,
> nada roda; e o shed (perf O2-E) pausa o ffmpeg sem espectador. Mudar isso é decisão de
> arquitetura → exige ADR. Fazer DEPOIS da onda de padronização visual em curso.

## Opções (avaliar quando chegar a vez)

| # | Opção | Prós | Contras |
|---|---|---|---|
| A | **Worker headless no hub** (Chromium headless/Playwright rodando a MESMA página de análise como "espectador 24/7") | Reusa 100% do pipeline do navegador; zero fork de lógica; invariante tecnicamente preservada | Headless costuma ficar SEM WebGL → detecção em CPU (nosso pior caso já comprovado); processo pesado por câmera; gestão de ciclo de vida |
| B | **Análise no Node** (onnxruntime-node no hub, motor D-FINE) | Resolve DE UMA VEZ: análise contínua + detecção rápida sem GPU no cliente (onnxruntime nativo tem CPU EP muito melhor que wasm) + padrão de mercado (Frigate-style edge) | QUEBRA a invariante "IA 100% no navegador" (ADR obrigatória); duplica pipeline (motion/tracker/counter em TS Node — boa parte já é lógica pura reutilizável) |
| C | **Estação de análise dedicada** (kiosk: um navegador sempre aberto num PC da operação) | Zero código; resolve hoje | Frágil (depende de máquina/aba viva); requisito operacional, não solução |

## Interação com o resto do plano
- **Sinergia com a Onda 3 (D-FINE/onnxruntime)**: se formos de opção B, o motor novo já nasce no
  lugar certo (hub) — avaliar as duas decisões JUNTAS antes de implementar a Onda 3 no browser.
- O **shed** precisa de semântica nova em qualquer opção: "análise conta como espectador".
- Os processadores/tracker/counter são LÓGICA PURA (counting.ts, bytetrack.ts, parte dos
  processors) — portáveis para Node com pouco atrito; o acoplado é o CameraWorkspace (rAF/canvas).
- LGPD: análise no hub continua só-metadados (frames já passam pelo hub; nada novo é persistido).

## Encaminhamento
1. Terminar a padronização visual (em curso).
2. ADR curta comparando A×B×C (recomendação preliminar: **B**, motor D-FINE em onnxruntime-node,
   mantendo o pipeline do navegador como está p/ visualização/overlays — o hub passa a ser a
   fonte dos indicadores; navegador vira "espelho").
3. Spike de 1 dia: onnxruntime-node + D-FINE-N processando 1 stream do relé no hub, medindo
   fps/CPU — antes de comprometer a arquitetura.
