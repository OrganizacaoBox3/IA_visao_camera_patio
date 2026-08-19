# Deploy da atualização — agosto/2026 (correções de segurança + sensor de latência)

> Runbook DESTA release. O procedimento-base (systemd `visao-hub` na 127.0.0.1:8091, nginx servindo
> `dist/`, go2rtc, backup e rollback) continua em
> [`deploy-atualizacao-2026-07.md`](deploy-atualizacao-2026-07.md) e
> [`deploy-digitalocean.md`](deploy-digitalocean.md) — **não** foi duplicado aqui.
> **O que este documento acrescenta:** o delta da release, a superfície de comando para **macOS**
> (o de julho assume Windows + WinSCP) e as duas armadilhas específicas.
>
> **Você executa; nada é automático.** Gate antes de ação irreversível (CLAUDE.md §8).

## 1. Por que esta release vale um deploy

**O motivo nº 1 é segurança, não feature.** Quatro vulnerabilidades **high** estavam no ar e foram
corrigidas **para cima**, sem nenhum downgrade:

| Pacote | Faixa vulnerável | Agora |
|---|---|---|
| `react-router` | 7.12.0 – 7.18.1 | **7.18.2** |
| `brace-expansion` | 4.0.0 – 5.0.8 | **5.0.9** |
| `socket.io-parser` | 4.0.0 – 4.2.6 | **4.2.7** |
| `nanoid` | < 3.3.18 | **3.3.18** |

Três detalhes que explicam por que elas sobreviveram tanto: `react-router-dom` estava declarado
**duas vezes** no `package.json` (o npm resolvia pela entrada errada), o `node_modules` estava
**fora de sincronia** com o `package.json`, e o override do `brace-expansion` apontava para
`^5.0.8` — **o topo da faixa vulnerável**, ou seja, parecia mitigado e não estava.

## 2. O que mais muda

| Mudança | Impacto no servidor |
|---|---|
| **Vídeo ao vivo puro** (`overlay.syncDelayMs` 2000 → 0) e pedido explícito de **buffer mínimo** ao navegador | Só `dist/`. O operador passa a ver o mundo AGORA em vez de ~2 s atrás. **Residual:** no mosaico (1 fps) o marcador volta a depender de dead-reckoning |
| **Sensor de idade do quadro** — `frameAge {p50,p90,n,trend}` por câmera no `GET /api/analysis/status`, **aditivo** | Só `server/`. **Nenhuma env nova** — liga sozinho |
| **Coluna "idade p50/p90"** no painel de Saúde do motor | Só `dist/` |
| **Preset de 2 s** no dwell da área restrita | Só `dist/` |
| **`scripts/diagnose-source.mjs`** — mede se o quadro chega EM DIA (fps efetivo, idade p50/p90, fila) | Vale subir: é a ferramenta de diagnóstico quando a imagem atrasar em produção |

## 3. As duas armadilhas desta release

**3.1 · `bin/go2rtc` é por PLATAFORMA.** O binário no repo de desenvolvimento agora é build de
**macOS**. Subir esse para o Linux não dá erro alto: o sidecar não sobe e o vídeo **cai
silenciosamente para MJPEG**. Confirme a arquitetura do servidor antes:

```bash
ssh <servidor> 'uname -m'      # x86_64 → linux-amd64 · aarch64 → linux-arm64
```

**3.2 · `socket.io-parser` mudou nos DOIS lados.** Ele é o protocolo do socket: o cliente vive
dentro do `dist/` e o servidor em `server/`. Suba os dois **juntos** — meio deploy é o cenário a
evitar. É bump de patch (4.2.6 → 4.2.7), compatível, mas aba de `/camera` aberta em celular
continua no cliente antigo **até recarregar a página**.

## 4. Pré-voo

- [ ] `node -v` no servidor: **20+** (onnxruntime-node/sharp exigem).
- [ ] `uname -m` no servidor (define a plataforma do go2rtc — §3.1).
- [ ] Backup, exatamente como no runbook de julho §3 — `cp -a` preserva o `node_modules` atual, e é
      isso que torna o rollback do §7 barato.
- [ ] Nada de env nova para preparar nesta release.

## 5. Build local (macOS)

```bash
cd ~/Documents/projetos/grendene/cd-inovacao/visao_computacional_mvp
git pull
npm ci                 # instala EXATAMENTE o lock (é o que corrige a deriva de árvore)
npm run verify         # lint + typecheck + build + 1598 testes + audit — TEM que fechar verde
node scripts/fetch-go2rtc.mjs --platform linux-amd64   # ou linux-arm64, conforme o uname -m
```

O `verify` verde é o gate. Ele agora **inclui o `audit` limpo** (0 exceções na allowlist) — se
reprovar ali, apareceu vulnerabilidade nova e o deploy espera.

> ⚠ O `fetch-go2rtc --platform linux-*` **sobrescreve** o `bin/go2rtc` local pelo binário Linux.
> Para voltar a rodar WebRTC nesta máquina depois, rode o script sem `--platform`.

## 6. Upload (rsync, no lugar do WinSCP)

`rsync` em vez de cópia manual porque ele **não apaga o que não subiu** e mostra o que mudou.
Note o `--exclude` do estado de runtime: `cameras.json`, `alarms.json`, `camcfg.json`,
`data-hist.json` e `wa-auth/` são **estado do servidor** e não podem ser sobrescritos.

