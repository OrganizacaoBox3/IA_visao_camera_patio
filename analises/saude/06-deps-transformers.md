# Saúde — Supply-chain: as 4 vulns transitivas de `@xenova/transformers`

> Avaliação (não-aplicação) do caminho para resolver as **4 vulnerabilidades transitivas** restantes.
> Engenheiro de dependências/segurança. **Não altera `package.json`/lock nem código.**
> Data: 2026-06-29. Lente: `CLAUDE.md` §6–§8 (autonomy slider — não quebrar prod) · `01-verificacao-sensores.md` item 1.12.
>
> Convenção: **(E)** = evidência verificada por execução · **(I)** = inferência · **⚠️** = a confirmar.
> Comandos read-only executados: `npm audit`, `npm ls`, `npm view`; leitura de `owlvitWorker.ts`, `detector.ts`, `config.ts`, `vite.config.ts`. WebSearch (blog v3 transformers.js, advisories).

---

## 0. Veredito

As **4 vulns (3 high + 1 critical) têm UMA única origem**: `protobufjs@6.11.6`, puxado **só** pela cadeia
`@xenova/transformers@2.17.2 → onnxruntime-web@1.14.0 → onnx-proto@4.0.4 → protobufjs@6.11.6`. **(E)**
**`ws` e o `protobufjs` do baileys NÃO estão vulneráveis** na árvore atual (ver §1) — o contexto que sugeria "possivelmente `ws`" **não se confirma hoje**. **(E)**

**Risco REAL no nosso uso é BAIXO** (browser, worker sandbox, modelo de fonte fixa, sem servidor, sem PII) — apesar do rótulo "critical" do CVSS. O **fix correto é remover a cadeia na raiz** migrando para o sucessor mantido **`@huggingface/transformers`** (cujo `onnxruntime-web` ≥1.19 **abandonou `onnx-proto`** e usa `protobufjs@^7`, não vulnerável). A migração é **API-compatível** (≈1 linha em `owlvitWorker.ts`).

> ⛔ **NÃO rodar `npm audit fix --force`.** Ele instala **`@xenova/transformers@2.0.1`** — um **DOWNGRADE** de 2.17.2 (não um upgrade), quase certamente quebra o modo Objetos e nem sequer resolve a cadeia na direção certa. **(E)** saída do `npm audit`.

---

## 1. Árvore de dependência e origem de cada vuln

`npm ls @xenova/transformers onnxruntime-web protobufjs ws` **(E)**:

```
visao_patio_mvp@0.0.0
├─┬ @whiskeysockets/baileys@6.7.23
│ ├─┬ libsignal@6.0.0
│ │ └── protobufjs@7.6.4         ← NÃO vulnerável (fix é <=7.6.2)
│ ├── protobufjs@7.6.4           ← NÃO vulnerável
│ └── ws@8.21.0                  ← NÃO vulnerável (DoS corrigido em 8.17.1)
├─┬ @xenova/transformers@2.17.2
│ └─┬ onnxruntime-web@1.14.0     ← pin EXATO de 1.14.0
│   └─┬ onnx-proto@4.0.4
│     └── protobufjs@6.11.6      ← *** ÚNICA ORIGEM DAS 4 VULNS ***
├─┬ socket.io-client@4.8.3 → engine.io-client@6.6.6 → ws@8.21.0 (deduped, OK)
└─┬ socket.io@4.8.3 → engine.io@6.6.9 / socket.io-adapter → ws@8.21.0 (deduped, OK)
```

`npm audit` colapsa **um nó** (`node_modules/protobufjs` = 6.11.6) em **"4 vulnerabilities (3 high, 1 critical)"** **(E)**. As advisories agrupadas em `protobufjs <=7.6.2`:

| Sev | Advisory | Natureza | Gatilho de exploração |
|-----|----------|----------|------------------------|
| **Critical** | GHSA-xq3m-2v4x-88gg | Arbitrary code execution (code injection via `bytes` field defaults no `toObject` gerado) | Schema/`.proto` **controlado pelo atacante** |
| High | GHSA-fx83-v9x8-x52w | Prototype injection nos construtores de mensagem | Mensagem protobuf maliciosa decodificada |
| High | GHSA-2pr8-phx7-x9h3 | DoS via field names criados | Schema malicioso |
| High | GHSA-685m-2w69-288q / jvwf-75h9-cwgg | DoS por recursão/option paths não-limitados | Descritor/mensagem maliciosa |

