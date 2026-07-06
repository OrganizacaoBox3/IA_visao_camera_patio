# Deploy da atualização — julho/2026 (motor server-side + D-FINE-S)

> Runbook da atualização de produção. Complementa `docs/deploy-digitalocean.md` (setup inicial:
> systemd `visao-hub` na 127.0.0.1:8091 + nginx servindo `dist/`). Aqui só o que MUDA nesta release.
> **Você executa (WinSCP + SSH); nada é automático.** Gate antes de ação irreversível (CLAUDE.md §8).

## 1. O que esta release muda para o deploy (leia antes)

| Mudança | Impacto no servidor |
|---|---|
| **Motor de análise no HUB** (ADR-009): D-FINE-S detecta pessoas/atividade/fluxo 24/7, sem navegador aberto | O hub agora **consome CPU** (~7 câmeras/núcleo no S; ~17 no N). Antes era só relé (leve). |
| **Deps nativas novas** (`onnxruntime-node`, `sharp`) — em `dependencies` | `npm install --omit=dev` **no servidor Linux** compila/baixa os binários nativos. **NUNCA suba o `node_modules` do Windows** (binário incompatível). |
| **Modelo ONNX baixado no 1º boot** (`server/models/`, ~40 MB, sha conferido) | Precisa de **internet de saída** no 1º boot **OU** subir o `.onnx` manualmente (offline). |
| **Histórico persistido no HUB** (Postgres, com fallback JSON `server/data-hist.json`) | Configure Postgres em produção (ou aceite o JSON single-file). `schema.sql` é idempotente. |
| **Envs novas do systemd**: `ANALYSIS_ENABLED`, `ANALYSIS_MODEL`, `ANALYSIS_FPS`, `ANALYSIS_MODEL_PATH` | Editar `deploy/visao-hub.service` no servidor. |
| **Front**: bundle −50%, tela `/cameras` nova, menu Lucide, tokens Tailwind | Transparente — é só o novo `dist/`. |
| **go2rtc EMPACOTADO no release** (Onda 2): vídeo WebRTC fluido; binário **Linux** vai no `bin/` do upload | +1 processo (sidecar) que o hub liga **sozinho** ao ver `bin/go2rtc` — **sem flag**. Abrir a porta media **8555 TCP+UDP** na LAN e o `location /go2rtc/` no nginx (§11). |

## 2. Pré-voo (antes de tocar produção)

- [ ] **Node 20+** no servidor (`node -v`). onnxruntime-node/sharp exigem.
- [ ] **CPU**: quantos núcleos a VPS tem? Ela é **compartilhada** — o motor D-FINE-S disputa CPU.
      Regra: **~7 câmeras por núcleo no S**. Se apertado → subir com `ANALYSIS_MODEL=n` (leve) ou
      `ANALYSIS_ENABLED=0` (motor off) e ligar depois de medir folga.
- [ ] **ffmpeg** instalado **só se** for ingerir RTSP no hub (`ffmpeg -version`). O motor decodifica
      JPEG com `sharp` (não ffmpeg); ffmpeg é só o ingest RTSP.
- [ ] **Internet de saída** no 1º boot (HuggingFace) OU o `.onnx` em mãos p/ upload offline.
- [ ] **Postgres**: decidir usar (recomendado) ou aceitar o fallback JSON. Se PG: ter host/db/user/senha.
- [ ] **Backup do estado atual** (passo 3) — para rollback.
- [ ] **Segredos a rotacionar** (pendência de segurança, CLAUDE.md §6): `AUTH_SECRET` e a senha do
      Postgres estiveram expostos no passado — gere valores NOVOS agora e ponha só no systemd.

## 3. Backup (rollback fácil)

No servidor, antes de sobrescrever:
```bash
sudo cp -a /var/www/visao-patio /var/www/visao-patio.bak-$(date +%F)
# guarda o systemd atual também
sudo cp /etc/systemd/system/visao-hub.service /root/visao-hub.service.bak
```
`server/cameras.json`, `alarms.json`, `camcfg.json`, `wa-auth/`, `data-hist.json` são ESTADO de
runtime — **não sobrescreva** (o upload do passo 5 não os inclui; confirme).

## 4. Build local (na sua máquina Windows)
```powershell
cd C:\Users\crist\grendene_cd_inovacao\visao_computacional_mvp
npm install
npm run verify   # lint + typecheck + build + 210 testes — TEM que passar (gate antes de subir)
```
Isso gera `dist/` novo. Opcional: `npm run eval` (confere que o modelo não regrediu).

### 4.1 Empacotar o go2rtc (vídeo WebRTC) no release — Onda 2

