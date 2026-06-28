# Runbook — Câmeras Demo (Frente A5)

Projeto: Visão Computacional MVP — Grendene CD Inovação
Objetivo: passo-a-passo para adicionar um feed de demonstração, validar a conectividade,
subir o hub e ver o feed na central, além de troubleshooting comum.

Referências: `analises/cameras-fontes-publicas-demo.md` (catálogo de fontes),
`server/rtsp.sources.example.json` (schema), `server/rtsp.js` (consumidor).

---

## Pré-requisitos

- **Node.js** instalado (o MVP já usa).
- **ffmpeg** (inclui o **ffprobe**) no PATH — necessário **apenas** para feeds RTSP/HLS/MJPEG.
  As câmeras de navegador funcionam sem ffmpeg.
  - Windows: `winget install Gyan.FFmpeg` (ou `choco install ffmpeg`)
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`
  - Conferir: `ffmpeg -version` e `ffprobe -version`.

---

## Arquivos desta frente

| Arquivo | Papel |
|---------|-------|
| `server/rtsp.sources.json` | Fontes ativas consumidas pelo hub. Já vem com 3 feeds **verificados**. |
| `server/rtsp.sources.extra.example.json` | Catálogo de feeds **não verificados** (modelo). Copie itens daqui para o arquivo ativo, se quiser. |
| `server/rtsp.sources.example.json` | Schema de referência (formato com câmeras reais do CD, com credenciais). |
| `scripts/validate-streams.mjs` | Validador de conectividade dos feeds. |

> O `server/rtsp.js` lê `server/rtsp.sources.json` como um array `[{ "label", "url" }]`.
> Campos extras (`protocol`, `verified`, `description`) são ignorados pelo consumidor — servem
> como documentação no próprio JSON. O ffmpeg aceita `rtsp://`, `http(s)://...m3u8` (HLS) e MJPEG
> no campo `url`, então o mesmo formato cobre os três protocolos.

---

## (a) Adicionar uma câmera demo ao `rtsp.sources.json`

1. Abra `server/rtsp.sources.json`.
2. Adicione um objeto ao array com, no mínimo, `label` e `url`:

   ```json
   {
     "label": "demo-minha-camera",
     "url": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
     "protocol": "hls",
     "verified": true,
     "description": "Para que serve / origem / observações"
   }
   ```

   - **`label`**: nome curto e claro (aparece na central). Convenção: prefixo `demo-`.
   - **`url`**: RTSP (`rtsp://...`), HLS (`https://....m3u8`) ou MJPEG (`http://.../mjpg/video.cgi`).
   - **`verified`**: `true` para feeds confirmados no catálogo; `false` para não verificados.
   - Use **apenas URLs do catálogo** (`cameras-fontes-publicas-demo.md`) ou câmeras do próprio CD.
3. Para reaproveitar um feed não verificado, copie a entrada de
   `server/rtsp.sources.extra.example.json` para o `rtsp.sources.json`.
4. **Não** use fontes de acesso não autorizado (Insecam/Shodan, câmeras privadas, varredura de IP) —
   estão fora de escopo por design (ver "Nota legal / ética" abaixo).

### Alternativa rápida (sem editar arquivo): variável de ambiente

O hub também lê a env `RTSP_SOURCES` no formato `label=url;label=url`:

```bash
RTSP_SOURCES="Teste=rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1"
```

---

## (b) Validar com o script

O validador lê o `rtsp.sources.json`, testa cada URL com ffprobe (fallback ffmpeg) e reporta
OK/FALHA com tempo de resposta e resolução detectada.

```bash
# valida o arquivo ativo (server/rtsp.sources.json)
node scripts/validate-streams.mjs

# valida outro arquivo (ex.: os feeds não verificados antes de adotá-los)
node scripts/validate-streams.mjs server/rtsp.sources.extra.example.json
```

Saída esperada (exemplo):

```
• demo-bbb-hls [verificado]
  https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
  OK  812ms  resolução 1280x720 h264

Resumo: 3 OK · 0 FALHA (de 3)
```

Comportamento:
- **Sem ffmpeg/ffprobe no PATH:** mensagem clara de instalação e saída com código `3` (não quebra).
- **Códigos de saída:** `0` tudo OK · `1` houve falha · `2` erro de arquivo/JSON · `3` ffmpeg ausente.
- **Timeout por fonte:** 20s (ajuste com `PROBE_TIMEOUT_MS`, ex.: `PROBE_TIMEOUT_MS=30000 node scripts/validate-streams.mjs`).

Teste manual equivalente (fora do app), se quiser confirmar diretamente:

```bash
# RTSP — deve gerar 1 frame JPEG
ffmpeg -rtsp_transport tcp -i "rtsp://9627b0bf2a7b.entrypoint.cloud.wowza.com:1935/app-p5260J38/66abe4b9_stream1" -frames:v 1 -f image2 teste.jpg

# HLS
ffmpeg -i "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8" -frames:v 1 -f image2 teste_hls.jpg
```

---

## (c) Subir o hub e ver o feed na central

