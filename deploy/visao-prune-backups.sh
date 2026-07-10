#!/usr/bin/env bash
# visao-prune-backups — poda os backups de release ANTIGOS do CD, mantendo os KEEP mais recentes.
#
# POR QUÊ: o CD cria um backup (cp -a) da app a cada deploy; sem poda eles acumulam e, num VPS
# compartilhado a ~99% de disco, o pre-check do próprio CD passa a BLOQUEAR deploys (aconteceu 2×
# em jul/08). Este script automatiza a poda que era manual — de forma SEGURA.
#
# SEGURANÇA (é por isso que é um script root-owned + sudoers restrita, não um `sudo rm` solto):
#   • Escopo HARDCODED: só toca /var/www/visao-patio.bak-* — NUNCA a app viva (/var/www/visao-patio),
#     NUNCA outra app do VPS compartilhado.
#   • SEM argumentos: o deploy não escolhe O QUÊ apagar nem QUANTOS manter — o padrão é fixo aqui.
#   • O `deploy` não tem permissão de editar este arquivo (dono = root); só de EXECUTÁ-LO via sudo.
#   • Mantém sempre os KEEP mais recentes → há SEMPRE ≥1 backup de rollback, mesmo mid-deploy.
#
# INSTALAÇÃO (1× pelo root — ver docs/produto/ci-cd-github-actions.md):
#   sudo cp deploy/visao-prune-backups.sh /usr/local/sbin/visao-prune-backups
#   sudo chown root:root /usr/local/sbin/visao-prune-backups && sudo chmod 755 /usr/local/sbin/visao-prune-backups
#   # + a linha de sudoers:  deploy ALL=(root) NOPASSWD: /usr/local/sbin/visao-prune-backups
set -euo pipefail

readonly KEEP=1                      # nº de backups mais recentes a preservar (rollback)
# PRUNE_DIR: seam SÓ p/ teste local. Em produção é sempre /var/www — o sudoers usa `env_reset`,
# então esta env NÃO atravessa o `sudo` do deploy (não é vetor de escape).
readonly DIR="${PRUNE_DIR:-/var/www}"
readonly PREFIX=visao-patio.bak-

shopt -s nullglob
# O glob já expande em ordem LEXICAL = CRONOLÓGICA (o nome carrega o timestamp AAAA-MM-DD-HHMMSS),
# então backups[0] é o mais ANTIGO e backups[-1] o mais recente. Array vazio se nada casa (nullglob).
backups=( "$DIR/$PREFIX"* )
n=${#backups[@]}

if (( n <= KEEP )); then
  echo "[prune] $n backup(s) de release ≤ manter $KEEP — nada a podar."
  exit 0
fi

remove=$(( n - KEEP ))
echo "[prune] $n backup(s); removendo os $remove mais antigos (mantendo os $KEEP mais recentes)."
for d in "${backups[@]:0:remove}"; do
  # trava dupla defensiva: só remove o que REALMENTE casa o prefixo e é diretório.
  case "$d" in
    "$DIR/$PREFIX"*)
      if [ -d "$d" ]; then echo "[prune]  - removendo $d"; rm -rf -- "$d"; fi ;;
    *) echo "[prune]  ! caminho inesperado ignorado: $d" ;;
  esac
done
echo "[prune] ok."
