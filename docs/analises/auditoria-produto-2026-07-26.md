# Auditoria ponta a ponta — o que o produto diz ter × o que entrega

> 2026-07-26. Pedido do dono: *"análise aprofundada de todas as funções que o projeto diz ter e do
> que de fato está implementado… o que está funcionando, o que pode ser melhorado, quais informações
> estão ocultas… contagem de caixas, marcador de caixas, tudo isso validado."*
>
> **Procedência:** 5 frentes paralelas de LEITURA DE CÓDIGO com evidência `arquivo:linha`, mais um
> punhado de MEDIÇÕES executadas (marcadas **[M✓]**). Nenhuma medição de campo — não rodamos o
> sistema contra câmera real. Onde é hipótese, está escrito **hipótese**.

---

## 1. O diagnóstico numa frase

> **"Não estou medindo" é renderizado como resultado.**

Não é uma metáfora — é o mesmo defeito em cinco lugares, e sempre na direção perigosa (parece bom
quando está ruim):

| Onde | O que a tela diz | O que está acontecendo |
|---|---|---|
| Câmera | `0 pessoas` | o motor está cego (gate/modelo/engine off) |
| Relatório | `Taxa de leitura 100%` · `Operação saudável` | o período não tem **nenhum** dado |
| Alarmes | `Nenhum alarme silenciado. Os alertas seguem o fluxo normal.` | a chamada de rede **falhou** |
| Objetos | `0 caixas` | o modelo **nunca carregou** |
| Zona proibida | `ARMADA` | a política de turno está **calando** o alarme |

A doutrina da casa nomeia isso: **falso-OK é pior que erro**. E o próprio repositório já sabe fazer
certo — `AlarmHealthStrip` escreve `—` quando não sabe, a Régua do Turno **some** sem carimbo, os
rankings dizem *"Sem ociosidade no período"*. O padrão honesto existe, está escrito, e não foi
aplicado aos KPIs, aos `catch` de rede e aos estados de motor.

**Corrigir esse padrão é o maior retorno por custo de todo o projeto, e quase tudo cabe em "custo
baixo".**

---

## 2. O que está sólido (para não jogar fora o que é bom)

Medido, com teste e sensor:

- **Motor de detecção e tracking no hub.** D-FINE ONNX N/S/M com autoscale, ByteTrack com política
  LOST/estacionário/re-associação, pool de workers com respawn por-worker. **`npm run eval:counting`
  passa** (12 cenários de travessia + suíte estacionária + torneio de TTL) e roda no CI. **[M✓]**
- **Contagem de pessoas por linha e por zona:** correta, 24/7, sem depender de navegador aberto.
- **LGPD/ADR-002 honrado.** Varredura exaustiva: nenhum caminho grava imagem. Zero `createWriteStream`
  no servidor; JPEG só em memória e IPC.
- **Login, RBAC e enforcement.** scrypt + HMAC, 3 papéis, ~30 endpoints protegidos, throttle, testes
  de segurança. O front é **igual ou mais estrito** que o servidor.
- **Alarmes ISA-18.2/EEMUA-191** com anti-flap, anti-flood, shelving e saúde de alarme.
- **94 arquivos de teste + 6 suítes e2e + axe/a11y em 7 rotas + gate de acurácia no CI.**
- **Invariante "a caixa da pessoa nunca exibe número"** respeitado nos dois renderizadores, com gate
  que quebra o build.

O problema deste produto **não é a engenharia do motor**. É a fronteira entre o motor e o humano.

---

## 3. Respostas diretas às três perguntas do dono

### 3.1 "A exclusão, que impede o operador de entrar na área, precisa ficar mais clara"

**A premissa da pergunta já é o achado.** São dois modos diferentes, e o nome do dono trocou os dois:

| Modo | O que REALMENTE faz | Gera alarme? |
|---|---|---|
| **Exclusão** | **Suprime detecção**. Pessoa cujo pé cai ali é descartada antes de rastrear/contar/alarmar. Existe para matar falso positivo de objeto fixo (grade, placa, janela escura de van) | **Não** |
| **Proibida** | **Vigia presença**. Pessoa parada ali além do dwell dispara **alarme crítico**, 24/7, mesmo com o painel fechado | **Sim** |

