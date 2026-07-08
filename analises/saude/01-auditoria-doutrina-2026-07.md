# Auditoria de saúde — `visao_computacional_mvp` pela lente da doutrina `/agentes` (2026-07)

> Auditoria "do zero" (olhar fresco no código atual) pela régua do manifesto + práticas + política de IA
> + os 29 aprendizados. Método: 6 dimensões auditadas em paralelo, **cada achado crítico verificado
> adversarialmente** contra o código (17 agentes). Sucessora de `00-relatorio-saude-e-retrofit.md` (pós
> retrofit-1/2). Evidência `arquivo:linha`; evidência ≠ inferência; a auditoria **preserva as forças**.

## Veredito global

**Base sólida, acima da média — sem nenhum P0.** A app já passou por 2 retrofits e isso se vê: fundamentos
de segurança corretos, verificação forte (o gargalo onde a doutrina manda investir **está** investido), e
invariantes de LGPD/UI de pé. A dívida que sobra **não é podridão estrutural** — é de dois tipos recorrentes:
**(1) fronteira de módulo** (um god-file que reengorda) e **(2) DERIVA DE CLAIM** — comentários/headers/steering
afirmando mais forte do que o código entrega hoje. O segundo é o mais insidioso porque fere a própria
*honestidade técnica* da casa (a régua contra a qual estamos medindo).

| # | Dimensão | Score | Uma linha |
|---|---|---|---|
| 1 | Arquitetura & Simplicidade | 🟡 amarelo | Motor decomposto exemplar; `CameraWorkspace.tsx` reengordou; pins de duplicação derivaram |
| 2 | **Verificação & Sensores** | 🟢 **verde** | 530 testes + `npm audit` limpo + eval de ML no gate — a dimensão mais forte |
| 3 | Segurança, LGPD & Segredos | 🟡 amarelo | Fundamentos corretos; faltam rate-limit no login e guarda de boot p/ defaults |
| 4 | Front & Padrão UI | 🟡 amarelo | `src/ui/` exemplar, going-gray pervasivo; a11y de teclado nos tiles falha |
| 5 | Operação, CI/CD & Perf | 🟡 amarelo | CD maduro/nunca-destrutivo, válvulas exemplares; autoscale ignora memória |
| 6 | Governança & Higiene | 🟡 amarelo | CLAUDE.md enxuto, 100% atribuição de IA; `.env` sem rede no `.gitignore`; CLAUDE §6 derivou |

**A verificação adversarial funcionou:** dos 10 achados marcados P1 pelos auditores, **5 foram rebaixados a
P2** pelos céticos (CameraWorkspace, pin do bytetrack, indicador de foco, autoscale-memória) — confirmados como
reais, mas não da gravidade alegada. Sobraram **5 P1 legítimos**.

## Os 5 P1 confirmados (ordem da doutrina: segurança → sensores → resto)

### Segurança primeiro
1. **Login sem rate-limiting** (`server/routes/auth.js:9-15`). `POST /api/login` chama `authenticate()` direto,
   sem throttle/lockout/atraso — brute-force livre. *Fix:* janela deslizante em memória (ex.: 5 tentativas/5min →
   429), teste do lockout. *(Já era P1 no MAPA_DE_LACUNAS: "auth simplista, sem rate-limiting".)*
2. **Sem guarda de boot contra defaults inseguros** (`server/users.js:17,108`). `AUTH_SECRET = env || "dev-inseguro-
   troque..."` e senha default `admin@box3`. Se deployado sem setar, roda inseguro **em silêncio**. ⚠️ **O homolog
   hoje aceita `admin@box3`** — o default está em uso. *Fix:* abortar no boot (`process.exit(1)`) se `AUTH_SECRET`
   ausente/default **ou** senha ainda no default em produção. É a lição 04.5 (falso-OK) aplicada à segurança.

### Sensores (paridade — lição 02.3)
3. **Sensor de contagem sem paridade de produção** (`eval/counting.mjs:47-57,218-223`). O eval duplica os knobs à mão
   e **OMITE 3 do tracker** (`reassocDist`/`reassocMaxGapMs`/`lostAfterMisses`) — mede um tracker diferente do de
   produção. *Fix:* importar `PRECISION` de `precision.js` (fonte única) e repassar todos os knobs. Fere "harness com
   paridade de produção".

### Arquitetura & Front (honestidade + acessibilidade)
4. **Claim "os testes garantem paridade" é falso** (`server/analysis/counting.js:3`, `zones.js:5`, `bytetrack.js:5`).
   Não existe teste cross-language TS↔JS; os `.test.js` são mono-lado. O header afirma **mais forte** que o próprio
   residual honesto do retrofit. *Fix:* criar harness de paridade (fixtures rodadas nos dois lados) **ou** corrigir o
   texto p/ a verdade. Fere "comentário sobrevive à reescrita" + "sem evidência não há pronto".
