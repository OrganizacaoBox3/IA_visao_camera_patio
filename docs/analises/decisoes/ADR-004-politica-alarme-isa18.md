# ADR-004 — Política de alarme (ISA-18.2/EEMUA 191) antes de mais alertas

## Contexto
Três domínios do benchmark (NASA, VMS, indústria) apontaram o mesmo maior risco de UX
de um sistema de visão: virar **spam de notificação**. O modo demo "Limite 10s" estava
ligado por padrão, disparando Andon/WhatsApp em massa.

## Decisão
Camada de política (`server/alarmPolicy.js`) aplicada **antes** dos canais (Andon +
WhatsApp), em ponto único de decisão:
- Dedup temporal por chave lógica `câmera|zona|tipo`.
- Supressão de inundação: rajada (feed caiu) → 1 resumo de causa-raiz, não N alertas.
- Priorização em 3 níveis (advisory/high/critical), crítico reservado (meta ≤5%).
- Shelving com expiração (manutenção), métricas de taxa, anti-flapping.
- ~~Demo "Limite 10s" desligado por padrão (`VITE_DEMO_MODE=1` liga).~~ Recurso de demo removido em jul/2026 (commit `e0d6963` — Central sem views/auto-destaque/limite-curto).

## Consequências
- (+) Andon/WhatsApp acionáveis, não ruidosos; alinhado a EEMUA 191.
- (+) `evaluate()` mantém assinatura → integração não invasiva.
- (−) Shelving/métricas eram voláteis por processo (endereçado em ADR posterior /
  persistência); sem coordenação multi-instância.