Se o dono do produto troca os dois, o operador troca também. Agravantes medidos:

- A ajuda do drawer lista **cinco** modos e **omite "Proibida"** — justamente o único que alarma.
- A legenda do overlay explica *"Exclusão (ignorada)"* e **não diz nada** sobre a hachura/badge da
  proibida.
- O badge de "Proibida" usa o mesmo tom visual de "Leitura" e "Fadiga".
- O texto que diz "dispara alarme crítico" só aparece **depois** de selecionar o modo, e some ao
  trocar de opção.

**Não existe nenhuma superfície permanente que diga qual modo alarma.**

E há um efeito colateral que ninguém vê: a zona de exclusão vira **também** máscara de ignore do gate
de movimento. Pintar exclusão grande **reduz a capacidade da câmera de acordar o motor** — na direção
do falso-negativo. A UI não avisa.

### 3.2 "Contagem de caixas, marcador de caixas — validar"

**Contagem de caixas (papelão/volume):**

- O motor do hub filtra `d.class !== "person"` (`server/analysis/pipeline.js:73`). **Ele conta
  exclusivamente pessoas.**
- A contagem de caixas roda **inteiramente no navegador**, via OWL-ViT zero-shot. **Só existe
  enquanto alguém mantém aquela câmera aberta na tela.** Fechou a aba, parou de contar.
- O modelo é baixado do HuggingFace com `env.allowLocalModels = false`. **Sem internet no navegador
  do operador**, o worker falha, o latch marca falha permanente e o sistema cai no andaime coco-ssd,
  **que não conhece "caixa"**. Como o default da zona de objetos é exatamente `["caixa"]`, o
  resultado é **contagem 0 para sempre**, visualmente idêntico a "não tem caixa".
- O campo `backend` (`carregando/coco/owlvit/indisponível`), que diria qual modelo está ativo, é
  calculado e **descartado**.
- **O piso de score está 5× acima da faixa de operação do modelo.** O projeto documenta em duas
  linhas que *"os scores do OWL-ViT são baixos"* (`objects.threshold: 0.1`; preset de exibição
  `0.15` *"para não esconder caixas"*), e a contagem corta em `detection.objectScoreThreshold: 0.5`
  — knob calibrado para coco-ssd. **Hipótese forte, não medida:** é o primeiro lugar a olhar se o
  relato for "não conta caixa nenhuma".
- O número que existe é **ocupação instantânea** ("quantas caixas estão em cena"), nunca **fluxo**
  ("quantas passaram"). A matriz Setor × Classe ao vivo prometida no plano **não existe** (o
  processador recebe um setor só e a matriz é descartada); ela existe apenas no relatório.

**Marcador (bounding box):**

- Funciona nos dois renderizadores e respeita o invariante de não exibir número. **[M✓]**
- **A opacidade carrega DOIS significados no mesmo canal** e nada explica isso: (a) score abaixo do
  slider de confiança; (b) fade/coasting do interpolador. Uma caixa a 45% pode ser "detecção fraca"
  **ou** "estou sem observação nova há 2s" — e as duas exigem ação diferente do operador (calibrar ×
  investigar câmera/CPU). Não há legenda.
- A regra escrita *"contagem vive no PAINEL, nunca sobre a imagem"* é mais ampla que o gate: o HUD de
  tripwire (`L1 in 12 out 9`) e o rótulo de zona de objetos (`Doca · 📦5`) põem número sobre a
  imagem. **Decidir explicitamente** qual das duas vale.

### 3.3 "Quais informações estão ocultas — vistas só pelo motor"

Tudo abaixo é calculado e **nunca chega a nenhuma tela**:

| Oculto | Consequência de não expor |
|---|---|
| **Auto-máscara ligada por default em modo `hide`** — o sistema aprende sozinho regiões e passa a suprimir detecção nelas. Zero UI (`grep` no front: nada) | É uma zona de exclusão que o sistema cria sem pedir licença e ninguém audita |
| Gate de movimento: `skipMoving1m`, percentis de ratio | Ninguém sabe quando a câmera fica cega |
| Autoscale trocando modelo N/S/M em runtime | O recall muda sozinho; o operador vê menos gente e não sabe por quê |
| Worker morrendo/respawnando, ffmpeg reconectando, motor desligado por falta de modelo | Sistema degradado com cara de normal |
| Fallback Postgres → JSON | Só aparece no empty-state e para quem tem `canConfigure` |
| `backend` do modelo de objetos | "0 caixas" ≡ "modelo morto" |
| Zona proibida: estado da máquina, e o fato de estar **desarmada por turno** | Falso-OK: lê-se "ARMADA" quando a política está calando |
| **Tabela `app_views`** | 100% morta: zero INSERT, zero SELECT, zero rota |
| **`flow_events`** | Gravada e nunca lida pelo front |
| `people_peak` é **MAX** e não existe `people_sum`/`people_samples` | **A média de pessoas por zona é impossível no schema atual.** A pergunta mais natural do negócio ("quantas pessoas em média na doca?") não tem resposta |

---

## 4. Achados por gravidade

Legenda: **[M✓]** medido nesta auditoria · **[M]** lido no código com evidência · **[H]** hipótese.

### P0 — o número está errado ou a tela afirma o que é falso

| # | Achado | Evidência |
|---|---|---|
| **A1** | **Duas zonas com o mesmo rótulo somam a contagem uma da outra — e contamina o RELATÓRIO.** Medido: 2 zonas distintas, 1 pessoa em cada → payload reporta `people=2` para as duas e o ingest grava `peak=2` em ambas. **100% de inflação.** E `cleanZone` batiza toda zona sem nome como `"Área"` — criar duas zonas e não nomear é o caminho **padrão** | **[M✓]** `pipeline.js:136-151,193`; `camcfg.js:114` |
| **A2** | **Período sem dado renderiza como operação perfeita:** `ratePct: passages ? … : 100` e `okPct: samples ? … : 100`. O gate de vazio olha o dataset **inteiro**, não a janela filtrada | **[M✓]** `calc/leitura.ts:89`, `calc/fadiga.ts:68`, `ReportPage.tsx:284` |
| **A3** | **Falha de rede vira "está tudo normal":** `catch { setShelves([]) }` faz a tela escrever *"Nenhum alarme silenciado. Os alertas seguem o fluxo normal."* | **[M]** `ReportTools.tsx:110-116` |
| **A4** | **O diálogo de "Limpar histórico" mente:** promete apagar "indicadores, eventos **e alarmes**", mas `clear()` trunca 10 tabelas e `alarm_events` **não está entre elas** | **[M✓]** `ReportTools.tsx:348` × `pgstore.js:780-788` |
| **A5** | **Dois relógios de turno na mesma página.** Atividade filtra pelo carimbo real; Fluxo cai no legado hard-coded 06/14/22 porque `flow_buckets` não tem coluna de turno. Selecionar um turno **cadastrado** zera o painel de Fluxo enquanto Atividade mostra dados. O próprio código já declara a pendência | **[M✓]** probe executado: turno cadastrado → 0 linhas; `calc/flow.ts:9-11` |
| **A6** | **"Tempo parado" é 0 por construção com o motor ligado.** O hub grava `idleMs: 0` de propósito e o cliente para de gravar `ativ`. O heatmap "Quando para" vira grade de zeros e "Onde para" fica vazio. A tela exibe `0m`, que se lê como "nada parou" | **[M]** `pipeline.js:253`, `ingestPolicy.ts:18`, `calc/atividade.ts:89,108` |
| **A7** | **`read_events.cameras` é gravada como literal `1`** nos dois caminhos e a tela renderiza `cameras > 1 ? "N×" : "1"` — finge que varia | **[M✓]** `pgstore.js:369,598` × `LeituraPanel.tsx:180` |
| **A8** | **O "dia" do relatório é dia UTC**, enquanto a hora da célula é local e o servidor resolve turno em `America/Sao_Paulo`. Em UTC−3 os "dias" correm das 21h às 21h — a quebra diária está sistematicamente errada para turno noturno | **[M]** `store.ts:52,61` × `shift-clock.js:8` |
| **A9** | **Tetos invisíveis:** `limit: 500` corta a fila de alarmes **antes** de qualquer filtro; o filtro "30 dias" coincide exatamente com a retenção default. A tela nunca diz que truncou | **[M]** `useReportData.ts:77`, `events.js:23` |
| **A10** | **Contagem dupla em modo local:** sem guard por sessão, N dashboards abertos na mesma câmera gravam N× cruzamentos. Dormente com o motor ligado; ativa se o motor cair | **[M]** `ingestPolicy.ts`, `CameraWorkspace.tsx:821-828` |

