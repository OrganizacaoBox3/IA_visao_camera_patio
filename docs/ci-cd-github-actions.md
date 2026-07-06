# CI/CD com GitHub Actions — setup do zero ao primeiro deploy do HOMOLOG

> O repo local **ainda não tem remote**. Este guia leva do zero — criar o repo privado no
> GitHub — até o primeiro deploy no HOMOLOG (VPS Ubuntu/DigitalOcean) via Actions.
> O CD (`.github/workflows/deploy-homolog.yml`) automatiza o runbook manual
> `docs/deploy-atualizacao-2026-07.md`; o setup **inicial** do servidor continua sendo
> `docs/deploy-digitalocean.md` (o CD atualiza uma instalação existente, não faz bootstrap).

## 0. Mapa dos workflows

| Workflow | Disparo | O quê |
|---|---|---|
| `.github/workflows/ci.yml` | **automático** (todo push/PR) | Gate de verificação na nuvem (`npm run verify`; a frente de CI está evoluindo — e2e/eval etc. A fonte da verdade é o próprio arquivo). |
| `.github/workflows/deploy-homolog.yml` | **manual** (`workflow_dispatch`) | CD do homolog: build+gate no runner → (aprovação opcional) → SSH no VPS → backup → posiciona → `npm install --omit=dev` → restart → health-check. |

```
push ──────────────► CI (verify)                      [automático, informa]
Actions → "Deploy Homolog" → Run workflow             [manual — humano no loop]
   └─ build:  npm ci → npm run verify (GATE) → fetch go2rtc linux → tar (só o que sobe)
   └─ [aprovação do environment "homolog" — se required reviewers configurados]
   └─ deploy: scp → backup .bak-<stamp> → posiciona (preserva estado de runtime)
              → npm install --omit=dev → chmod +x go2rtc → chown visao:visao
              → systemctl restart visao-hub → HEALTH-CHECK (falhou = vermelho + instrução
                de rollback no log; SEM rollback automático)
```

Por que o deploy é **manual e nunca auto-on-push**: CLAUDE.md §8 — gate determinístico
antes de ação irreversível = teste-verde **ou** aprovação humana. Aqui há os dois: o
`verify` roda **dentro** do workflow de deploy (vermelho = o servidor nem é tocado) e o
disparo/aprovação são humanos.

---

## 1. Criar o repo no GitHub e conectar o local

### 1.1 Repo **PRIVADO** — não é opcional

Código proprietário da casa. A política de IA (CLAUDE.md §8) exige tier comercial/no-train
para código não-público — um repo público quebraria essa premissa na origem. **Privado, sempre.**
Nunca versionar/colar segredos (o `.gitignore` já cobre os de runtime; ver sanidade em 1.4).

### 1.2 Autenticar o `gh` (o token atual está inválido)

```powershell
gh auth login
# GitHub.com → HTTPS → Login with a web browser
gh auth status   # confere
```

> **Importante:** o push de arquivos em `.github/workflows/` exige o escopo **`workflow`**
> no token. O fluxo web do `gh auth login` já o inclui; se usar PAT manual, marque
> `repo` + `workflow` — sem isso o push falha com
> `refusing to allow an OAuth App to create or update workflow`.

### 1.3 Branch default: renomear `master` → `main` (recomendação única)

O branch local chama-se `master`. **Decisão: renomear para `main`** e padronizar nisso —
é o default do GitHub e o que as ferramentas (PRs, Actions, integrações) assumem; manter
`master` funcionaria, mas criaria duas convenções para sempre. Uma linha, antes do push:

```powershell
git branch -m master main
```

### 1.4 Sanidade pré-push (nenhum segredo vai junto)

```powershell
git ls-files | Select-String -Pattern '\.env$|cameras\.json$|alarms\.json$|users\.json$|wa-auth|data-hist|visao-hub\.service$'
```

Deve retornar **vazio** (só `*.example*` e `visao-hub.service.example` são tracked — ok).

### 1.5 Criar o repo e fazer o primeiro push

```powershell
# tudo-em-um: cria PRIVADO, adiciona o remote "origin" e faz o push
gh repo create SEU-USUARIO-OU-ORG/visao_computacional_mvp --private --source . --remote origin --push
```

Ou manual: criar o repo privado no site → `git remote add origin https://github.com/SEU-USUARIO-OU-ORG/visao_computacional_mvp.git` → `git push -u origin main`.
O primeiro push já dispara o CI (`ci.yml`) — confira o verde na aba **Actions**.

---

## 2. Deploy key + secrets

### 2.1 Gerar a chave SSH dedicada (nunca reutilize sua chave pessoal)