Antes de subir, baixe o binário **Linux** do go2rtc para `bin/`. A build é Windows, **mas o servidor é
Linux** — pegue o binário do SO do **servidor**, não o `.exe`:
```powershell
node scripts/fetch-go2rtc.mjs --platform linux-amd64
```
O script baixa `go2rtc_linux_amd64` (verificação de sha), grava em `bin/go2rtc` e já marca `+x`. O
binário **NÃO vai no git** (gitignored) — é artefato de release: sobe junto no WinSCP (passo 5). Sem ele,
o hub simplesmente segue no MJPEG (fallback). Rode `--platform win64` só se quiser testar WebRTC local
no Windows (esse `bin/go2rtc.exe` **não** sobe para o servidor).

## 5. Upload via WinSCP

Conecte no servidor. Suba para uma pasta temporária (ex.: `/tmp/visao-up/`) **estas pastas/arquivos**:

**SOBE:**
- `dist/` (front novo)
- `server/` (inclui `server/analysis/` — o motor — e `server/schema.sql`)
- `package.json` e `package-lock.json`
- `bin/` (binário **Linux** do go2rtc, do passo 4.1 — só o `go2rtc`, **nunca** o `.exe` do Windows)
- `deploy/` (só se mudou; o systemd/nginx base são os mesmos)

**NÃO SOBE (importante):**
- ❌ `node_modules/` — binários do Windows quebram no Linux (reinstala no servidor).
- ❌ `server/models/` — a menos que seja **deploy offline** (ver passo 6B).
- ❌ `.env*`, segredos, `server/*.json` de runtime (`cameras.json`/`alarms.json`/`camcfg.json`/
      `data-hist.json`), `wa-auth/` — são estado/segredo do servidor.

Depois, no SSH:
```bash
# posiciona (preserva os *.json de runtime existentes: copie SÓ o que subiu, sem apagar o resto)
sudo cp -r /tmp/visao-up/dist /tmp/visao-up/server /tmp/visao-up/bin /tmp/visao-up/package.json /tmp/visao-up/package-lock.json /var/www/visao-patio/
sudo cp -r /tmp/visao-up/deploy /var/www/visao-patio/ 2>/dev/null || true
cd /var/www/visao-patio
sudo npm install --omit=dev        # baixa os prebuilds Linux de onnxruntime-node + sharp (1-3 min)
sudo chmod +x bin/go2rtc           # garante +x (o WinSCP pode perder a permissão na transferência)
sudo chown -R visao:visao /var/www/visao-patio
```
> Se o `npm install` tentar COMPILAR (sem prebuilt p/ a arquitetura) e falhar, instale o toolchain:
> `sudo apt install -y build-essential python3`. Em x86_64 comum os prebuilds cobrem — raramente necessário.

## 6. Modelo do motor

**6A. Online (padrão):** nada a fazer — no 1º boot o hub baixa `server/models/dfine_s_obj2coco.onnx`
(sha conferido; se falhar, cai p/ N e loga aviso). Veja no log `[analysis]`.

**6B. Offline / VPS sem internet de saída:** na sua máquina o arquivo já está em
`server\models\dfine_s_obj2coco.onnx` (dos testes). Suba-o via WinSCP para
`/var/www/visao-patio/server/models/` e, no systemd, aponte:
`Environment=ANALYSIS_MODEL_PATH=/var/www/visao-patio/server/models/dfine_s_obj2coco.onnx`.

## 7. Env do systemd (`deploy/visao-hub.service`)

```bash
sudo nano /etc/systemd/system/visao-hub.service
```
Acrescente ao bloco `[Service]` (além das já existentes `HOST/PORT/PANEL_PASSWORD/…`):
```ini
Environment=ANALYSIS_ENABLED=1
Environment=ANALYSIS_MODEL=s          # s=recall (default) · n=leve (CPU apertada) · m=teto
# Environment=ANALYSIS_MODEL_PATH=/var/www/visao-patio/server/models/dfine_s_obj2coco.onnx  # só offline
Environment=AUTH_SECRET=<GERE_UM_NOVO_SEGREDO_FORTE>      # ROTACIONAR (esteve exposto)
# Postgres (recomendado; sem isto usa fallback JSON):
Environment=PGHOST=127.0.0.1
Environment=PGPORT=5432
Environment=PGDATABASE=visao
Environment=PGUSER=visao
Environment=PGPASSWORD=<SENHA_NOVA>   # ROTACIONAR
```
Envs avançadas de tuning do motor (`ANALYSIS_FPS`, `ANALYSIS_HIGH_SCORE`, `ANALYSIS_SCORE_MIN`,
`ANALYSIS_INTRA_THREADS`, `ANALYSIS_NMS_IOU`, `DATA_HIST_RETENTION_DAYS`) têm defaults sensatos —
ver `server/analysis/README.md`. Só mexa se o dimensionamento pedir.