### P0 — proteção que não protege

| # | Achado | Evidência |
|---|---|---|
| **B1** | **Zona proibida é invisível na grade.** Com WebRTC (o default), o tile desenha só caixas de pessoa — nenhuma zona, nenhum badge VIOLADA. Na tela que o operador olha o dia inteiro, uma violação é visualmente idêntica ao normal | **[M]** `CameraTile.tsx:266-278`, `TrackOverlay.tsx:91-118` |
| **B2** | **Alarme crítico não interrompe ninguém:** `alarm-event` só empilha na fila do drawer, sem toast | **[M]** `useDashboardSocket.ts:160-162` |
| **B3** | **Falso-OK visual do armamento:** com `arming: dentro-turnos`, fora da janela a política silencia mas o canvas segue escrito **ARMADA** | **[M]** `shift.js:133-139` × `draw.ts:896-968` |
| **B4** | **Alerta de ociosidade só existe com navegador aberto** — e em tile WebRTC nem isso. Assimetria não declarada em nenhuma tela | **[M]** `pipeline.js:253` |
| **B5** | **Exportar CSV não tem gate nenhum.** Qualquer `usuario` baixa indicadores, eventos e a fila de alarmes **com nomes de pessoas** (`ackBy`) e `posto` do modo Fadiga. A tela estampa "indicadores · sem imagens" — *sem imagens ≠ sem dado pessoal*. Sem log de exportação | **[M]** `report/csv.ts:65`, `ReportPage.tsx:398` |
| **B6** | **`modo` de zona inválido é rebaixado em silêncio para `atividade`** — uma zona proibida corrompida vira zona de contagem sem erro, sem log, sem 400 | **[M]** `camcfg.js:119` |
| **B7** | **O caminho que envia mensagem para número externo não tem teste.** `whatsapp.js`, `dispatch.js` e `alerts.js`: zero arquivos de teste | **[M✓]** |

### P1 — o operador não consegue interpretar

- **C1** Nada distingue "Exclusão" de "Proibida" no ponto de escolha; a proibida não está no help nem
  na legenda. **[M]**
- **C2** A opacidade do marcador tem dois significados e nenhuma legenda. **[M]**
- **C3** Não há um único aviso de *"este modo só conta com a tela aberta"* para leitura/objetos/fadiga
  — enquanto a descrição de "proibida" se gaba do 24/7, sugerindo por contraste que os outros também
  são. **[M]**
- **C4** "Zerar contagem" não faz nada visível em modo hub. **[M]**
- **C5** "hoje" das linhas é dia de calendário local, não dia-de-turno: turno noturno zera no meio.
  E o número só se move a cada 30s. **[M]**
- **C6** Inverter uma linha preserva o id: o bucket da hora corrente passa a misturar entradas e
  saídas silenciosamente. **[M]**
- **C7** O relatório não oferece **nenhuma ação** ao encarregado — sem ack (a API existe e é usada só
  no dashboard), sem link do alarme para a câmera. **[M]**
- **C8** No mobile, heatmap e tendência só têm valor em `title=` nativo — inacessível por toque. **[M]**

### P2 — prometido × entregue (documentação)

A raiz é estrutural e foi medida: `git log --follow` mostra que os **10 documentos-núcleo de
`docs/produto/` nunca tiveram o conteúdo alterado desde o import inicial**. Descrevem 09/06/2026. De
lá para cá entraram ADR-009, 011, 016, 018, 019, login/RBAC, Postgres, control-plane, alarmes ISA-18,
turnos, calibração. **São sete semanas de fóssil.**

