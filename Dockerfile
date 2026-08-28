# syntax=docker/dockerfile:1
#
# Imagem do hub de visao de patio (Fly.io). O deploy de hoje e rsync + systemd + nginx no host
# (deploy-homolog.yml); esta imagem reproduz a MESMA topologia dentro de um container, porque a
# topologia nao e detalhe: o hub NAO serve estatico, e o parser real do ingest RTMP e o ffmpeg.
#
# Node 24: a mesma major do gate na nuvem (ci.yml). Divergir daqui e testar numa runtime e
# servir em outra.
# ─────────────────────────────────────────────────────────────────────────────────────────────

FROM node:24-slim AS build
WORKDIR /app
ENV npm_config_fund=false npm_config_audit=false
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# prebuild copia o WASM do mediapipe do node_modules e baixa os .task (sha256 verificado);
# build = tsc && vite build. Exige rede — o builder do Fly tem.
RUN npm run build
# go2rtc linux-amd64, sha256 verificado: MESMO script do deploy atual. O binario nunca e
# versionado, e a PRESENCA dele em bin/ e o que liga o sidecar (server/go2rtc.js) e, por
# consequencia, o ingest RTMP na 1935.
RUN node scripts/fetch-go2rtc.mjs --platform linux-amd64

# ── deps de producao (sem devDependencies) ───────────────────────────────────────────────────
FROM node:24-slim AS deps
WORKDIR /app
ENV npm_config_fund=false npm_config_audit=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── runtime ──────────────────────────────────────────────────────────────────────────────────
FROM node:24-slim
# ffmpeg: quem faz o parse do FLV do ingest e puxa RTSP (o relay nao interpreta codec de
#         proposito — spec-relay-ingest). Sem ele, o publish e aceito e nenhuma imagem aparece.
# nginx:  serve o dist/ e a CSP. O hub nao tem static handler.
# procps: 'kill -0' do entrypoint e diagnostico dentro da machine (fly ssh console).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg nginx procps ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/nginx/sites-enabled/default

WORKDIR /app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY --from=build /app/bin/go2rtc   ./bin/go2rtc
COPY server  ./server
COPY scripts ./scripts
COPY package.json package-lock.json ./
COPY deploy/fly/nginx.conf     /etc/nginx/conf.d/visao.conf
COPY deploy/fly/entrypoint.sh  /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /app/bin/go2rtc

# PORT/HOST: o hub escuta na 8091 (o nginx da 8080 faz proxy). HOST fica em 0.0.0.0 — e o que
# permite o health check TCP do Fly provar que o MOTOR esta vivo, e nao apenas o nginx. A 8091
# nao esta em nenhum [[services]]: nao ha ingresso publico nela.
# VISAO_STATE_DIR: o estado vai para o volume, nao para o rootfs efemero (server/state-dir.js).
ENV NODE_ENV=production \
    PORT=8091 \
    HOST=0.0.0.0 \
    VISAO_STATE_DIR=/data

EXPOSE 8080 1935
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
