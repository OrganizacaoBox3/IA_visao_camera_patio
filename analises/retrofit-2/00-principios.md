# Retrofit 2 — "Separar para conquistar" · Princípios-fonte

> **Propósito:** fonte única de direção do retrofit 2. Cada domínio/arquivo/camada responsável
> SÓ pela sua funcionalidade, comentário enxuto (só o porquê/invariante), para sabermos
> **exatamente onde atacar performance/precisão em cada ponto**. A função-núcleo da plataforma
> é o **motor de reconhecimento de pessoas com alta precisão** (D-FINE no hub) — a separação
> existe a serviço dele: um botão de perf/precisão por arquivo, um sensor por botão.
>
> **Como usar:** toda frente do retrofit 2 lê este documento antes de tocar código. Em conflito
> entre este documento e o código, este documento decide (ou é corrigido explicitamente —
> mesmo regime do `CLAUDE.md`). Nada aqui inventa princípio novo: consolida `CLAUDE.md`,
> `../agentes/MANIFESTO_DESENVOLVIMENTO.md`, `../agentes/PRATICAS_ENGENHARIA.md`, os ADRs de
> `analises/decisoes/` e o parecer `analises/auditoria-qualidade-codigo.md` (rubrica de 12
> pontos + retrofit 1 executado).

---

## A. Princípios da casa que regem a reescrita (com fonte)

| # | Princípio | O que significa NESTE retrofit | Fonte |
|---|---|---|---|
| P1 | **Uma responsabilidade por unidade.** Se precisa de "e" para descrever, são duas. | Teste do "e" aplicado a arquivo, função e commit. `engine.js` que "amostra E rastreia E conta E agrega E emite E ingere" é o alvo clássico. | CLAUDE.md §2.2 · Manifesto §1.2 |
| P2 | **Organizar por domínio, não por tipo.** Tudo de uma feature perto. | A árvore deve "gritar" o que o sistema faz (detecção, contagem, alarme, relatório) — não a tecnologia. `server/alarm/` e `src/camera/` já são o modelo. | CLAUDE.md §2.3 · Screaming Architecture (Martin, ref. externa §F) |
| P3 | **Simplicidade primeiro (YAGNI/KISS).** Abstração só no 3º caso. | Extração de seam sem 2º consumidor real ou eixo mensurável = overengineering. Ver política de fronteira (§C). | CLAUDE.md §2.1 · Manifesto §1.1/§5 |
| P4 | **Contratos estáveis e ADITIVOS entre camadas.** | Refactor interno livre; contrato (socket, HTTP, IPC, ingest, props) só cresce, nunca quebra. Mudança de contrato sem teste é a regressão silenciosa nº 1. | CLAUDE.md §2.4/§3 · Manifesto §1.5 |
| P5 | **Honestidade técnica.** Sem evidência, não há "pronto". | Before/after de perf/precisão só vale medido pelos sensores de §E. "Gate-verde ≠ seguro" (lição do `perf-input-size-dfine.md`: fixture passou, full-set reprovou). | CLAUDE.md §2.5 · Manifesto §1.7 |
| P6 | **Entregas pequenas e reversíveis; comportamento byte-a-byte.** | O retrofit 1 provou o padrão: extração preserva saída idêntica + testes verdes; um commit por intenção. | CLAUDE.md §2.6 · auditoria (Status EXECUTADO) |
| P7 | **Sem DRY dogmático.** Duplicação consciente e barata > abstração errada e cara. | O par `iouXYWH`×`iouOf` (front×hub) foi deliberadamente deferido — dedup só com frente própria que preserve os 2 conjuntos de testes de paridade. | Manifesto §5 · auditoria (resíduos) |
| P8 | **Verificação é o gargalo — é onde se investe.** | `npm run verify` (lint+typecheck+build+312 testes) + e2e 8/8 + `npm run eval` (gate de precisão) são o piso de TODA onda. Lógica pura extraída nasce com Vitest ao lado. | CLAUDE.md §6 · Manifesto §3/§4 |
| P9 | **Paralelizar execução por propriedade exclusiva de arquivo; serializar revisão.** | Um dono por arquivo por onda; contratos entre frentes explícitos ANTES; lógica compartilhada extraída para arquivo NOVO (permite paralelismo sem colisão). Estado combinado validado ao fim da onda. | ADR-001 · CLAUDE.md §5 |
| P10 | **Filtro Signal×Noise.** | Se a mudança não aumenta capacidade real de atacar perf/precisão, não reduz carga cognitiva e não move KPI — é ruído; não entra na onda. | CLAUDE.md §5 · Manifesto §5 |