**O que usa esse `protobufjs`:** `onnx-proto` o usa para **decodificar o arquivo de modelo `.onnx`** (formato protobuf) quando o `onnxruntime-web@1.14` carrega o modelo. O **schema (`onnx.proto`) é fixo e compilado** dentro do `onnx-proto`; o único insumo variável é **o binário do modelo**.

**Confirmação da raiz** (`npm view`, **(E)**):
- `onnxruntime-web@1.14.0` → depende de `onnx-proto@^4.0.4` (→ protobufjs 6). **(E)**
- `onnxruntime-web@1.19.2` → **largou `onnx-proto`**; passa a depender direto de `protobufjs@^7.2.4` (resolve para 7.6.4 = **seguro**). **(E)**
- `onnxruntime-web@1.27.0` (latest) → idem, `protobufjs@^7.2.4`. **(E)**
- `@xenova/transformers` latest = **2.17.2** (fim da linha; pin `onnxruntime-web@1.14.0`). **(E)**
- `@huggingface/transformers` (sucessor): `3.7.6` → `onnxruntime-web@1.22.0-dev`; `4.2.0` (latest) → `onnxruntime-web@1.26.0-dev`. Ambos `protobufjs@^7` = **sem onnx-proto/protobufjs 6**. **(E)**

---

## 2. Avaliação de risco real no contexto (E×I)

Como o componente é usado (`src/objects/owlvitWorker.ts`, `detector.ts`, `config.ts`):

- **Roda 100% no navegador, dentro de um Web Worker** (`new Worker(... owlvitWorker.ts ..., { type: "module" })`). **Não há `protobufjs` no servidor por esta via** — o hub Node não importa `@xenova/transformers`. **(E)** (`detector.ts:36`, grep do servidor)
- **Modelo de fonte FIXA e confiável:** `model: "Xenova/owlvit-base-patch32"` com `env.allowLocalModels = false` → baixado **só do CDN da HuggingFace** sobre HTTPS, depois cacheado pelo browser. **(E)** (`config.ts:137`, `owlvitWorker.ts:8`)
- **CSP restringe a origem:** `connect-src` só permite `huggingface.co`/`*.hf.co`/`*.huggingface.co` (+ cdn.jsdelivr, googleapis). MITM/exfil por outra origem é barrado. **(E)** (`vite.config.ts:9`)
- **Sem PII / LGPD:** os frames não são persistidos (invariante `CLAUDE.md:27`); o worker recebe pixels efêmeros e devolve `[{label,score,box}]`. Comprometer este worker não dá acesso a frame persistido nem a credencial de servidor. **(I)**

**Exploitabilidade (E):** as advisories de RCE/prototype-pollution do `protobufjs` exigem **schema/`.proto` ou mensagem controlados pelo atacante**. Aqui o schema é fixo (onnx.proto compilado) e a única entrada variável é **o binário do modelo**, servido de um repositório fixo da HF sobre HTTPS. Para explorar seria preciso **substituir o modelo `Xenova/owlvit-base-patch32` por um malicioso na HF** (ou MITM dentro do CSP). **→ Exploitabilidade BAIXA.** **(I)**

**Impacto (I):** mesmo no pior caso, a execução ocorre **dentro do worker sandbox same-origin no browser do operador**, sem acesso a filesystem/processo (não é Node), sem PII persistida, sem o servidor/SIAG. Pior cenário realista = **crash/DoS do modo Objetos no cliente** (o `detector.ts` já tem fallback: em `error`/`onerror` zera o worker e mantém coco-ssd como andaime). **→ Impacto BAIXO-MÉDIO**, contido ao cliente. **(E)** (`detector.ts:44-47,56-62`)

