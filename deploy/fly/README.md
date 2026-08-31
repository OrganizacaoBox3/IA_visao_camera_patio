# Runbook — hub de visão no Fly.io

Empacotamento do hub para rodar em container no Fly, ao lado do deploy systemd que já existe
(`deploy-homolog.yml`). **Os dois convivem**: `VISAO_STATE_DIR` ausente = comportamento de hoje,
byte a byte. Nada aqui muda o que está no ar.

Motivo de existir: a VPS atual é compartilhada (advo, plasfran, whatsapp-api moram nela) e foi
medida a **88% de CPU / 74% de RAM** em 26/08/2026, com o publisher RTMP caindo por `close` a
cada ~8 s e `i/o timeout` no pull RTSP em `127.0.0.1:8554` — padrão de máquina saturada.

## Topologia dentro do container

```
edge do Fly (TLS)  ──HTTP:8080──▶  nginx  ──┬── / e /assets/  →  /app/dist  (front + CSP)
                                            ├── /api/         →  127.0.0.1:8091
                                            └── /socket.io/   →  127.0.0.1:8091
IP dedicado :1935  ──TCP puro──▶  node (server/index.js)  ──▶ relay RTMP → HTTP-FLV :8935 (loopback)
                                        │                                        │
                                        └──▶ go2rtc (sidecar, bin/go2rtc)  ──▶ ffmpeg → RTSP :8554
volume  /data  ◀── todo o estado (13 itens)
```

Dois processos, uma machine, morte conjunta: se um cai, o container cai. Meia-aplicação viva é o
pior estado — o front responde 200 com o motor morto e ninguém é avisado.

## Pré-requisitos (já feitos em 28/08/2026)

```
fly apps create visao-patio
fly ips allocate-v4 -a visao-patio     # 213.188.207.159 — dedicado, $2/mo
fly ips allocate-v6 -a visao-patio     # 2a09:8280:1::17d:eaf8:0
```

**O IPv4 dedicado é requisito, não conforto.** RTMP é TCP puro, sem SNI; o IPv4 compartilhado do
Fly só roteia HTTP/HTTPS. Sem IP dedicado o `publish` da câmera não chega — e o sintoma seria
idêntico ao bug que já estamos caçando, o que faria perder dias.

Falta, antes do primeiro deploy:

```
fly volumes create visao_data -a visao-patio -r gru -s 10
```

## Segredos

Nunca no `fly.toml` (ele é versionado). Mínimo para subir:

```
fly secrets set -a visao-patio \
  AUTH_SECRET="$(openssl rand -hex 32)" \
  SUPERADMIN_USER=... SUPERADMIN_PASSWORD=... \
  CAMERA_TOKEN="$(openssl rand -hex 24)"
```

Postgres é opcional: sem `DATABASE_URL`/`PG*` o hub cai no fallback JSON — que **está no volume**,
então persiste. Com Postgres, aponte para uma instância acessível do Fly.

## Deploy

```
fly deploy -a visao-patio -c fly.toml
```

O build roda `npm run build` (tsc + vite) e baixa o `go2rtc` linux-amd64 com sha256 verificado —
o mesmo script do deploy atual. Exige rede no builder.

## Validação — o que prova que subiu (e o que NÃO prova)

`fly status` verde **não** prova que a imagem aparece. Na ordem:

1. **Volume de fato montado** — o entrypoint se recusa a subir sem ele; leia o log:
   `fly logs -a visao-patio | grep entrypoint`
   Esperado: `estado em /data — volume montado e gravavel (N livres)`.
2. **Front servido** — `curl -sI https://visao-patio.fly.dev/ | head -1` → `200`.
3. **Motor vivo** — os dois checks passando: `fly checks list -a visao-patio`.
   `front` verde com `hub` vermelho = nginx de pé, motor morto. É o caso que mais engana.
4. **Ingest aceito** — publique e leia o log:
   `fly logs -a visao-patio | grep rtmp-ingest`
   Esperado: `publish aceito no canal "<sua-stream-key>"`. Se aparecer `publish recusado: nome
   fora do contrato`, a stream key tem caractere fora de `[A-Za-z0-9_-]{1,32}`.
5. **A imagem chega em dia** — `fly ssh console -a visao-patio -C "node scripts/diagnose-source.mjs <url>"`.
   Responde "a fonte chega em dia?", que é outra pergunta que "conecta?".
6. **O tile aparece no painel.** Só isto encerra. Os cinco passos acima podem estar verdes com o
   tile preto — foi exatamente o que aconteceu no servidor atual.

## O que este pacote NÃO migra

- **A ponte DVR.** `relay/CO-RESIDIR.md` assume nginx com `auth_request` co-residente com o hub,
  em `cam.box3.software`. Virar o domínio para o Fly leva o painel e deixa a ponte atrás. Resolver
  isso é trabalho próprio, não efeito colateral deste PR.
- **O Postgres.** Continua onde está, ou vira instância nova.
- **O domínio.** Suba num host novo (`visao.box3.software`), valide com câmera publicando de
  verdade, e só então vire o `cam.box3.software`. `fly certs add <host>` emite o TLS.
- **`server/go2rtc.yaml` e `bin/go2rtc.gen.yaml`** ficam efêmeros de propósito: são regenerados de
  `cameras.json` no boot. Persistir um yaml gerado é convidar divergência entre o que o painel
  cadastra e o que o go2rtc serve — que é uma das causas do bug atual.

## Rollback

O DNS antigo continua servindo o servidor atual durante toda a validação, então rollback é **não
fazer nada**. Depois de virar o domínio: reverta o registro A/AAAA. A machine pode ficar de pé
(custa) ou `fly machine stop`.

## Residual declarado

- **A saturação não foi provada como causa** do publisher cair. 88% de CPU é forte e vem do painel
  da DigitalOcean (VM inteira, última hora), não de medição por processo. O teste barato — apagar
  as 5 câmeras apontando para canal morto, que fazem retry de DESCRIBE a cada ~10 s e spawnam
  ffmpeg sem parar — ainda não foi feito. Se a imagem firmar com isso, a migração é escolha e não
  remédio.
- **`performance-2x` é ponto de partida**, não medição. O dimensionamento real sai de `ANALYSIS_*`
  (workers, fps, input) contra o número de câmeras. Meça antes de subir o tamanho.
- **Este pacote NUNCA BOOTOU.** O que foi medido, e só isso: `fly config validate` (válido),
  `bash -n` no entrypoint, o gate completo do repo verde (1682 testes, lint, typecheck, build,
  audit, tokens) e o build remoto amd64 no builder do Fly — imagem
  `registry.fly.io/visao-patio:deployment-01M146FM29M8AN6S1KX6N2GJ77`, 850 MB. Não houve boot
  local (esta máquina não tem Docker) nem release. Portanto: o entrypoint recusar-se a subir sem
  volume, os dois health checks e o ingest aceitando publish são **projeto, não medição** — a
  primeira execução é que vira evidência.