Na sua máquina:

```powershell
ssh-keygen -t ed25519 -C "gha-deploy-visao-homolog" -f visao_homolog_deploy -N '""'
# (no Git Bash/Linux: -N "" — sem passphrase: o runner não digita senha)
```

Gera `visao_homolog_deploy` (privada → vira secret) e `visao_homolog_deploy.pub` (pública → VPS).

### 2.2 Instalar a pública no VPS

```bash
# no VPS, como o usuário de deploy escolhido (ver 2.3):
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'CONTEUDO-DA-.pub' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Teste da sua máquina: `ssh -i .\visao_homolog_deploy usuario@IP.DO.VPS 'echo ok'`.

### 2.3 Usuário de deploy: sudoers **RESTRITO** (VPS compartilhada — nada de NOPASSWD amplo)

O script remoto usa `sudo -n` (não-interativo — falha em vez de pendurar esperando senha).
Num VPS que hospeda **outras aplicações**, o usuário de deploy **não** deve ter
`NOPASSWD:ALL`: o sudo é liberado **apenas para os comandos exatos que o script executa**,
com caminhos absolutos. Crie o usuário dedicado (ex.: `deploy`) e instale o arquivo abaixo:

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo visudo -f /etc/sudoers.d/visao-deploy   # cole o conteúdo; o visudo valida ao salvar
```

Conteúdo de `/etc/sudoers.d/visao-deploy` (pronto para colar — troque `deploy` pelo nome
real do usuário, o mesmo do secret `HOMOLOG_SSH_USER`):

```
# sudo RESTRITO do CD do visao (deploy-homolog.yml) — só os comandos exatos do script
# remoto, com caminhos absolutos. Confirme os paths com `command -v cp systemctl npm`
# (Ubuntu usrmerge: tudo em /usr/bin; npm via NodeSource = /usr/bin/npm).

Cmnd_Alias VISAO_BACKUP = /usr/bin/cp -a /var/www/visao-patio /var/www/visao-patio.bak-*
Cmnd_Alias VISAO_STAGE  = /usr/bin/rm -rf /tmp/visao-deploy-staging
Cmnd_Alias VISAO_PLACE  = /usr/bin/mkdir -p /var/www/visao-patio/dist /var/www/visao-patio/bin /var/www/visao-patio/scripts, \
                          /usr/bin/cp -r /tmp/visao-deploy-staging/dist/. /var/www/visao-patio/dist/, \
                          /usr/bin/cp -r /tmp/visao-deploy-staging/server/. /var/www/visao-patio/server/, \
                          /usr/bin/cp /tmp/visao-deploy-staging/bin/go2rtc /var/www/visao-patio/bin/go2rtc.new, \
                          /usr/bin/mv -f /var/www/visao-patio/bin/go2rtc.new /var/www/visao-patio/bin/go2rtc, \
                          /usr/bin/cp -r /tmp/visao-deploy-staging/scripts/. /var/www/visao-patio/scripts/, \
                          /usr/bin/cp /tmp/visao-deploy-staging/package.json /tmp/visao-deploy-staging/package-lock.json /var/www/visao-patio/
Cmnd_Alias VISAO_NPM    = /usr/bin/npm install --omit=dev --no-audit --no-fund
Cmnd_Alias VISAO_PERMS  = /usr/bin/chmod +x /var/www/visao-patio/bin/go2rtc, \
                          /usr/bin/chown -R visao\:visao /var/www/visao-patio
Cmnd_Alias VISAO_SVC    = /usr/bin/systemctl cat visao-hub, \
                          /usr/bin/systemctl restart visao-hub, \
                          /usr/bin/systemctl status visao-hub --no-pager
Cmnd_Alias VISAO_LOGS   = /usr/bin/journalctl -u visao-hub *

deploy ALL=(root) NOPASSWD: VISAO_BACKUP, VISAO_STAGE, VISAO_PLACE, VISAO_NPM, VISAO_PERMS, VISAO_SVC, VISAO_LOGS
```

Teste no VPS, logado como `deploy`: `sudo -n systemctl status visao-hub --no-pager`
(deve responder sem pedir senha) e `sudo -n ls /` (deve **falhar** — não está na lista).

> **Honestidade técnica — limites do sudoers:** (1) wildcards do sudoers casam inclusive
> espaços (ex.: o `*` de `journalctl -u visao-hub *` aceita argumentos extras), então a
> lista **reduz o raio de explosão**, não é sandbox perfeito — o perímetro real continua
> sendo a chave dedicada + repo privado + aprovação do environment; (2) o
> `npm install` liberado roda **como root** os install-scripts das deps (ver residuais,
> §9); (3) se o script remoto mudar, este arquivo precisa mudar **no mesmo PR** — o
> deploy falha alto (`sudo: a password is required`) se divergir, nunca silencioso.