**Veredito E×I = BAIXO.** O rótulo "critical" do CVSS reflete o pior caso genérico (parsing de protobuf não-confiável em servidor), **não** o nosso padrão de uso (browser + fonte fixa + sandbox). Pelo **autonomy slider (§8)**: isto **não** é produção-servidor/SIAG/LGPD-crítico → coleira **média**, não a mais curta. Ainda assim, qualquer fix deve passar pelo **gate determinístico (e2e verde) antes de tocar `main`** (§8).

---

## 3. Opções

### Opção A — Migrar para `@huggingface/transformers` (o fix de raiz) ✅ recomendada

Trocar a dependência de `@xenova/transformers@2.17.2` por `@huggingface/transformers` (sugestão conservadora: **fixar uma `3.7.x`** — mais próxima do comportamento da v2; alternativa: latest `4.x`). Remove **toda** a cadeia `onnx-proto → protobufjs@6` (o `onnxruntime-web` ≥1.19 usa `protobufjs@^7`, seguro). **(E)**

**Mudança em código — MÍNIMA.** A API é retrocompatível: `pipeline`, `RawImage`, `env` existem e se usam igual; só muda a **string de import**. **(E webblog v3 + (E) leitura do worker)**
- `owlvitWorker.ts:5` — `from "@xenova/transformers"` → `from "@huggingface/transformers"`. **Nenhuma outra linha do worker muda** (`env.allowLocalModels`, `pipeline("zero-shot-object-detection", model)`, `RawImage(...).rgb()`, `detector(raw, labels, {threshold, topk})` permanecem). **(E)** (`owlvitWorker.ts:8,29,43,44`)
- `detector.ts` **não muda** (fala com o worker por mensagem, não importa a lib). **(E)**
- `config.ts:137` — `model: "Xenova/owlvit-base-patch32"` **continua válido** (modelos legados `Xenova/*` seguem no Hub e carregam na v3/v4). **(E webblog/issue #1291)**

| | |
|---|---|
| **Prós** | Remove as 4 vulns **na raiz** (não suprime); biblioteca **mantida** (sucessor oficial); API-compatível (≈1 linha); `npm audit` fica **verde** nesta cadeia; destrava o item 1.12 e o futuro `verify`+audit. |
| **Contras / ⚠️** | v3/v4 acrescentam `sharp` + `onnxruntime-node` como deps **(E)** — nativas, **Node-only**; o build Vite do worker precisa **tree-shakear/externalizar** o caminho Node (transformers.js já faz detecção de ambiente via `exports` condicionais; ⚠️ **confirmar** que `vite build` do `owlvitWorker` ignora `onnxruntime-node`/`sharp` e que o bundle não regride — hoje `vite.config.ts` não tem externalização e a v2 funciona). ⚠️ confirmar carregamento do modelo OWL-ViT em runtime (cache do browser muda de chave → 1º download de novo). v4 é mais pesada (onnxruntime-web 1.26-dev); preferir 3.7.x. |
| **Esforço** | **Baixo-médio** (1 linha de código + bump de dep + 1 rodada de validação). |
| **Risco de quebrar Objetos** | **Baixo-médio** — API igual, mas exige validar (a) `vite build` limpo, (b) worker inicializa e emite `ready`, (c) detecção real com OWL-ViT, (d) tamanho do bundle. |

### Opção B — `overrides` de npm (manter `@xenova`, forçar versão segura)

- **B1 — override `onnxruntime-web` para `^1.19`/`1.22`** sob `@xenova/transformers`. Remove `onnx-proto` (1.19+ não usa) → protobufjs `^7` seguro, **sem tocar código**.
  - **Contra/⚠️:** `@xenova@2.17.2` foi escrito contra a **API do ORT-web 1.14**; forçar 1.19–1.22 pode quebrar criação de sessão / caminho dos assets `.wasm` (a API JS e o carregamento de wasm do onnxruntime mudaram entre 1.14→1.19). Combinação **não suportada/não testada** → risco de quebra silenciosa do Objetos. ⚠️
- **B2 — override `protobufjs` para `^7`** (onnx-proto passa a usar 7).
  - **Contra/⚠️:** `onnx-proto@4.0.4` tem código **gerado contra a API do protobufjs 6**; 6→7 tem mudanças incompatíveis (reader/`long`) → provável quebra do parse do modelo. ⚠️ **provavelmente incompatível.**

| | |
|---|---|
| **Prós** | Sem mudança de código-fonte; reversível (só `overrides` no `package.json`). |
| **Contras** | Combinações **não testadas pelo upstream**; mantém biblioteca em fim de linha; alto ônus de verificação; pode quebrar Objetos sem erro claro. |
| **Esforço** | Baixo (config) / **alto** em verificação. |
| **Risco de quebrar Objetos** | **Médio-alto** (B1) / **alto** (B2). |

### Opção C — Aceitar com mitigação (risco residual documentado)

Não mudar nada agora; **registrar risco-aceito** (ADR em `analises/decisoes/`) apoiado na §2: browser + worker sandbox + modelo de fonte fixa HTTPS + CSP restritivo + sem PII/servidor. Mitigações já presentes (CSP `connect-src` à HF; `allowLocalModels=false`; fallback coco-ssd no `detector.ts`).

| | |
|---|---|
| **Prós** | Zero risco de quebrar Objetos; esforço mínimo; honesto quanto ao risco real BAIXO. |
| **Contras** | `npm audit` **permanece vermelho** (4 vulns, 1 critical) → falha um `verify` que inclua `audit --audit-level=high`; item 1.12 segue 🔴; dívida adiada, não paga. |
| **Esforço** | Mínimo (1 ADR). |
| **Risco de quebrar Objetos** | **Nenhum.** |

---

## 4. Recomendação priorizada

1. **Fazer a Opção A** (migrar para `@huggingface/transformers`, fixar **`~3.7.x`**) em **branch isolada**, validando antes do merge (gate §8 — e2e verde):
   - `vite build` limpo (worker sem tentar bundlar `onnxruntime-node`/`sharp`; checar tamanho do `owlvitWorker` chunk vs. baseline 807 kB do item 1.6). ⚠️
   - Worker emite `ready`; detecção OWL-ViT real funciona no modo Objetos; 1º download do modelo OK sob o CSP atual.
   - É o **fix de raiz** (zera a cadeia vulnerável), com custo de código ≈1 linha, e alinha com "fix real > supressão".
2. **Se A travar** por atrito de bundle/deps nativas: cair para **B1** (override `onnxruntime-web ^1.22`) **apenas** com validação completa do Objetos; tratar como experimental e documentar. **Não** usar B2 (provável incompatível).
3. **Enquanto A não entra:** a postura da **Opção C é aceitável como interino**, dado o risco real BAIXO (§2) — registrar ADR de risco-aceito. **Não** rodar `npm audit fix --force` (downgrade quebrável; ver §0).
4. **Higiene de escopo:** `ws` e o `protobufjs@7.6.4` do baileys **não** entram nesta correção — já estão em versões corrigidas. **(E)**

---

## 5. Notas de confiança

- Árvore, severidades, pins de versão e o downgrade do `--force` foram **verificados por execução** (`npm audit`, `npm ls`, `npm view`) nesta máquina. **(E)**
- Compatibilidade de API v2→v3 (mesma assinatura de `pipeline`/`RawImage`/`env`) vem do blog oficial v3 + leitura do worker; ⚠️ **a confirmar** em runtime: bundle Vite ignorando `onnxruntime-node`/`sharp`, e carregamento do modelo `Xenova/owlvit-base-patch32` na v3.
- A classificação E×I = BAIXO é **inferência** fundamentada no padrão de uso (browser/worker/fonte fixa/sem servidor), não medição de exploit; o rótulo "critical" do CVSS é fato do `npm audit`. **(E/I)**

Fontes: [Transformers.js v3 (blog HF)](https://huggingface.co/blog/transformersjs-v3) · [issue #1291 @xenova vs @huggingface](https://github.com/huggingface/transformers.js/issues/1291) · [GHSA-xq3m-2v4x-88gg (protobufjs RCE)](https://github.com/advisories/GHSA-xq3m-2v4x-88gg) · [@xenova/transformers (npm)](https://www.npmjs.com/package/@xenova/transformers)
