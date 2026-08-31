#!/usr/bin/env bash
# Entrypoint do hub de visao no Fly. Faz TRES coisas, nessa ordem, e MORRE EM VOZ ALTA se
# qualquer uma falhar. O motivo de cada verificacao existir e o mesmo: neste desenho, a falha
# natural nao e a aplicacao cair — e ela SUBIR, atender, dizer "salvo" e perder o dado no
# proximo deploy. Falso-OK e pior que erro (CLAUDE.md).
set -euo pipefail

STATE_DIR="${VISAO_STATE_DIR:-/data}"

log() { printf '[entrypoint] %s\n' "$*"; }
die() { printf '[entrypoint] FATAL: %s\n' "$*" >&2; exit 1; }

# ── 1) O VOLUME ESTA MONTADO? ────────────────────────────────────────────────────────────────
# Sem volume, /data e o rootfs EFEMERO da machine: o cadastro de cameras, os usuarios, as zonas,
# os DVRs e a sessao do WhatsApp somem no proximo deploy — sem erro nenhum no caminho. Por isso
# a ausencia de mount e falha de BOOT, nao aviso. Comparacao por device: se /data e / estao no
# mesmo dispositivo, /data nao e um mount.
if [ "$(stat -c %d /)" = "$(stat -c %d "$STATE_DIR" 2>/dev/null || echo -1)" ]; then
  if [ "${VISAO_ALLOW_EPHEMERAL_STATE:-0}" = "1" ]; then
    log "AVISO: $STATE_DIR NAO e um volume — estado EFEMERO (VISAO_ALLOW_EPHEMERAL_STATE=1)."
    log "AVISO: isso e valido para 'docker run' local. Em producao, e perda de dado silenciosa."
  else
    die "$STATE_DIR nao e um volume montado (mesmo device de /).
       O estado do hub mora ai; sem volume ele morre no proximo deploy, calado.
       Corrija com:  fly volumes create visao_data -a <app> -r <regiao> -s 10
       e a secao [[mounts]] do fly.toml apontando destination = \"$STATE_DIR\".
       Para rodar EFEMERO de proposito (teste local), passe VISAO_ALLOW_EPHEMERAL_STATE=1."
  fi
fi

# ── 2) O VOLUME ACEITA ESCRITA? ──────────────────────────────────────────────────────────────
# Montado != gravavel (volume cheio, read-only apos falha, permissao). Canario: escreve, le de
# volta, confere o conteudo e apaga. "Montou" nao e evidencia de "grava".
CANARIO="$STATE_DIR/.entrypoint-canario"
mkdir -p "$STATE_DIR" || die "nao consegui criar $STATE_DIR"
if ! printf 'ok' > "$CANARIO" 2>/dev/null; then
  die "$STATE_DIR nao aceita escrita (volume cheio ou read-only?). df: $(df -h "$STATE_DIR" | tail -1)"
fi
[ "$(cat "$CANARIO")" = "ok" ] || die "$STATE_DIR aceitou a escrita mas devolveu conteudo errado — nao confie neste volume"
rm -f "$CANARIO"
log "estado em $STATE_DIR — volume montado e gravavel ($(df -h "$STATE_DIR" | tail -1 | awk '{print $4}') livres)"

# O hub resolve TODO o caminho de estado por server/state-dir.js, que le VISAO_STATE_DIR. Nao
# ha symlink aqui de proposito: rename(2) nao segue symlink, e data-hist.json/alarm-shelves.json
# gravam com tmp+rename — o link seria substituido por arquivo real no disco efemero.
export VISAO_STATE_DIR="$STATE_DIR"

# ── 3) OS DOIS PROCESSOS, E MORTE CONJUNTA ───────────────────────────────────────────────────
# nginx serve o dist/ + a CSP; node e o hub (API, socket.io, ingest RTMP na 1935, go2rtc).
# Se UM morre, o container inteiro morre: meia-aplicacao viva e o pior estado possivel — o
# health check do front passa (nginx de pe) enquanto o motor esta morto, e o Fly nao reinicia.
nginx -g 'daemon off;' &
PID_NGINX=$!
log "nginx no ar (pid $PID_NGINX) — :8080"

node server/index.js &
PID_NODE=$!
log "hub no ar (pid $PID_NODE) — :${PORT:-8091} + RTMP :1935"

# Encerramento limpo: o Fly manda SIGINT/SIGTERM no deploy e no 'fly machine stop'. O hub tem
# flush final de data-hist no shutdown (pgstore) — matar de imediato perderia essa gravacao.
encerrar() {
  log "sinal recebido — encerrando os dois processos"
  kill -TERM "$PID_NODE" "$PID_NGINX" 2>/dev/null || true
  wait "$PID_NODE" 2>/dev/null || true
  wait "$PID_NGINX" 2>/dev/null || true
  exit 0
}
trap encerrar TERM INT

# wait -n devolve no PRIMEIRO que morrer (nao espera os dois).
wait -n "$PID_NGINX" "$PID_NODE"
CODIGO=$?
if ! kill -0 "$PID_NODE" 2>/dev/null; then
  log "o HUB (node) morreu com codigo $CODIGO — derrubando o nginx tambem"
else
  log "o NGINX morreu com codigo $CODIGO — derrubando o hub tambem"
fi
kill -TERM "$PID_NODE" "$PID_NGINX" 2>/dev/null || true
sleep 2
kill -KILL "$PID_NODE" "$PID_NGINX" 2>/dev/null || true
# Sai != 0 de proposito: o Fly precisa VER a falha para reiniciar a machine.
exit "${CODIGO:-1}"