> **go2rtc não precisa de env (Onda 2).** `GO2RTC_ENABLED`/`GO2RTC_BIN` **saíram** do caminho comum:
> o hub liga o sidecar sozinho ao encontrar `bin/go2rtc` (§11). Único escape hatch:
> `Environment=GO2RTC_ENABLED=0` para desligar de vez. `GO2RTC_WEBRTC_CANDIDATES` só se for servir
> WebRTC **fora da LAN** (§11.2).

Se for usar Postgres, crie o schema uma vez (idempotente):
```bash
psql "postgresql://visao:<SENHA>@127.0.0.1:5432/visao" -f /var/www/visao-patio/server/schema.sql
```
Aplicar e reiniciar:
```bash
sudo systemctl daemon-reload
sudo systemctl restart visao-hub
journalctl -u visao-hub -n 40 --no-pager   # procure: "ouvindo em ...8091", "[analysis]" com o modelo
```
> O front é estático: se só o `dist/` mudou bastaria `reload nginx`; mas esta release mudou o
> `server/` → o **restart do hub é obrigatório**.

## 8. Validação (checklist)

- [ ] `systemctl status visao-hub` = **active (running)**; log sem stacktrace.
- [ ] `curl -sS http://127.0.0.1:8091/api/analysis/status` (com auth) → `{enabled:true, model:"dfine_s…",
      perCamera:{…fps,queue}}`. A 8091 **não** alcançável de fora.
- [ ] Abra `https://visao.seudominio.com`: dashboard carrega, rodapé "conectado".
- [ ] **A prova do motor 24/7:** com uma câmera ativa e **nenhum operador olhando**, o Relatório
      acumula (aba Atividade/Fluxo) em ~2 min — indicadores gravados pelo HUB.
- [ ] Câmera aberta mostra **"análise: hub"** na telemetria; muitas mais pessoas detectadas (D-FINE-S).
- [ ] CPU do servidor sob carga real (`top`/`htop`): dentro do orçamento (senão `ANALYSIS_MODEL=n` + restart).
- [ ] DevTools sem erro de CSP/mixed-content.

## 9. Rollback (se algo der errado)
```bash
sudo systemctl stop visao-hub
sudo rm -rf /var/www/visao-patio
sudo mv /var/www/visao-patio.bak-<data> /var/www/visao-patio
sudo cp /root/visao-hub.service.bak /etc/systemd/system/visao-hub.service
sudo systemctl daemon-reload && sudo systemctl start visao-hub
sudo systemctl reload nginx
```
Rollback "leve" (só desligar o motor, manter o resto): `ANALYSIS_ENABLED=0` no systemd + restart.

## 10. Pós-deploy (não esquecer)
- [ ] Confirmar que `AUTH_SECRET` e a senha do Postgres foram **rotacionados** (valores novos, só no systemd).
- [ ] Definir os hotspots de falso positivo (grade/placa/janela) com **zona de Exclusão** por câmera
      (Central → abrir câmera → ✎ Zona → Modo: Exclusão) — ver manual.
- [ ] Se o servidor for pequeno: revisar `ANALYSIS_MODEL` (n/s) conforme o nº de câmeras (~7/núcleo no S).

## 11. go2rtc — vídeo WebRTC empacotado (Onda 2 da simplificação)

Esta release **empacota** o gateway go2rtc no deploy (**não baixa em runtime**) e o hub o liga
**sozinho** — sem `GO2RTC_ENABLED`/`GO2RTC_BIN`. WebRTC vira o transporte automático dos tiles, com
**fallback MJPEG** por câmera quando o gateway não sobe. O binário Linux entra pelo passo 4.1 (empacotar)
e sobe no `bin/` (passo 5).

### 11.1 Como o hub liga (sem flag)

- O hub procura `bin/go2rtc` (Linux) / `bin/go2rtc.exe` (Windows) na raiz da app. **Achou → sobe o
  sidecar sozinho**: gera o `go2rtc.gen.yaml` a partir das câmeras atuais (o `id` da câmera vira o nome
  do stream), supervisiona com restart/backoff e faz o proxy same-origin `/go2rtc/`.
- **Não achou o binário — ou o processo/porta falha → o hub segue no MJPEG** por câmera. Nenhuma
  intervenção; nada quebra.
- **Escape hatch:** `Environment=GO2RTC_ENABLED=0` no systemd desliga de vez (raro — nó só-vídeo/sem WebRTC).
- **Nenhuma env é necessária** no caminho comum. Portas default: API `1984` (só loopback), RTSP `8554`,
  media WebRTC `8555`. O `api.origin` já vai no YAML gerado (libera o handshake WS atrás do proxy).
