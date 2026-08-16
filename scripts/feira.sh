#!/bin/bash
# Uso: bash scripts/feira.sh            (sobe o hub no PERFIL DE FEIRA)
#      bash scripts/feira.sh --print    (só imprime o ambiente; não sobe nada)
#
# PERFIL DE DEMONSTRAÇÃO AO VIVO (stand de feira, 1 câmera SICK SEC110 apontada para o corredor).
# Racional completo e checklist de campo: docs/analises/runbook-feira-sick.md
#
# POR QUE UM SCRIPT E NÃO O .env:
#   server/env.js carrega o .env da raiz mas NUNCA sobrescreve variável que já veio do ambiente
#   real. Exportar aqui, antes de chamar o hub, tem precedência sobre o arquivo — então o .env
#   (que carrega AUTH_SECRET/PG*) fica intocado, o repo não passa a carregar config de demo, e
#   o rollback é não rodar este script. Nada aqui é permanente.
#
# ⚠ ESTE PERFIL DESLIGA GUARDAS DE SEGURANÇA OPERACIONAL DE PROPÓSITO (anti-flapping e dedup do
#   alarme). Ele é para BALCÃO, não para o CD. Num CD real, um alarme que repete sem parar é
#   fadiga de alarme — a doutrina ISA-18 do ADR-004 existe justamente para isso.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── 1. ALARME: o achado que motivou este arquivo ──────────────────────────────────────────────
# Defaults de produção (server/alarm/config.js) e o que fazem num stand:
#   ALARM_FLAP_THRESHOLD=5 em ALARM_FLAP_WINDOW_MS=600000 → do 6º disparo em 10 min, o alarme
#   entra em COOLDOWN de 5 MINUTOS e para de acender. Em silêncio: sem erro, sem aviso na tela.
#   Demonstrando a cada ~2 min, o alarme morreria por volta da 5ª ou 6ª demonstração do dia.
#   ALARM_DEDUP_MS=60000 → dois visitantes em menos de 1 min, o segundo não vê nada.
export ALARM_FLAP_ENABLED=0      # sem cooldown por re-disparo — é para repetir o dia inteiro
export ALARM_DEDUP_MS=5000       # 5s entre repetições do MESMO alarme (60s mata a demo)
export ALARM_FLOOD_THRESHOLD=50  # a rajada (default 8/15s) viraria um resumo "possível queda de feed"

# ── 2. MOTOR ──────────────────────────────────────────────────────────────────────────────────
export ANALYSIS_ENABLED=1
export ANALYSIS_MODEL=s          # PIN explícito: no stand não se quer o autoscale trocando de tier

# CADÊNCIA — subida com base em MEDIÇÃO nesta máquina (M5, 10 núcleos, 2026-08-16, fixture
# de 29 imagens do eval/): D-FINE-S no worker de produção custa **68,6 ms/quadro** (mediana),
# ou seja o teto de UMA câmera é ~14,6 fps, não os 2 que o default sugere. O default de 1 fps
# existe para HUB COM MUITAS CÂMERAS; num stand com uma câmera só ele joga fora 90% do
# hardware — e cadência é o que faz a marcação acompanhar quem anda.
# Tetos do próprio motor: ANALYSIS_FPS e _FPS_LINE são clampados em 4, _FPS_FOCUS em 8.
export ANALYSIS_FPS=3            # base (câmera não focada)
export ANALYSIS_FPS_FOCUS=8      # teto do motor — a câmera aberta é o que o visitante olha

# Input do detector: 640 nos DOIS caminhos. Curva medida no mesmo fixture (recall / precisão /
# FP em cena VAZIA):
#     512 → 90,5% / 72,3% / 1 FP   (48,1 ms)
#     640 → 91,6% / 74,4% / 0 FP   (68,6 ms)   ← escolhido
#     896 → 93,7% / 73,6% / 4 FP  (131,2 ms)
# O 896 estava neste arquivo por inferência ("+5-8pp em cena densa") e foi REFUTADO ao medir:
# compra 2,1pp de recall por +91% de CPU e leva o falso positivo em cena vazia de 0 para 4.
# Num balcão, caixa fantasma sobre cena vazia é o pior defeito visível que existe — e o custo
# ainda reduziria a cadência, que é o que realmente move a percepção.
export ANALYSIS_INPUT=640
export ANALYSIS_FOCUS_INPUT=640

# Largura do pull go2rtc→ffmpeg que alimenta o motor (default 1280). 1920 dá mais pixel para
# pessoa distante ao custo de transcode; num M5 com 1 câmera cabe. Mantido no default até MEDIR.
# export ANALYSIS_GO2RTC_WIDTH=1920

# ── 3. AVISO E SUBIDA ─────────────────────────────────────────────────────────────────────────
echo "── PERFIL FEIRA ────────────────────────────────────────────────"
echo "  alarme:  anti-flap OFF · dedup ${ALARM_DEDUP_MS}ms · flood ${ALARM_FLOOD_THRESHOLD}"
echo "  motor:   tier ${ANALYSIS_MODEL} · base ${ANALYSIS_FPS}fps · foco ${ANALYSIS_FPS_FOCUS}fps"
echo "  input:   global ${ANALYSIS_INPUT} · foco ${ANALYSIS_FOCUS_INPUT}"
echo "  ⚠ guardas de fadiga de alarme DESLIGADAS — perfil de balcão, não de CD"
echo "────────────────────────────────────────────────────────────────"

if [ "${1:-}" = "--print" ]; then exit 0; fi

# macOS: impedir suspensão durante a demonstração (tela, disco, sistema e idle).
# Sem isto o Mac dorme no meio do dia e a câmera "cai" sem motivo aparente.
if command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -dimsu node "$REPO/server/index.js"
fi
exec node "$REPO/server/index.js"
