#!/bin/bash
# Sobe a visão de pátio num servidor Linux x86_64 (droplet ou máquina física) a partir do Mac.
#
#   deploy/servidor/subir.sh usuario@host [pasta-do-backup]
#
# Faz: confere arquitetura -> instala Docker se faltar -> copia o código (git archive, não precisa
# de acesso ao GitHub no servidor) -> restaura o estado do backup -> sobe nginx+hub+RTMP e o Caddy
# (HTTPS automático) -> confere painel e RTMP respondendo DENTRO do servidor.
# Depois disso, o único passo manual é o DNS (ver a última mensagem do script).
#
# Variáveis opcionais: VISAO_REF (padrão HEAD), VISAO_DOMINIO (padrão cam.box3.software),
# VISAO_DIR (padrão /opt/visao), FORCAR=1 (sobrescreve um estado que já exista no servidor).
set -euo pipefail

DESTINO="${1:?uso: subir.sh usuario@host [pasta-do-backup]}"
RAIZ="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
COMUM="$(git -C "$RAIZ" rev-parse --path-format=absolute --git-common-dir)"
BK="${2:-$(dirname "$COMUM")/backups/fly-visao-patio-20261003}"
REF="${VISAO_REF:-HEAD}"
DOMINIO="${VISAO_DOMINIO:-cam.box3.software}"
DIR="${VISAO_DIR:-/opt/visao}"
SSH=(ssh -o ConnectTimeout=15 "$DESTINO")
passo() { printf '\n== %s\n' "$*"; }
falha() { printf '\nFALHOU: %s\n' "$*" >&2; exit 1; }

passo "0/7 conferências locais"
[ -f "$BK/data.tar.gz" ] || falha "backup não encontrado em $BK/data.tar.gz"
gzip -t "$BK/data.tar.gz" || falha "backup corrompido (gzip -t)"
ESPERADO=$(tar tzf "$BK/data.tar.gz" | grep -vc '/$')
echo "backup: $BK ($ESPERADO arquivos) · código: $(git -C "$RAIZ" rev-parse --short "$REF") · domínio: $DOMINIO"

passo "1/7 servidor: arquitetura e Docker"
ARQ=$("${SSH[@]}" uname -m)
[ "$ARQ" = "x86_64" ] || falha "servidor é $ARQ; a imagem usa go2rtc linux-amd64 (precisa x86_64)"
"${SSH[@]}" 'command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh' >/dev/null
"${SSH[@]}" 'docker compose version' || falha "docker compose indisponível no servidor"

passo "2/7 pasta $DIR"
if "${SSH[@]}" "[ -n \"\$(ls -A $DIR/data 2>/dev/null)\" ]"; then
  [ "${FORCAR:-0}" = 1 ] || falha "$DIR/data já tem estado. Para sobrescrever de propósito: FORCAR=1"
fi
"${SSH[@]}" "mkdir -p $DIR/src $DIR/data && rm -rf $DIR/src/* $DIR/data/*"

passo "3/7 código ($REF)"
git -C "$RAIZ" archive "$REF" | "${SSH[@]}" "tar x -C $DIR/src"
scp -q "$RAIZ/deploy/servidor/docker-compose.yml" "$RAIZ/deploy/servidor/Caddyfile" "$DESTINO:$DIR/"

passo "4/7 estado (backup do volume do Fly)"
"${SSH[@]}" "tar xz -C $DIR/data" < "$BK/data.tar.gz"
NO_SERVIDOR=$("${SSH[@]}" "find $DIR/data -type f | wc -l" | tr -d ' ')
[ "$NO_SERVIDOR" = "$ESPERADO" ] || falha "restaurou $NO_SERVIDOR arquivos, o backup tem $ESPERADO"
echo "restaurados $NO_SERVIDOR de $ESPERADO arquivos"

passo "5/7 variáveis (visao.env, 600)"
if [ -f "$BK/visao.env" ]; then
  scp -q "$BK/visao.env" "$DESTINO:$DIR/visao.env"
  echo "usando $BK/visao.env (mesmos segredos do Fly: as sessões continuam válidas)"
else
  "${SSH[@]}" "umask 077; cat > $DIR/visao.env <<EOF
AUTH_SECRET=\$(openssl rand -hex 32)
CAMERA_TOKEN=\$(openssl rand -hex 24)
ANALYSIS_MODEL=s
WHATSAPP_ENABLED=1
EOF"
  echo "sem visao.env no backup: gerei AUTH_SECRET e CAMERA_TOKEN novos (todos fazem login de novo)"
fi
"${SSH[@]}" "chmod 600 $DIR/visao.env; echo VISAO_DOMINIO=$DOMINIO > $DIR/.env"

passo "6/7 build e subida (o primeiro build leva alguns minutos)"
"${SSH[@]}" "cd $DIR && docker compose up -d --build"
"${SSH[@]}" "command -v ufw >/dev/null && ufw status | grep -q active && ufw allow 80,443,1935/tcp >/dev/null || true"

passo "7/7 conferência dentro do servidor"
OK=0
for _ in $(seq 1 40); do
  if "${SSH[@]}" "cd $DIR && docker compose exec -T visao node -e \"
    const net=require('net');
    fetch('http://127.0.0.1:8080/').then(r=>{ if(r.status!==200) process.exit(1);
      const s=net.connect(1935,'127.0.0.1',()=>{s.end(); process.exit(0)}); s.on('error',()=>process.exit(2)); })
    .catch(()=>process.exit(3))\"" 2>/dev/null; then OK=1; break; fi
  sleep 5
done
"${SSH[@]}" "cd $DIR && docker compose ps && docker compose logs --tail=15 visao"
[ "$OK" = 1 ] || falha "painel (:8080) ou RTMP (:1935) não respondeu em 200 s — veja os logs acima"

IP=$("${SSH[@]}" "curl -fsS4 https://api.ipify.org || hostname -I | cut -d' ' -f1")
cat <<EOF

PRONTO no servidor: painel HTTP 200 e RTMP aceitando conexão.
Falta só o DNS — GoDaddy, domínio box3.software:
  * registro A    "cam"  ->  $IP
  * apagar o AAAA "cam"  (apontava para o IPv6 do Fly)
O Caddy tira o certificado sozinho assim que o DNS propagar: https://$DOMINIO
Câmera configurada pelo DOMÍNIO volta sozinha; configurada pelo IP antigo (213.188.207.159) precisa
ser reapontada para $IP, porta 1935, mesmo nome e chave de stream.
Máquina local atrás de roteador: redirecione 80, 443 e 1935/TCP para ela (e use DDNS se o IP mudar).
EOF