- **LGPD/ADR-002:** o YAML gerado **não** tem módulo `record:` — go2rtc só relaya/remuxa, frames seguem
  efêmeros. O YAML pode conter credenciais RTSP → é escrito ao lado do binário (em `bin/`, gitignored).

### 11.2 nginx — expor `/go2rtc/` (same-origin) + porta media

Adicione ao server block (`deploy/nginx-visao.conf`), ao lado de `/socket.io/` e `/api/`:
```nginx
location /go2rtc/ {
    proxy_pass http://127.0.0.1:1984/;        # barra final: remove o prefixo /go2rtc/
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;             # sinalização WebRTC (/api/ws)
    proxy_set_header Connection $connection_upgrade;    # reusa o map já usado por /socket.io/
    proxy_set_header Host $host;
    proxy_read_timeout 600s;
    proxy_buffering off;
}
```
`sudo nginx -t && sudo systemctl reload nginx`. Como já é same-origin (`wss:`/`blob:`/`'self'` no CSP),
**o CSP não muda**.

**Porta media 8555 (TCP+UDP)** precisa ser alcançável na **LAN do CD** — é por onde trafega o vídeo
WebRTC (ICE/DTLS/SRTP, fora do CSP). Em LAN direta, basta não bloquear no firewall do host:
```bash
sudo ufw allow 8555/tcp && sudo ufw allow 8555/udp   # se usar ufw; senão libere no firewall do host
```
Acesso de **fora da LAN** exige anunciar os candidatos:
`Environment=GO2RTC_WEBRTC_CANDIDATES=IP_PUBLICO:8555,stun:8555` — **não** é necessário para operação
intra-LAN.

### 11.3 Validação

- [ ] Log do hub no boot mostra `[go2rtc] iniciado (pid …)` (e **não** "desligado").
- [ ] `curl -sS http://127.0.0.1:1984/api/streams` no servidor lista as câmeras (gateway no ar).
- [ ] No dashboard, um tile abre em **WebRTC** (fluido, sem "trava-e-pula"); DevTools sem erro de CSP.
- [ ] Renomeie `bin/go2rtc` e `restart` do hub → os tiles voltam a **MJPEG** sozinhos (prova do fallback).

## 12. Delta da release de otimização (jul/05) — pool, gate de movimento, foco

**Nada a configurar** (tudo automático, defaults sensatos) — este delta só documenta o que MUDA
no comportamento e os escape hatches novos:

| Novidade | Comportamento | Escape hatch |
|---|---|---|
| **Pool de N workers** | N = `min(cores/2, câmeras)`; respawn por-worker; RAM ~200-240MB × N | `ANALYSIS_WORKERS=<n>` fixa |
| **Gate de movimento** | Pula a inferência em cena estática (thumbnail 64×48 + diff); probe-piso 6s (2s focada); nunca-cego | `ANALYSIS_MOTION_GATE=0` desliga; `ANALYSIS_MOTION_RATIO` (0.005), `ANALYSIS_MOTION_PROBE_MS` (6000) |
| **Boost de foco** | Câmera aberta em tela cheia analisa a ~6fps (evento `analysis-focus`) | `ANALYSIS_FPS_FOCUS` (clamp [FPS,8]) |
| **Autoscale latency-bound** | Rebaixa o tier também quando a LATÊNCIA afoga (fps<50% do alvo com workers ocupados) — corrige o "preso no M" | `ANALYSIS_MODEL=n\|s\|m` pina (desliga o auto) |
| **Input configurável** | Default **640** (mantido por evidência — ver `analises/perf-input-size-dfine.md`) | `ANALYSIS_INPUT=512` p/ hub apertado SEM pessoa distante |
| **vx/vy no `analysis-tracks`** | Aditivo — o front novo faz dead-reckoning (overlay desliza); front antigo ignora | — |
| **Front**: WebGL explícito no worker, luma com teto, rVFC | Transparente (é o novo `dist/`) | — |

**Validação do delta no servidor:**
- [ ] Boot: `pool de N worker(s)` com N esperado (ex.: 2 num 4-core) e `auto-máscara=hide`.
- [ ] `journalctl … | grep "pulos/gate"` → cenas paradas acumulam pulos (o corte de CPU real).
- [ ] Tier: se o boot escolher M num box pequeno, em ~90s de carga o log mostra `latency-bound 3×` e desce p/ S sozinho.
- [ ] `status().motionGate.skipped1m` > 0 com câmeras estáticas; câmera com gente NÃO pula.
- [ ] Bancada determinística (opcional, recomendado): MediaMTX na porta **8556** + loop CFTV — ver `analises/plano-teste-camera-real.md` (tier 2, seção HOMOLOG).