**Princípio-síntese do retrofit 2** (derivado, não novo): *cada eixo de ataque a
performance/precisão deve ter UM arquivo dono e UM sensor que mede o efeito.* É a leitura
operacional de P1+P2+P5 para a função-núcleo. O mapa eixo→dono→sensor está em §E.2.

---

## B. Política de COMENTÁRIO — o que fica, o que sai

A auditoria deu nota 9–10 em "comentário-porquê" — é identidade do código e **não se perde**.
O resíduo é o smell **S3**: densidade e narrativa histórica. Regra de Ousterhout (ref. §F):
comentário descreve **o que não é óbvio no código** — a abstração do módulo, o racional, a
regra, a condição de borda. Nunca o que o código já diz, nunca o que o git já guarda.

### Fica (o PORQUÊ e a invariante)

1. **Cabeçalho de módulo = contrato/abstração** (o que o módulo garante, o que NÃO faz):
   > `src/vision/nms.ts:1-17` — explica as DUAS regras de supressão e por que contenção pega
   > o que IoU não pega. Sem isso, o leitor não entende o módulo sem ler a implementação.
2. **Trade-off declarado com número**:
   > `nms.ts:12-16` — "`containThr = 0.7`, conservador: baixar mataria recall de pares
   > próximos; subir deixaria passar a duplicata parcial. 0.7 é o meio." É o padrão-ouro:
   > qualquer futuro ataque de precisão sabe o custo de mexer no número.
3. **Marcador de invariante** (LGPD/ADR/contrato) no ponto exato onde ela poderia ser violada:
   > "frames efêmeros em memória — nada persiste (ADR-002)" em cada ponto de aquisição.
4. **Dependência de contrato entre camadas/frentes** (o que quebra se o vizinho mudar):
   > `server/analysis/README.md` §Longo alcance — "o store `camcfg.js` precisa PRESERVAR
   > `longRange` em `cleanCamConfig`; sem isso o motor fica no squash."
5. **Porquê curto de decisão local não-óbvia**:
   > `server/analysis/engine.js:211` — "PÉ cai aqui é descartada antes de
   > tracking/contagem/ingest (mata FP de objeto fixo)." Uma linha, todo o racional.

### Sai (a HISTÓRIA e o óbvio)

