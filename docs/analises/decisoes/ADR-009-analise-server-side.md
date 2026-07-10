# ADR-009 — Análise de visão SERVER-SIDE (motor D-FINE no hub)

**Status:** proposto (aguardando "siga" do dono do produto) · **Data:** 2026-07-03

## Contexto

Hoje a IA roda **100% no navegador do espectador** (CLAUDE.md §1, herança do MVP local-first):
coco-ssd/TFJS, OWL-ViT, MediaPipe e ZXing executam na máquina de quem abre a Central; o hub só
faz relé de frames + persistência. Consequências medidas e documentadas:

1. **Análise para quando ninguém assiste** (rAF suspenso/aba fechada) — relatório fica cego;
   o shed até pausa o ffmpeg sem espectador. Pedido explícito do usuário: "a análise tem que
   continuar rodando mesmo sem alguém assistindo".
2. **Detecção dependente da GPU/CPU do cliente**: sem WebGL o tfjs cai p/ CPU (~10× mais lento
   — comprovado: 0 pessoas em 60s numa rua com pedestres); coco-ssd (300×300, 2017) subconta
   mesmo com GPU.
3. **Custo por espectador**: cada dashboard aberto roda a MESMA inferência (N espectadores =
   N× CPU) e **cada um faz ingest** → indicadores duplicados com 2+ dashboards abertos
   (bug latente do desenho atual).
4. **Tripwires inúteis na prática**: contagem exige câmera aberta + detecção viva no cliente.

**Spike executado (docs/analises/spike-dfine-hub.md): GO.** D-FINE-N (Apache 2.0, 14,5MB ONNX,
42,8 mAP) em onnxruntime-node CPU EP na máquina atual: detecta pessoas na 1ª inferência onde o
coco-ssd ficou em zero; 6,6 fps sustentado; ~0,2 core/câmera @1fps ⇒ 8-10 câmeras no ultrabook,
16-24 em desktop 8C. Achados críticos: inferência serializa por processo (motor = worker
process); DML retorna saída ERRADA (CPU EP only); pessoa <25px segue indetectável.

## Decisão

**A análise operacional (detecção de pessoas/objetos-coco, tracking, contagem por linha,
atividade/ocupação e ingest de indicadores) passa a rodar NO HUB**, num **worker process**
Node dedicado (`server/analysis/`), consumindo os frames que o hub JÁ possui (relé), a
**1-2 fps por câmera** — 24/7, independente de espectador.

O navegador vira **espelho**: exibe vídeo + overlays alimentados por eventos do servidor
(aditivos). A edição de zonas/linhas, cine-loop e visualização permanecem como estão.
**Exceções que FICAM no cliente (por ora):** Fadiga/MediaPipe (câmera dedicada de posto,
baixa escala) e Leitura/ZXing (precisa de resolução alta sob demanda) — migração futura se
a operação pedir.

Revisão do CLAUDE.md §1 no MESMO PR da implementação (invariante muda: "IA de indicadores
roda no hub; visualização e modos especializados no navegador").

## Consequências

- **+** Relatório/contagem 24/7 sem aba aberta; linhas de passagem passam a funcionar de fato;
  recall ~2× (modelo 2026 a 640px); zero dependência de GPU do cliente; dashboards mais leves
  (fim da inferência por espectador na grade); fim do ingest duplicado por espectador.
- **+** LGPD/ADR-002 preservada: frames continuam efêmeros em memória (agora no hub, onde já
  transitam); persiste-se só metadados/indicadores, como hoje.
- **−** Hub passa a ter custo de CPU proporcional a câmeras (dimensionamento: ~0,2 core/câmera
  @1fps); deploy ganha um artefato (modelo ONNX ~15MB, servido/local); worker process novo p/
  gerenciar (respawn, backpressure).
- **−** Overlays da grade ganham latência de rede (~1 frame) — irrelevante p/ operação.
- **Risco declarado:** onnxruntime-node é dependência nativa (prebuilt win/linux ok); CPU EP
  only nesta geração (DML bugado — validado); pessoa <25px continua fora do alcance (limite
  do nano — se precisar, D-FINE-S/M no futuro custa mais CPU).