Alternativa (**não recomendada** neste VPS): `HOMOLOG_SSH_USER=root` — o script detecta e
dispensa o sudo, mas abre mão de todo o confinamento acima. Só se o dono do VPS já opera
assim e aceita o risco explicitamente.

> **`from=` no authorized_keys** (restringir a chave por IP de origem): só é prático com
> runner **self-hosted**. Runners GitHub-hosted têm IPs variáveis (ranges enormes em
> `api.github.com/meta`) — não vale a manutenção agora. Fica como hardening futuro (§8).

### 2.4 Cadastrar os secrets — **no environment `homolog`** (crie-o antes, §3)

Secrets de environment > secrets de repositório: só o job com `environment: homolog` os lê,
e somente **depois** da aprovação (quando houver reviewers).

| Secret | Valor | Obrigatório |
|---|---|---|
| `HOMOLOG_SSH_HOST` | IP ou hostname do VPS | sim |
| `HOMOLOG_SSH_USER` | usuário SSH de deploy (2.3) | sim |
| `HOMOLOG_SSH_KEY` | **conteúdo completo** do arquivo `visao_homolog_deploy` (a chave PRIVADA, com as linhas `-----BEGIN/END OPENSSH PRIVATE KEY-----`) | sim |
| `HOMOLOG_SSH_PORT` | porta SSH, se ≠ 22 | não (default 22) |
| `HOMOLOG_SSH_KNOWN_HOSTS` | linha(s) `known_hosts` do VPS — **pina** a host key (elimina o TOFU; ver 2.5) | não (recomendado) |

Pela UI: **Settings → Environments → homolog → Environment secrets → Add secret**. Ou CLI:

```powershell
gh secret set HOMOLOG_SSH_KEY  --env homolog < visao_homolog_deploy
gh secret set HOMOLOG_SSH_HOST --env homolog --body "IP.DO.VPS"
gh secret set HOMOLOG_SSH_USER --env homolog --body "deploy"
# gh secret set HOMOLOG_SSH_PORT --env homolog --body "22"   # só se ≠ 22
```

Depois de cadastrar, **apague a chave privada da sua máquina** (ela passa a existir só no
secret e no seu backup de segredos, se houver):

```powershell
Remove-Item .\visao_homolog_deploy
```

### 2.5 (Recomendado) Pinar a host key do VPS — eliminar o TOFU

Sem o secret `HOMOLOG_SSH_KNOWN_HOSTS`, o workflow roda `ssh-keyscan` na hora do deploy e
confia na chave apresentada (**TOFU** — trust on first use; um MITM na janela do deploy é
teórico, mas existe). Para **pinar** a fingerprint real:

1. **No VPS** (fonte da verdade — via console do provedor ou sessão SSH já confiável),
   colete a fingerprint da chave do host:

   ```bash
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

2. **Na sua máquina**, gere a linha `known_hosts` e **confira** que a fingerprint bate com
   a do passo 1 antes de confiar:

   ```powershell
   ssh-keyscan -t ed25519 IP.DO.VPS            # saída = linha known_hosts
   ssh-keyscan -t ed25519 IP.DO.VPS | ssh-keygen -lf -   # fingerprint p/ comparar
   # porta ≠ 22: ssh-keyscan -p PORTA -t ed25519 IP.DO.VPS
   ```

3. Cadastre a linha inteira (`IP.DO.VPS ssh-ed25519 AAAA…`) como secret:

   ```powershell
   ssh-keyscan -t ed25519 IP.DO.VPS | gh secret set HOMOLOG_SSH_KNOWN_HOSTS --env homolog
   ```

Com o secret presente, o workflow **não** roda `ssh-keyscan` — qualquer troca da host key
(reinstalação do VPS… ou MITM) derruba o deploy com `Host key verification failed`.
Se o VPS for legitimamente reinstalado, refaça os passos 1–3.

---

## 3. Criar o environment `homolog`

**Settings → Environments → New environment** → nome `homolog`.

- **Required reviewers** (opcional, recomendado quando houver mais de uma pessoa): o run
  **pausa** entre o build verde e o deploy até alguém aprovar. Com uma pessoa só, o
  `workflow_dispatch` já é o humano no loop — dá para começar sem reviewers e ligar depois.
- Os secrets do §2.4 são cadastrados **dentro** deste environment.
- (Opcional) preencher a **URL** do environment e descomentar o `url:` no workflow — o link
  aparece direto na página do run.

---

## 4. Pré-requisitos no VPS (o CD não faz bootstrap)

O workflow **atualiza** uma instalação existente e falha cedo (pré-checagens) se faltar:

- [ ] `/var/www/visao-patio` existe (setup inicial: `docs/deploy-digitalocean.md`);
- [ ] unit systemd `visao-hub` instalada (o `.service` real com os segredos vive **só no
      servidor** — é gitignored, e o CD **não** o toca);
- [ ] nginx com o server block do visão (serve `dist/`, proxy `/socket.io/` e `/go2rtc/`);
- [ ] Node 20+ e `curl` no VPS; internet de saída no 1º boot do motor (modelo ONNX ~40 MB)
      ou `ANALYSIS_MODEL_PATH` apontando para um `.onnx` subido manualmente.

---

## 5. Disparar um deploy

**Actions → Deploy Homolog → Run workflow → branch `main` → Run workflow.**

O que acontece, na ordem:

1. **build** (runner): `npm ci` → **`npm run verify`** (lint+typecheck+build+test+audit — o
   gate determinístico; vermelho = para aqui) → baixa o **go2rtc Linux** (sha256 verificado)
   → empacota **só o que sobe** (`dist/ server/ bin/go2rtc package.json package-lock.json
   scripts/`) → **audita o tar** (se qualquer estado/segredo de runtime aparecer, falha).
2. **aprovação** (se reviewers configurados no environment).
3. **deploy** (SSH no VPS): backup **aditivo** `.bak-<stamp>` (`cp -a`; sem poda
   automática) → posiciona por **cópia aditiva, preservando o estado de runtime**
   (`cameras.json`, `alarms.json`, `camcfg.json`, `data-hist.json`, `users.json`,
   `wa-auth/`, `server/models/` — nada disso vem no pacote nem é apagado) →
   `npm install --omit=dev` (nativas Linux) → `chmod +x bin/go2rtc` →
   `chown -R visao:visao` → `systemctl restart visao-hub` → **health-check**.

> **VPS compartilhada — menor raio de explosão.** O script remoto tem contrato explícito
> (comentado no topo do próprio script, auditável no log de cada run):
> **(a)** nenhum `rm -rf` fora do staging próprio com caminho hardcoded
> (`/tmp/visao-deploy-staging`) — jamais sobre `/var/www/visao-patio` ou com wildcard;
> **(b)** backup `cp -a` e cópia nova por `cp` **sem** `--delete` (aditiva);
> **(c)** `systemctl` só toca o unit `visao-hub` — nginx e os demais serviços da VPS
> **nunca** são tocados; **(d)** `chown`/`chmod` só em `/var/www/visao-patio` e
> subcaminhos explícitos; **(e)** `set -euo pipefail` + echo de cada passo; rollback é
> **instrução textual** no log, nunca executado automaticamente.

**O que o health-check valida** (com retry, até ~2 min):

- **HTTP:** `curl http://127.0.0.1:8091/socket.io/?EIO=4&transport=polling` responde no
  loopback do VPS (hub de pé; não exige auth);
- **Log:** `journalctl -u visao-hub` contém `ouvindo em` (boot ok) ou `motor ATIVO`
  (motor de análise no ar).

**Se falhar:** o run fica vermelho e o log imprime as instruções de rollback com o caminho
exato do backup. **Não há rollback automático** — reverter é decisão humana (§6).

Validação humana pós-deploy (runbook §8): abrir a URL pública, rodapé "conectado",
Relatório acumulando sem espectador, câmera com "análise: hub", CPU dentro do orçamento.

---

## 6. Rollback (manual, deliberado)

É o §9 do `docs/deploy-atualizacao-2026-07.md`. O log do run que falhou imprime o
`<stamp>` exato do backup:

```bash
sudo systemctl stop visao-hub
sudo rm -rf /var/www/visao-patio
sudo mv /var/www/visao-patio.bak-<stamp> /var/www/visao-patio
sudo systemctl start visao-hub
```

Rollback "leve" (só desligar o motor de análise, manter o resto):
`Environment=ANALYSIS_ENABLED=0` no systemd + `daemon-reload` + `restart`.

> **Limpeza de backups é manual** (o CD nunca apaga nada fora do próprio staging — VPS
> compartilhada). Cada `.bak-<stamp>` carrega `node_modules` (pesado). Periodicamente,
> **você** (humano, conferindo o nome exato) remove os antigos:
> `ls -dt /var/www/visao-patio.bak-*` → `sudo rm -rf /var/www/visao-patio.bak-<antigo>`.

---

## 7. O que o CI roda (contexto, sem duplicar)