1. **Narrativa histórica / changelog no código** — pertence ao git, ao ADR ou ao
   `implementacao-changelog.md`; apodrece contra o código reescrito:
   > `src/CameraWorkspace.tsx:757-759` — "…Antes valia a PRIMEIRA zona da lista … (bug
   > confirmado em runtime — diagnóstico jul/2026)…" → fica só a REGRA atual (desempate por
   > maior interseção, depois menor área); o "antes" e a datação saem.
   > `src/CameraWorkspace.tsx:963,1031` — "BUGFIX: … eram gated por `ativ.length` …" → o
   > comentário certo é a invariante ("detecção roda mesmo sem zona de atividade — linhas
   > bastam"), não a autópsia do bug.
   > `src/config.ts:276` — "(Zonas-semente automáticas removidas em jul/2026 …)" → código
   > removido não precisa de lápide; git guarda.
   > `server/analysis/automask.js:39` — "antes ANALYSIS_AUTOMASK_COLS/ROWS/…" → o nome das
   > envs mortas sai; fica só "grid/janela fixos: defaults calibrados, sem env (YAGNI)".
2. **Bloco de 8–18 linhas por constante** → destilar para 1–3 linhas de porquê + número.
   Se a explicação longa é medição, ela mora em `analises/` e o comentário aponta o arquivo.
3. **Comentário que parafraseia o código** ("incrementa o contador") → renomear e apagar.
4. **Datações e créditos** ("jul/2026", nomes de onda/commit) → git blame resolve.

**Teste rápido:** *se o código fosse reescrito corretamente do zero, este comentário
sobreviveria?* Sobrevive = é contrato/porquê (fica). Não sobrevive = é história (git/ADR).

**Exceção honesta:** referência a análise/ADR (`analises/perf-input-size-dfine.md`,
`ADR-002`) FICA — é ponteiro para evidência, não narrativa. Padrão: `// <regra atual>
(<porquê em ≤2 linhas>; evidência: <arquivo>)`.

---

## C. Política de FRONTEIRA de módulo — quando um seam paga

Base: módulo fundo (interface simples, implementação potente — Ousterhout) + bounded context
(dentro da fronteira, vocabulário consistente; **coisas que mudam juntas moram juntas** —
Evans/Fowler, ref. §F) + os critérios já provados pelo retrofit 1.

**Um seam PAGA se satisfizer ao menos UM destes (e nenhum dos vetos):**

1. **Isola um eixo de ataque de perf/precisão** — depois do corte, mexer naquele eixo toca UM
   arquivo e é medido por UM sensor (ex.: input-size vive só em `worker.js`; cadência vive só
   em `engine.js`+`motion.js`). É o critério-rei deste retrofit.
2. **Liberta lógica pura para teste sem runtime pesado** (sem tfjs/ORT/DOM/socket) — o
   precedente `nms.ts`/`bytetrack.ts`/`counting.ts`: cada trade-off vira teste com o cenário
   de campo que motivou o número.
3. **Estabiliza um contrato cruzado por 2+ donos/frentes paralelas** (ADR-001) — o arquivo
   novo é o ponto de encontro; os donos param de colidir.
4. **Remove um "e" de god-module** — a responsabilidade extraída tem nome próprio de domínio
   (não `utils`, não `helpers`) e o módulo-mãe encolhe de verdade.

**Vetos (o seam NÃO paga se):**

- É especulativo — sem 2º consumidor real nem eixo mensurável hoje (P3; "sem arquitetura
  especulativa", Manifesto §5).
- Cria módulo raso/pass-through: interface do mesmo tamanho da implementação, só indireção.
- Quebra comportamento byte-a-byte sem ser esse o objetivo declarado e medido (P6).
- Cruza um ADR (ex.: mover o rAF para fora da casca fullscreen — ADR-007 proíbe).
- Divide o que muda junto: se toda mudança real abre os dois arquivos, a fronteira está no
  lugar errado (coesão > tamanho; um arquivo de 500 linhas coeso vence dois de 250 acoplados).

**Protocolo de corte (padrão retrofit 1, mantido):** extrair para arquivo novo → porta 1:1 →
teste de paridade quando há par front/hub (precedente `bytetrack`/`counting`) → saída
byte-a-byte → `verify` + e2e verdes → só então otimizar por dentro da fronteira.

---

## D. INVARIANTES intocáveis (violar = reprovar a onda)

1. **LGPD / imagens efêmeras (ADR-002 + ADR-009):** nenhuma imagem/frame persiste no servidor
   — efêmeros em memória no relé E no motor (hub → worker via IPC). Cine-loop = buffer em
   memória; "salvar" = download local manual. Persistem só metadados/indicadores.
2. **Contratos socket ADITIVOS:** `frame`, `cameras`, `set-capture`/`capture`, `alert`,
   `camera-status`, `alarm-event`/`alarm-update`, `camcfg-updated`, `analysis-status`,
   `analysis-tracks` são contrato. Campos/eventos novos sim; quebrar existentes nunca.
3. **Casca fullscreen da câmera NÃO vira Radix Dialog (ADR-007):** Portal/scroll-lock
   remontaria o `<canvas>` e mataria o rAF/editor de zonas. Trap de foco manual permanece.
   O loop rAF não sai do `CameraWorkspace` (sub-passos puros extraídos, sim — `rafSteps.ts`).
4. **Radix é a camada de UI (ADR-003/007/008):** controle interativo = primitiva Radix via
   wrapper de `src/ui/`; estilo só por tokens `--state-*`/`--cam-*`/`--sp-*`. **Going gray:**
   base neutra; cor saturada só para anormalidade.
5. **Política de alarme em ponto único ANTES dos canais (ADR-004):** dedup/flood/prioridade/
   shelve em `server/alarm*`; nenhum canal (Andon/WhatsApp) decide sozinho.
6. **Persistência (ADR-005):** cache em memória + Postgres quando configurado + fallback JSON;
   `schema.sql` idempotente e ADITIVO (não alterar tabelas existentes); queries parametrizadas;
   SIAG é read-only.
7. **Live-sync last-write-wins via `camcfg-updated` (ADR-006):** sem merge incremental; re-fetch
   pulado durante edição local.
8. **Segredos fora do git:** `.env`, `wa-auth/`, `cameras.json`, `alarms.json`, `camcfg.json`,
   `rtsp.sources.json` etc. no `.gitignore`; nada de segredo/PII para IA.
9. **Paralelização por propriedade exclusiva de arquivo (ADR-001):** um dono por arquivo por
   onda; `CameraWorkspace.tsx` é gargalo estrutural → mudanças nele são seriais entre ondas.
10. **Precisão passa pelo gate:** qualquer mudança de modelo/threshold/NMS/input passa por
    `npm run eval` (`eval/gate.mjs`) E, em decisão de default, pelo full-set — o fixture
    pequeno NÃO decide sozinho (`perf-input-size-dfine.md`).

---

## E. Critérios de RETORNO MENSURÁVEL (before/after que valem)

### E.1 Sensores válidos

| Eixo | Sensor (before/after) | Onde |
|---|---|---|
| **Precisão do motor** | recall S/M/L @0.25/@0.35, F1, precisão, FP-em-vazias — fixture (gate) + **full-set** para decisão de default | `eval/gate.mjs`, `eval/run-eval.mjs`, `eval/manifest.json` |
| **Custo de inferência** | core·s/frame e ms/frame por modelo/input (método de `eval/MODELS.md`); câmeras/core @1fps | harness `eval/` (fork do worker real) |
| **Saúde do motor em produção** | `fps`, `queue`, `lastMs`, `dets1m`, `excluded1m` por câmera; `worker.cpuPct`, `respawns`, RSS | `GET /api/analysis/status` |
| **Contagem (fim-a-fim)** | travessias contadas vs reais em janela conhecida; replay determinístico do `counting` | método de `acuracia-modelos.md §3` |
| **Perf do front** | orçamento do rAF (ms/frame por sub-passo), fps de exibição sem regressão | HUD dev / `rafSteps.ts` |
| **Estrutura** | linhas/arquivo dos god-modules; nº de responsabilidades (teste do "e"); % de lógica pura com teste (contagem do `verify`: hoje 312) | `npm run verify`, `wc -l` |
| **Regressão funcional** | `verify` verde + e2e 8/8; paridade front↔hub onde há port 1:1 | CI + pre-push |
| **Comentário** | densidade (linhas de comentário/linhas de código) nos arquivos tocados + zero ocorrências de narrativa histórica (grep `BUGFIX\|jul/2026\|[Aa]ntes valia`) | grep + revisão |

**O que NÃO vale como retorno:** "ficou mais limpo/legível" sem número; gate-verde só no
fixture quando a mudança afeta pessoa pequena/distante (lição medida: 512 passou o gate e
perdeu −8pp de recall pequena no full-set); benchmark em máquina/carga diferente do baseline
sem declarar; "o teste passou" relatado sem execução (Manifesto §3).

**Regra de honestidade:** todo relatório de onda declara risco residual e o que NÃO melhorou.

### E.2 Mapa eixo de ataque → arquivo dono → sensor (o produto da separação)

| Eixo de perf/precisão | Arquivo dono (único lugar a mexer) | Sensor |
|---|---|---|
| Input size / pré-processamento / tiling por tile | `server/analysis/worker.js` (`ANALYSIS_INPUT`, squash/tiles) | eval full-set + ms/frame |
| Escolha de modelo N/S/M, download/sha | `server/analysis/model.js` (+ `ANALYSIS_MODEL`) | `eval/MODELS.md` + gate |
| Cadência/prioridade por câmera (FOCO > LINHA > normal; último-vence) | `server/analysis/engine.js` (orquestração) | `fps`/`queue` por câmera |
| Cadência adaptativa por movimento | `server/analysis/motion.js` | `fps` efetivo × recall de contagem |
| Escala/contenção de CPU do hub | `server/analysis/autoscale.js` | `worker.cpuPct`, `lastMs` |
| Continuidade de track (nascimento 0.35 / sustain 0.25) | `server/analysis/bytetrack.js` | replay + travessias contadas |
| Histerese/TTL de contagem | `server/analysis/counting.js` (lógica provada correta — atacar recall×cadência, não aqui) | replay determinístico |
| Supressão de FP estático (zona de exclusão pé-âncora, auto-máscara) | `server/analysis/zones.js` + `automask.js` | `excluded1m` + FP-em-vazias |
| Ingest/agregação de indicadores | `server/analysis/engine.js` → `server/pgstore.js` | contrato `flow`/`ativ` + testes |
| Custo do relé de frames (fps/size ffmpeg, shed) | `server/rtsp.js` + `server/shed.js` | CPU do hub por câmera |
| Fonte go2rtc (pull, poda) | `server/analysis/go2rtc-source.js` | testes + leak do mapa `pulls` |
| Hot-path de exibição (rAF, draw, cine) | `src/CameraWorkspace.tsx` + `src/camera/rafSteps.ts`/`draw.ts` (frente paralela ativa — não tocar sem posse) | ms/frame do rAF |
| Dedupe de detecções (IoU/contenção) | `src/vision/nms.ts` (front) · espelho no `worker.js` (hub) | testes de paridade |

> Se um ataque de perf/precisão exigir tocar 2+ arquivos fora deste mapa, isso é um **cheiro
> de fronteira errada** — a onda deve primeiro corrigir o seam (com o protocolo de §C), depois
> atacar o eixo.

### E.3 Estado de partida (para o "before" honesto)

- Retrofit 1 **executado** (auditoria §Status): riscos R1–R6 corrigidos; CameraWorkspace
  2833→2080, DashboardPage 1111→454, engine.js 938→582; +87 testes (225→312); dedup `cx`/
  `SectionTitle`; going-gray consolidado; dead-config removida.
- **Re-crescimento pós-features** (flow/motion/focus/autoscale, jul/2026): `engine.js` voltou a
  ~951 linhas e `CameraWorkspace.tsx` a ~2194 — acreção esperada de maratona; é o alvo natural
  das primeiras ondas do retrofit 2 (re-aplicar §C, não re-litigar o retrofit 1).
- Resíduos deferidos conhecidos: `iouXYWH`×`iouOf` (dedup só com frente própria), densidade de
  comentário S3 (esta política resolve), `ReportPage.tsx` ~1017 linhas.
- `server/analysis/` é o **domínio-modelo**: ~10 módulos coesos, cada um com teste ao lado,
  README com mapa de contratos — o resto do código converge para esse padrão.

---

## F. Referências externas (o essencial, sem enciclopédia)

1. **John Ousterhout — *A Philosophy of Software Design*:** comentários descrevem o que não é
   óbvio no código (abstração, racional, borda, unidade); módulos fundos = interface simples,
   implementação potente; a abstração do módulo deve ser compreensível sem ler a implementação.
   Resumo: [pragmaticengineer.com](https://newsletter.pragmaticengineer.com/p/the-philosophy-of-software-design) ·
   [danlebrero.com](https://danlebrero.com/2021/02/24/philosophy-of-software-design-summary/)
2. **Robert Martin — *Screaming Architecture*:** a estrutura do sistema comunica o que ele FAZ
   (casos de uso/domínio), não o framework; organizar por feature/caso de uso, não por camada
   técnica. [blog.cleancoder.com](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html) ·
   [milanjovanovic.tech](https://www.milanjovanovic.tech/blog/screaming-architecture/)
3. **Evans/Fowler — *Bounded Context* (DDD):** fronteira explícita dentro da qual o modelo e o
   vocabulário são consistentes; alta coesão dentro, baixo acoplamento fora; **o que muda junto
   mora junto**. [martinfowler.com/bliki/BoundedContext](https://martinfowler.com/bliki/BoundedContext.html)

> Filtro da casa sobre as referências: adotamos o *critério* (fronteira que paga, comentário
> que sobrevive à reescrita, árvore que grita o domínio) — **não** a cerimônia (nada de camadas
> Clean Architecture completas, DI-framework ou DDD tático integral; P3/P10 vetam).