As cinco divergências mais caras:

1. **`VISAO-GERAL.md` descreve a arquitetura anterior como se fosse a atual** — "Central processa
   tudo, o dashboard roda a IA", "Hub é só relé". O oposto exato do ADR-009. É o documento chamado
   "estado atual" e a porta de entrada do projeto. Quem o lê dimensiona hardware errado e procura o
   pipeline em `src/CameraView.tsx`, que não existe mais.
2. **Login/RBAC está completo e três documentos dizem que é pendência.** É a mitigação LGPD exigida
   pela proposta — listá-la como pendente entrega de graça o argumento de que o produto é inseguro.
3. **WhatsApp está implementado ponta a ponta e os docs dizem "adiado, sem envio real".**
4. **Multi-tenant "adiado" versus um `control-plane/` com RLS, SPA própria e 9 suítes de teste** — o
   ativo comercialmente mais valioso do repo é invisível na documentação de produto.
5. **Quatro documentos prometem IDs "Pessoa N"** — exatamente o que dois testes de gate proíbem.

Menções: **IndexedDB nunca existiu neste repo** (cinco documentos o descrevem como a persistência);
`plano-modo-objetos.md` diz "Sem código ainda" na linha 3 e "MODO COMPLETO" na linha 7;
`ci-cd-github-actions.md` diz que não há remote (há); `deploy-*.md` documenta `PANEL_PASSWORD`, que
não existe no código.