O `ci.yml` roda em **todo push/PR**: `npm ci` + `npm run verify` (lint + typecheck + build
+ test + audit) — reforço na nuvem do pre-push hook local. A frente de CI está em evolução
(e2e Playwright, `npm run eval` etc.); **a fonte da verdade é o próprio
`.github/workflows/ci.yml`**, não este doc. O CD re-roda o `verify` no job de build de
propósito: é o gate imediatamente antes da ação irreversível, não uma duplicação do CI.

---

## 8. Roadmap / hardening

- **Environment `producao`:** quando a prod existir, clonar o job `deploy` com secrets
  `PROD_SSH_*`, `environment: producao` e **required reviewers obrigatórios** (coleira mais
  curta em produção — CLAUDE.md §8). O job `build` é reaproveitado como está.
- **Pinar actions por SHA** (hoje: major estável `@v4`, igual ao `ci.yml` — só actions
  oficiais `actions/*`; o deploy usa OpenSSH puro, sem action de terceiro tocando a chave).
- **Pinar `known_hosts`** — já suportado: secret opcional `HOMOLOG_SSH_KNOWN_HOSTS` (§2.5).
  Cadastre-o assim que possível; sem ele o workflow cai no `ssh-keyscan` (TOFU).
- **Rotação periódica** da deploy key (gerar novo par → trocar secret → remover a antiga
  do `authorized_keys`).

---

## 9. Riscos conhecidos da primeira execução

| Risco | Sintoma | Mitigação |
|---|---|---|
| VPS sem o setup inicial | pré-checagem falha: `"/var/www/visao-patio não existe"` / `"unit visao-hub não instalada"` | Rodar `docs/deploy-digitalocean.md` uma vez, manualmente. |
| `sudo` pedindo senha | `sudo: a password is required` | Instalar/ajustar o sudoers **restrito** (§2.3) — comando fora da lista = falha alta, nunca silenciosa. |
| Push do workflow recusado | `refusing to allow an OAuth App to create or update workflow` | Token com escopo `workflow` (§1.2). |
| `npm install` compilando nativas sem toolchain | erro de build de `sharp`/`onnxruntime-node` no VPS | `sudo apt install -y build-essential python3` (raro em x86_64 — prebuilds cobrem). |
| 1º boot sem internet de saída | motor cai para N ou desliga; health ainda passa (`ouvindo em` basta) | Subir o `.onnx` manualmente + `ANALYSIS_MODEL_PATH` (runbook §6B). |
| Disco da VPS compartilhada | backups `.bak-*` acumulam (cada um com `node_modules`, ~centenas de MB) | Sem poda automática (deliberado — VPS compartilhada): remover antigos manualmente (§6); conferir `df -h` antes do primeiro run. |
| Staging `/tmp/visao-deploy-staging` ocupado por outro usuário | `mkdir` falha (`File exists`/`Permission denied`) | Caminho fixo e exclusivo do deploy; se colidir, investigar quem criou (VPS compartilhada) antes de remover. |
| `npm audit` do `verify` vermelho no dia do deploy | build falha por vuln transitiva nova (gate honesto, mas acopla ao registry) | Corrigir/ajustar a dep; em urgência real, deploy manual pelo runbook (decisão humana). |
| Host key desconhecida/trocada | `ssh-keyscan` vazio ou `Host key verification failed` | Conferir host/porta; com known_hosts pinado (§2.5), refazer a coleta da fingerprint se o VPS foi legitimamente reinstalado. |

**Residuais assumidos** (declarados, sem plano de remoção imediato — honestidade técnica):

- **`sudo npm install` roda os install-scripts das deps como root.** `sharp` e
  `onnxruntime-node` **exigem** scripts de instalação (baixam/ligam binários nativos) —
  `--ignore-scripts` os quebraria. Mitigantes: `package-lock.json` versionado (o servidor
  instala exatamente o que o `verify` validou no runner), registry oficial, e o gate do
  `npm audit` dentro do `verify`. Tradeoff aceito conscientemente.
- **Backups `.bak-*` acumulam `node_modules`** (~centenas de MB cada). Deliberadamente o
  CD **não** poda nada (VPS compartilhada — nenhum `rm` de escopo amplo); a limpeza é
  manual (§6). Sem disciplina, o disco enche.
- **Sem `HOMOLOG_SSH_KNOWN_HOSTS`, o primeiro contato é TOFU** (§2.5). Cadastre o secret
  para eliminar essa janela.
- **Wildcards do sudoers restrito não são sandbox perfeito** (§2.3) — reduzem raio de
  explosão; o perímetro real é a chave dedicada + environment com aprovação.