```bash
SRV=<usuario>@<host>

rsync -avz --delete dist/            "$SRV:/tmp/visao-up/dist/"
rsync -avz --exclude 'feira.sh' scripts/ "$SRV:/tmp/visao-up/scripts/"
#                    ^^^^^^^^^^^ NUNCA em produção: o perfil de feira DESLIGA o
#                    anti-flapping e o dedup do alarme (é para balcão, não para CD).
rsync -avz            bin/go2rtc     "$SRV:/tmp/visao-up/bin/go2rtc"
rsync -avz package.json package-lock.json "$SRV:/tmp/visao-up/"
rsync -avz \
  --exclude 'models/'      --exclude 'wa-auth/' \
  --exclude 'cameras.json' --exclude 'alarms.json' \
  --exclude 'camcfg.json'  --exclude 'alarm-shelves.json' \
  --exclude 'rtsp.sources.json' --exclude 'data-hist.json' \
  --exclude 'users.json'   --exclude 'node_modules/' \
  server/ "$SRV:/tmp/visao-up/server/"
```

**NÃO sobe:** `node_modules/` (binário nativo de macOS quebra no Linux), `server/models/` (o modelo
já está lá; só em deploy offline — julho §6B), `.env*`, o estado de runtime excluído acima, e
**`scripts/feira.sh`** — ele desliga guardas de fadiga de alarme de propósito (perfil de balcão);
num CD, alarme que repete sem parar é o defeito que o ADR-004 existe para evitar.

## 7. No servidor

```bash
sudo systemctl stop visao-hub        # o npm ci abaixo esvazia node_modules; melhor parar antes

cd /var/www/visao-patio
sudo cp -r /tmp/visao-up/dist /tmp/visao-up/server /tmp/visao-up/scripts \
           /tmp/visao-up/bin /tmp/visao-up/package.json /tmp/visao-up/package-lock.json ./

sudo npm ci --omit=dev               # ← `ci`, não `install` (ver nota)
sudo chmod +x bin/go2rtc             # a transferência pode perder o bit de execução
sudo chown -R visao:visao /var/www/visao-patio

sudo systemctl start visao-hub
journalctl -u visao-hub -n 40 --no-pager
```

> **Por que `npm ci` e não `npm install`:** a deriva de árvore que esta release corrige nasceu
> justamente de um `install` que nunca reconciliou — o `package.json` dizia uma coisa e o
> `node_modules` tinha outra, e nada avisava. `ci` instala **exatamente** o lock e falha alto se os
> dois divergirem. O custo é reinstalar os nativos (`onnxruntime-node`, `sharp`): 1–3 min. Por isso
> o serviço para antes e o backup do §4 existe.

## 8. Validação — o que é NOVO nesta release

Além do checklist de julho §8:

- [ ] **Sensor de idade no ar.** No servidor:
      `curl -sS http://127.0.0.1:8091/api/analysis/status` (com auth) → cada câmera traz
      `frameAge: { p50, p90, n, trend }`. Câmera parada/gateada traz `null` — e `null` é o valor
      **certo** para "não medi nada", não um zero disfarçado.
- [ ] **Idade dentro do esperado:** p50 < 200 ms e p90 < 400 ms. **Se `trend` for positivo e grande,
      há FILA** — o atraso está acumulando, e aí a ferramenta é o §9.
- [ ] **Painel de Saúde** (Relatório) mostra a coluna "idade p50/p90", neutra quando normal.
- [ ] **Vídeo ao vivo:** abrir uma câmera em tela cheia e acenar. A reação é imediata, não ~2 s
      depois. Se o marcador descolar visivelmente de quem anda rápido, é o trade declarado do
      `syncDelayMs = 0` — o caminho é subir o valor no `src/config.ts` e rebuildar, **não** voltar a
      calar o pedido de buffer mínimo.
- [ ] **Preset de 2 s** aparece em Zona → Área restrita → "Alertar se presença acima de".
- [ ] **A prova das correções:** `npm audit --omit=dev` no servidor sem high/critical.

## 9. Diagnóstico quando a imagem atrasar (novo nesta release)

Antes de acusar o modelo, meça a fonte — foi para isso que o script existe:

```bash
cd /var/www/visao-patio
node scripts/diagnose-source.mjs 'rtsp://<usuario>:<senha>@<camera>:554/<path>' 10
```

Imprime fps efetivo, **mediana e p90 da idade do quadro** e quantos foram descartados. Idade que
**cresce** ao longo da janela é fila, e o script sai com código 1 nesse caso. A flag `--queue`
reproduz o defeito de propósito (medido: idade mediana de 3 ms no regime normal contra 4.083 ms
enfileirando) — útil para mostrar a diferença a quem não acredita nela.

A URL pode carregar credencial: o script **redige** usuário/senha na saída (mesma função de
`server/rtsp.js`). Ainda assim, prefira não colar a saída em canal público.

## 10. Rollback

Idêntico ao de julho §9 (`mv` do `.bak-<data>` de volta + `daemon-reload` + `start`). Dois
rollbacks parciais, mais baratos, que resolvem os riscos específicos desta release:

- **Marcador descolando** → `overlay.syncDelayMs` de volta a 2000 em `src/config.ts`, rebuild,
  subir só o `dist/`. Não requer tocar no servidor além do estático.
- **Motor pesando** → `ANALYSIS_MODEL=n` no systemd + restart (o sensor de idade continua valendo;
  ele é instrumentação, não custa recall).

## 11. Pós-deploy

- [ ] As pendências de segurança de julho §10 **seguem abertas**: rotacionar `AUTH_SECRET` e a senha
      do Postgres do homolog, que aceitam defaults inseguros (P1 de
      `docs/analises/saude/01-auditoria-doutrina-2026-07.md`). Esta release **não** as resolve.
- [ ] Anotar a **idade do quadro medida em produção** — os limiares 200/400 ms do painel foram
      **escolhidos, não medidos em campo**. O primeiro número real de produção é o que os calibra.
- [ ] `git config core.hooksPath .githooks` **por clone** — o pre-push é local e não viaja no git.