5. **Abrir câmera é só-mouse** (`CameraTile.tsx:241`, `CameraWorkspace.tsx:1461`, `FadigaView.tsx:272`). Os tiles são
   `<div onClick>` — sem teclado nem leitor de tela. *Fix:* trocar por `<button>` (o seletor e2e `.tile[title=...]`
   sobrevive). Fere acessibilidade do PADRAO_FRONTEND.

## O tema-raiz (o meta-achado): DERIVA DE CLAIM

Vários achados são a mesma doença: **afirmação escrita que o tempo tornou falsa** — o inverso da honestidade técnica.
- Headers de `bytetrack.js/counting.js/zones.js` dizem "não existe no TS" / "os testes garantem paridade" — ambos
  falsos pós-`f1ad355`; e a **direção de autoridade se contradiz** entre `bytetrack.js:2` e `bytetrack.ts:34`.
- `CLAUDE.md §6` virou snapshot de status (fala em "18 warnings", "4 vulns", "Onda 0" — todos resolvidos) e diz
  `verify = lint+typecheck+build+test` omitindo o `audit` que o `package.json:20` encadeia.
- Metas de tamanho declaradas (`CameraWorkspace ≤1850`, `engine ≤550`) foram cruzadas de volta (1889 / 663) **sem
  sensor que barre** — a meta virou texto, não gate.

Isto é exatamente a lição 06.1 ("comentário só fica se sobreviveria à reescrita correta") e 06.4 ("steering
desatualizado é pior que nenhum") batendo na própria casa. **Barato de corrigir, caro de ignorar** (é o único
guarda-corpo entre dois trackers probabilísticos).

## As forças (a auditoria preserva o que está certo)

- **Verificação (🟢):** 530 testes / 40 arquivos verdes (~8,6s), `npm audit` **0 vulns** (os 4 transitivos do
  CLAUDE.md foram resolvidos na troca `@xenova`→`@huggingface`), e **eval de ML de verdade no CI** (`gate.mjs`: P/R/F1
  + FP-em-vazias sobre fixture COCO estratificada). Contagem também tem eval fim-a-fim.
- **Motor:** `engine.js` virou orquestrador fino delegando a ~15 módulos, **13 com `.test.js`** (dono+sensor por
  eixo); IPC hub↔worker tipado/aditivo/versionado com válvula nunca-cego por-worker.
- **Segurança de base:** SQL 100% parametrizado (sem concatenação), `scrypt`+HMAC+`timingSafeEqual`, e o papel vem
  **do store, não do token** (`users.js:57` — impossível forjar `superadmin` mesmo com segredo vazado). LGPD intacta:
  nenhum frame escrito em disco em todo `server/analysis/*`.
- **UI:** `src/ui/` exemplar (Radix por átomo, tokens, `focus-visible`, alvo WCAG, `IconButton` exige `label`);
  going-gray pervasivo; **ADR-007 de pé** (casca fullscreen não é Radix Dialog).
- **Operação:** CD manual+gateado, cópia aditiva sem `--delete`, `rm -rf` só no staging hardcoded, health por
  `systemctl` (não journal), pré-check de disco, rollback só textual — cada um nasceu de um deploy que falhou.
- **Governança:** CLAUDE.md 92 linhas (<200), **100% dos commits com atribuição de IA**, ADRs indexados.

## Retrofit recomendado (ordem da doutrina: P0-seg → sensores → arquitetura → acabamento)

- **R-A (segurança, primeiro):** rate-limit no login (P1-1) + guarda de boot p/ defaults + **rotacionar a senha do
  homolog** que está no default (P1-2). Lote pequeno, alto valor, viram teste.
- **R-B (sensores/honestidade):** paridade do `eval/counting.mjs` via fonte única (P1-3); corrigir os headers de
  paridade e a direção canônica (P1-4); enxugar `CLAUDE.md §6` (tirar o snapshot de status); ADR-011 do go2rtc/WebRTC.
- **R-C (acessibilidade):** tiles `<div>`→`<button>` (P1-5) + `:focus-visible` nas superfícies de domínio do Relatório.
- **R-D (arquitetura, quando pagar):** extrair `useZoneEditor`/`useCameraPipeline` de `CameraWorkspace.tsx` + **gate de
  tamanho no `verify`** (para a meta virar sensor, não texto); teste de contrato do fallback JSON do `pgstore`.
- **P2 avulsos:** `.env`/`.env.*` no `.gitignore`; `CAMERA_TOKEN` com `timingSafeEqual` (+ token por dispositivo no
  médio prazo, casa com o [ADR-010]); CORS/CSP restritos em produção; autoscale ganhar sinal de memória; artefatos
  estranhos versionados (`visao_computacional_mvp/` aninhado, `document_pdf.pdf`).

> **Nota de honestidade:** este relatório é ele próprio uma recomendação automatizada — logo, **hipótese, não ordem**
> (lição 06.3). Cada item deve ser re-verificado no ato de corrigir. Nenhum P0; a app está saudável — a dívida é de
> upkeep de fronteira e de claim, não de fundação.