1. Suba o servidor/hub (a partir da raiz do projeto):

   ```bash
   cd server
   npm install   # primeira vez
   npm start     # ou: node index.js
   ```

   No log deve aparecer, para cada fonte:
   `[rtsp+] demo-bbb-hls (rtsp-2) ← https://test-streams.mux.dev/...`
   Se nenhuma fonte estiver configurada: `[rtsp] nenhuma fonte RTSP configurada ...`.

2. Suba o front (em outro terminal, na raiz do projeto):

   ```bash
   npm install   # primeira vez
   npm run dev
   ```

3. Abra a central no navegador (porta indicada pelo Vite/dev server) e acesse a **central/dashboard**.
   Cada fonte do `rtsp.sources.json` aparece como uma câmera (id `rtsp-1`, `rtsp-2`, ...), com o `label`
   definido. O hub usa ffmpeg para converter o stream em frames JPEG (MJPEG) e emite o mesmo evento
   `frame` das câmeras de navegador — então zonas, análise e histórico funcionam igual.

> Ajustes de ingestão por env (opcionais): `RTSP_FPS` (padrão 8), `RTSP_WIDTH` (padrão 480),
> `RTSP_QUALITY` (padrão 7). Reduzir fps/width ajuda em redes lentas.

---

## (d) Troubleshooting comum

### ffmpeg/ffprobe ausente
- Sintoma: validador sai com código `3`; no hub aparece
  `[rtsp] ffmpeg não encontrado no PATH...`.
- Solução: instalar ffmpeg (ver pré-requisitos) e reabrir o terminal para o PATH atualizar.

### Stream conecta no ffmpeg/validador mas não aparece na central
- Confirme que o **hub** está rodando e que o **front** está conectado ao hub (socket).
- Verifique no log do hub a linha `[rtsp+] ...`. Se não houver, o `rtsp.sources.json` não foi lido
  (caminho/JSON inválido — o hub loga `rtsp.sources.json inválido`).

### RTSP trava ou cai (reconecta a cada 3s)
- O hub usa `-rtsp_transport tcp` (mais estável que UDP). Se ainda travar, a fonte pode estar offline.
- Feeds de teste **rotacionam**: a URL Wowza pode mudar — reconferir em
  https://www.wowza.com/developer/rtsp-stream-test antes da demo.
- Aumente o timeout do validador: `PROBE_TIMEOUT_MS=30000 node scripts/validate-streams.mjs`.

### Firewall / proxy corporativo
- RTSP usa portas altas (ex.: 1935/554) que o firewall do CD pode bloquear — teste em rede liberada
  ou peça liberação. HLS/MJPEG por HTTP(S) (80/443) costuma passar mais fácil; prefira-os em rede restrita.
- Atrás de proxy, exporte `HTTP_PROXY`/`HTTPS_PROXY` para o ffmpeg/Node alcançarem feeds HLS.

### Transporte / protocolo
- Para RTSP, mantenha `rtsp://` no `url` (o hub aplica `-rtsp_transport tcp`).
- Para HLS/MJPEG, use a URL `http(s)` direta; o `-rtsp_transport tcp` é ignorado pelo ffmpeg quando
  a entrada não é RTSP (não causa erro).
- **YouTube live / EarthCam**: não há URL `.m3u8` estável — extraia com `yt-dlp` antes e cole a URL resultante.

### Feed "não verificado" falha
- Esperado: itens marcados `verified: false` (Sintel, Apple BipBop, NASA TV, St-Malo, etc.) podem estar
  offline ou ter mudado de CDN. Use os **verificados** (Wowza, BBB, Tears of Steel) para a demo principal.

### Páginas iframe/web do catálogo (DER-SP, CET-SP, DAER-RS, CET-Rio, SkylineWebcams, EarthCam, Windy)
- Não entram direto no pipeline: são visualização no navegador, sem stream bruto acessível.
  Use apenas como referência de cena; para o pipeline, prefira RTSP/HLS/MJPEG da mesma cena.
- Fontes via API (511NY, NYC DOT, TrafficLand, Windy, Helios) exigem chave/cadastro e não são plug-and-play.

---

## Nota legal / ética

- **Respeitar os termos de uso** de cada fonte. Streams de teste (Wowza, Mux, Apple, Blender/CC) são
  liberados para teste/desenvolvimento. Webcams de terceiros (EarthCam, SkylineWebcams, Windy) geralmente
  permitem **somente visualização/embed** — **não** regravar nem **redistribuir** o conteúdo.
- **LGPD:** feeds com indivíduos identificáveis envolvem dados pessoais. Para demos, **prefira cenas sem
  pessoas identificáveis** (vídeos de teste, planos abertos de trânsito/porto). Não armazene nem
  reidentifique frames de pessoas reais; use apenas em tempo real para a demonstração.
- **Finalidade e minimização:** usar os feeds só para demonstrar capacidade técnica, sem persistir
  imagens de terceiros além do necessário.
- **Dados abertos governamentais** (DOTs, prefeituras) costumam permitir uso público, mas verifique a
  licença específica de cada portal.
- **Fora de escopo (recusado por design):** Insecam/Shodan, credenciais padrão e acesso direto a câmeras
  privadas — violam privacidade/LGPD. Não utilizar.
- **Produção:** câmeras RTSP do próprio CD são o caminho definitivo; os feeds públicos servem apenas
  para prototipagem/demonstração.