**Entregue e não documentado** (o que o produto faz e ninguém sabe vender): alarmes ISA-18.2,
control-plane multi-tenant, turnos como cadastro global, calibração por homografia, zonas poligonais,
zona de exclusão (que é a resposta direta à pendência #27 sobre falso positivo industrial),
tripwires, tiling de longo alcance com custo medido, autoscale, cine-loop, ingest RTMP, webhook
Andon, opt-in LGPD por usuário, gate de acurácia no CI.

---

## 5. O plano

Ordenado por **dano evitado ÷ custo**. Nenhum item entra sem sensor — é a regra da casa.

### Onda 1 — parar de mentir (≈ 3 dias, quase tudo custo baixo)

Um tema só: **onde não há medição, a tela diz que não há.** É o maior retorno do projeto inteiro.

| # | Ação | Sensor |
|---|---|---|
| 1.1 | **A1** — contar por `zoneId`, não por label (e barrar rótulo duplicado no save, 400 como já se faz para turnos sobrepostos) | `pipeline.test.js`: 2 zonas homônimas, 1 pessoa em cada → `1` e `1`. **Hoje falha (medido: dá 2 e 2)** |
| 1.2 | **A2** — `ratePct`/`okPct` devolvem `null` com amostra zero; UI escreve `—`; `noData` sobre a janela filtrada | unit: entrada vazia **nunca** retorna 100; e2e: período sem dado → empty-state, assert negativo de "100%" |
| 1.3 | **A3** — trocar os `catch { setX([]) }` por estado de falha explícito | unit: `listShelves` rejeitando renderiza "não foi possível consultar" |
| 1.4 | **A4** — corrigir o texto do diálogo **ou** incluir `alarm_events` no truncate | teste server: após `clear()`, a lista reflete o que o diálogo prometeu |
| 1.5 | **A7** — consertar ou remover `read_events.cameras` | teste: leitura em 2 câmeras → `cameras=2`; ou o grep da coluna vai a 0 |
| 1.6 | **A9** — `truncated`/`total` na resposta + "mostrando 500 de N" na tela | teste: 1200 eventos com `limit:500` → `truncated:true` |
| 1.7 | **A6** — enquanto o motor não medir ociosidade, o relatório **declara a ausência** em vez de exibir `0m` | teste: bucket com `idleMs=0` e `frames>0` não pode render "0m" sem selo de indisponível |
| 1.8 | **B2** — toast para `alarm-event` com `priority: critical` (e **só** critical — advisory viraria ruído, EEMUA-191) | teste: critical ⇒ toast 1×; advisory ⇒ 0 |
| 1.9 | Dropar a tabela `app_views` | `grep app_views` = 0 |

### Onda 2 — clareza (≈ 2 dias, o pedido explícito do dono)

| # | Ação | Sensor |
|---|---|---|
| 2.1 | **Renomear os modos de zona** para que a diferença esteja no efeito, não no adjetivo: `Exclusão` → **"Ignorar área — sem alarme"** · `Proibida` → **"Área restrita — gera alarme"** | teste travando as strings dos 6 modos; o e2e que hoje mira `option name:"Exclusão"` falha e precisa ser atualizado — esse é o sensor |
| 2.2 | Bloco de "Área restrita" no drawer (dwell + arming em texto), entrada na legenda e no help dos modos | teste: `legendFor` inclui a entrada quando há zona proibida |
| 2.3 | **Aviso na exclusão**: *"Esta área também deixa de acordar a câmera. Cobrir muito do quadro reduz a análise ao mínimo de 6s"* + medidor de `% do quadro ignorado` | o sensor já existe no back: `gate.skipMoving1m` sobe com exclusão grande |
| 2.4 | **Legenda da opacidade** do marcador — e, melhor, separar os dois canais (tracejado para coasting, opacidade só para confiança) | `draw.test.ts` estendido com a regra final |
| 2.5 | **Declarar onde cada modo roda**: uma linha em `MODO_DESC` para leitura/objetos/fadiga, espelhando o que já se diz da proibida | gate: todo modo em `MODO_DESC` precisa conter "hub" ou "painel aberto" — trava o próximo modo que nascer mudo |
| 2.6 | **C4/C5/C6** — desabilitar "Zerar" em hub com tooltip; rotular escopo do "hoje" e do "pico"; inverter linha gera identidade nova | testes de render + teste de `useTripwires` (que hoje **não existe**) |

### Onda 3 — tirar o motor do porão (≈ 4 dias)

| # | Ação | Sensor |
|---|---|---|
| 3.1 | **Painel de Saúde por câmera** consumindo o `/api/analysis/status` que já existe: modelo ativo, fps alcançado × alvo, pulos do gate com gente andando, dets suprimidas por exclusão e por auto-máscara, worker/respawn, fonte do frame, fallback de persistência | e2e: com motor desligado, o painel diz **desligado** — hoje a tela mostra "0 pessoas" |
| 3.2 | **Expor o `backend` do modelo de objetos** (o valor já é calculado e jogado fora) | teste: `backend:"coco"` + `selectedClasses:["caixa"]` ⇒ a zona **tem de** avisar que nenhuma classe selecionada é detectável |
| 3.3 | **B1** — desenhar zona proibida (ao menos em violação) no tile WebRTC | teste de render + e2e de violação acendendo o tile |
| 3.4 | **B3** — hub carimba `armed:boolean` no payload; canvas mostra **DESARMADA** fora da janela | teste de contrato: zona `dentro-turnos` fora do turno ⇒ `armed:false` |
| 3.5 | **Auto-máscara visível** (lista de células suprimidas + "virar exclusão" ou "descartar"), ou mudar o default para `suggest` | `statusOf()` já devolve os rects prontos; sensor: `automasked1m` na tela |
| 3.6 | **B5** — gate de papel + log em exportação de CSV; revisar LGPD do modo Operador | teste: `usuario` sem capacidade recebe negativa do servidor |

### Onda 4 — corretude a prazo (≈ 1 semana)

| # | Ação | Sensor |
|---|---|---|
| 4.1 | **A5** — carimbar turno em `flow_buckets` (aditivo; o padrão já existe no schema) | teste de paridade: Atividade e Fluxo devolvem o mesmo recorte para o mesmo turno |
| 4.2 | **A8** — usar `SITE_TZ` (o mesmo do `shift-clock`) em `deriveWindow`/`alarmDayStart` | unit com `TZ=America/Sao_Paulo`: "Hoje" começa à meia-noite local |
| 4.3 | **`people_sum` + `people_samples`** em `ativ_buckets` — a média de pessoas que hoje é impossível | `pgstore.test.js`: soma acumula, pico continua `greatest`; KPI "média" no painel |
| 4.4 | **A10** — eleger um escritor por câmera em modo local, ou deduplicar no ingest | integração: 2 clientes na mesma câmera → 1 cruzamento |
| 4.5 | **C7** — ack e link-para-câmera no relatório (a API já existe) | e2e: reconhecer no relatório reflete na Central |
| 4.6 | Teste do caminho de notificação externa (`whatsapp`/`dispatch`/`alerts`) | é o próprio teste — hoje são zero |
| 4.7 | Devolver à tela o que já é calculado e descartado: gráfico "Por turno", delta em Objetos/Fadiga | render test |

### Onda 5 — a contagem de caixas de verdade (≈ 2–3 semanas, decisão de produto)

Hoje ela **não existe 24/7** e depende de internet no navegador. Antes de prometer ao cliente:

1. **Medir primeiro (barato, dias):** a curva `precisão × recall × minScore` com 20–30 frames reais
   do CD e caixas contadas à mão, reportada com **n e intervalo de Wilson 95%** — nunca o ponto.
   Testar a hipótese de que o piso 0.5 (calibrado para coco) está cortando o OWL-ViT, cuja faixa
   documentada é 0.1–0.15.
2. **Decidir o alvo:** "quantas caixas **estão** na doca" (ocupação, o que existe) × "quantas
   **passaram**" (fluxo, o que foi prometido). Fluxo esbarra na **Regra 9** da casa: o OWL-ViT roda a
   ~700ms–3s por inferência e **abaixo dessa cadência não há como resolver uma travessia**. Medir a
   cadência real antes de prometer, e declarar o ponto cego.
3. **Se o alvo for 24/7:** o caminho é detector próprio (YOLO fine-tunado em ONNX) **no hub**, junto
   do D-FINE — é o F5 do próprio plano de produto. Com `eval/counting-objetos.mjs` espelhando o
   sensor de pessoas **antes** de qualquer promessa.

### Onda 6 — documentação (≈ 12 h)

1. Correções cirúrgicas (1h): as mentiras pontuais — "Sem código ainda", "não tem remote",
   `PANEL_PASSWORD`, ADR-009 "proposto", "Pessoa N".
2. Reescrever `README.md` (porta de entrada) e `VISAO-GERAL.md` (arquitetura real, funcionalidades
   reais, incluindo as 14 entregues e não documentadas).
3. Atualizar `pendencias.md` e `cobertura-vs-documento.md` — mover login, WhatsApp, RTSP e
   multi-tenant para "entregue"; a zona de exclusão é a resposta à pendência #27 e merece o crédito.
4. Aposentar os planos de concepção para `docs/produto/historico/` com aviso de que não descrevem o
   sistema atual.
5. **Fonte única declarada:** `README.md` + `docs/arquitetura/` + ADRs mandam sobre "o que existe
   hoje"; `docs/produto/` vira registro de intenção.

### Item avulso (1 minuto)

`git config core.hooksPath` está **vazio** — o gate `pre-push` que o CLAUDE.md §6 promete está
inativo neste clone. `git config core.hooksPath .githooks` restaura.

---

## 6. Residual declarado

- **Nada aqui é medição de campo.** Não rodamos o sistema contra câmera real; não medimos recall de
  pessoa, precisão do OWL-ViT em caixas reais nem taxa de cruzamento perdido. Os sensores verdes
  medem lógica sobre entrada sintética — a fronteira está declarada no cabeçalho do próprio sensor.
- A **hipótese do piso de score 0.5** é a conclusão importante que continua sendo hipótese. É forte
  (o teste do módulo e o preset de exibição usam 0.1–0.2 enquanto a produção corta em 0.5), mas
  exige um frame real com caixas para virar medição.
- Não auditamos o `control-plane/` por dentro, nem o caminho de alarme a jusante
  (dedup/flood/shelve), nem `docs/analises/` além dos arquivos citados — a amostra aberta lá mostrou
  3 de 3 com afirmações desatualizadas, o que sugere drift semelhante no resto. **Sugestão, não
  medição.**
