# SPEC — Arquitetura de informação: menos telas, mais produto

> Status: **aprovada pelo dono** (2026-07-13) · Duas decisões dele, registradas:
> **(a) modo apresentação → CORTA** (não faz o que promete; se um dia o CD pedir TV, constrói-se de
> verdade, como feature). **(b) a tela unificada mantém o nome "Relatório"** — o item de alto uso do
> menu não muda de nome; a saúde de alarmes entra como a faixa do topo, sem se anunciar como tela nova.
> Origem: 3 pedidos do dono — (1) calibração vira modo da câmera, (2) relatório + saúde de alarmes se
> unificam ("tem bastante coisa no relatório — analise o que faz sentido permanecer"), (3) Tags BLE e
> Estações BLE no mesmo menu.
> Insumos: auditoria read-only em 3 frentes (calibração / relatório+alarmes / IA global).

## 0. A tese

O app cresceu por **adição de rota**: toda capacidade nova virou um item de menu. O superadmin vê
**12 itens**; 3 telas existem só para hospedar um componente ou repetir um número que já mora em
outro lugar. Isto não é estética — é o custo de **decidir onde ir** antes de decidir o que fazer.

As 3 mudanças pedidas convergem no mesmo movimento: **capacidade não é lugar.** Calibrar é uma coisa
que se faz *na câmera*; a saúde do alarme é uma coisa que se lê *junto do histórico*; a estação é o
outro lado da tag. Menu: **12 → 9**.

## 1. Calibração vira MODO do palco (mata a rota)

**O que a rota `/calibracao` é hoje:** seletor de câmera + *probe* de um JPEG parado do go2rtc + o
`CalibrationPanel`. Zero lógica própria (`CalibrationPage.tsx`, 141 linhas).

**Por que ela pode morrer** (não é opinião, é o que o código diz):
- O universo de câmeras é **idêntico** ao da Central — mesmo evento socket `cameras`
  (`CalibrationPage.tsx:40` × `useDashboardSocket.ts:115`). O argumento "preciso calibrar câmera que
  não está no palco" **não existe**.
- O insumo da página é o **pior possível**: um JPEG único e parado; se o go2rtc não serve aquela
  câmera (MJPEG puro), o operador calibra **às cegas sobre um xadrez** (`:119-126`). No palco, a
  imagem é o **vídeo real**.
- Zero link externo, zero e2e, zero deep-link. A remoção é **gratuita** no gate.
- O palco **já desenha a conferência** (`drawCalibrationOverlay` em `draw.ts:453`).

**O molde já existe:** Zona, Polígono, Linha e Pincel **já são modos** — `usePolygonEditor.ts` é o
padrão canônico (hook dono do estado, `draftRef` lido pelo rAF, handlers que devolvem `boolean`,
ESC/Enter). Calibrar vira o quinto, pelo mesmo caminho.

| # | arquivo | o quê |
|---|---|---|
| A | **novo** `src/camera/useCalibrationEditor.ts` | molde `usePolygonEditor`: dono de cantos/âncoras/estação/refTag/L×C/`liveH`/`save()`. Reuso puro de `homography`, `station-points`, `takenTags`, `station-geometry`. Zero regra nova |
| B | **novo** `src/camera/tabs/CalibracaoTab.tsx` | o *chrome* do painel **menos o palco** — 6ª aba do drawer |
| C | `src/camera/CamHeader.tsx` | Toggle **"Calibrar"** (mesmo idioma de Zona/Polígono/Linha) |
| D | camada **SVG irmã do canvas** | resolve o risco nº 1 (abaixo) sem tocar no rAF |
| E | `src/CameraWorkspace.tsx` | fiação: 1 hook, 1 delegação no if-chain, exclusão mútua, 1 `TabsContent` |
| F | `main.tsx` · `AppShell.tsx:246` · `CalibrationPage.tsx` · `CalibrationPanel.tsx` | **deletar** |

**Riscos (os 3 que decidem o diff):**
1. **Clicar com a imagem parada.** No palco, Pausar/Congelar **não redesenham o canvas** — um canto
   clicado não apareceria. Solução: camada **SVG irmã** do canvas (como a `<CineBar>`), posicionada
   pelo content-rect. **Não mexer no rAF** (é o gate de frame).
2. **O Medir morre para o operador** se plugado ingenuamente: o `onDown` do palco corta
   `!canConfigure` **antes de tudo** (`CameraWorkspace.tsx:1312`); hoje o operador *pode* medir.
   O guard do medir tem de ficar **acima** desse return.
3. **Ratchet de tamanho**: `CameraWorkspace.size.test.ts` fixa 1760 linhas; o arquivo tem **1756**.
   A fiação não cabe. Extrair `useStageModes` **antes** do diff (o próprio teste já declara que esse
   seam não é limpo hoje) — extrair, não levantar o teto.

**Ganho colateral:** some o `probeFailed`/xadrez, e o toque (pointer events) entra no palco.

## 2. Relatório + Saúde de alarmes → UMA tela (a poda)

### 2.1 A evidência da unificação
O Relatório **já tem** um modo "Alarmes". Ele e a `AlarmHealthPage` contam a mesma história em dois
lugares — e o Relatório conta na versão **pior**:

| | Relatório (modo Alarmes) | Saúde de alarmes |
|---|---|---|
| fonte | `/api/alarms` — **histórico persistido** (dias) | `/api/alarms/metrics` — **memória** (janela de 10 min) |
| % críticos | uma **frase** no Insight | **KPI + sparkline + faixa ≤5% + flag** ← cumpre a doutrina |
| prioridade | 4 números crus | 2 barras analógicas |
| tendência 14d, heatmap, fila/ack | **tem** | não tem |
| shelve, gate de turno | não tem | **tem** |

Nenhuma das duas responde sozinha *"o alarme está saudável **e** o que aconteceu ontem"*. Hoje o
gestor **troca de rota** — e as rotas nem estão no mesmo grupo de menu.

### 2.2 O achado estrutural (o que realmente enche o relatório)
`modo` é **por CÂMERA** e os 4 modos são **mutuamente exclusivos** (`cameraConfig.ts:13`). Num CD com
N câmeras de ocupação, **3 das 5 dimensões ficam permanentemente vazias** — e a tela de abertura
(Resumo) **exige as 4** para renderizar (`ReportPage.tsx:477-482`), mostrando 4 cartões dos quais 3
são zeros. Isso é **pior que vazio**: ensina o gestor a ignorar número.

### 2.3 O que MORRE (e por quê)

| corte | porquê |
|---|---|
| **Modo apresentação** | o efeito TOTAL são 2 regras de CSS: esconde filtros e aumenta o KPI de 24→30px. Sem fullscreen, sem rotação, sem auto-refresh. Não é um modo TV — é um zoom |
| **"Por turno"** (Atividade e Leitura) | turno **já é filtro global**: com um turno escolhido, o gráfico vira **uma barra** |
| **Aba "onde" da Fadiga** | renderiza **o mesmo heatmap** da aba "quando" (duplicação declarada no código, `FadigaPanel.tsx:84-104`) |
| **Rank "por classe"** (Objetos) | a matriz Setor×Classe logo acima já é isso |
| **KPI "último minuto/hora"** (Saúde) | a taxa/min já cobre; "picos recentes" não indica ação |
| **2ª barra de prioridade** (Saúde) | janela=10min × hora=60min, escalas quase iguais — duplicata visual |
| **KPIs crus sem alvo**: bocejos, presença %, pico de pessoas, saldo de fluxo | número sem faixa-alvo não sustenta decisão (doutrina 12). Descem para o **CSV**, não somem do dado |
| **4 das 5 "Tendência (14 dias)"** | a mesma peça implementada 5×. Vira 1 componente |
| **"fonte do histórico" (pg/json)** na toolbar do gestor | ninguém age sobre "banco vs arquivo". Desce para engenharia |

### 2.4 A tela nova — hierarquia (o que o gestor lê primeiro)

- **N1 — "o detector está confiável?"** (faixa no topo, **não obedece ao filtro de período**):
  taxa/min · % críticos vs alvo ≤5% · silenciados · suprimidos por turno. Rótulo explícito:
  *"agora · últimos 10 min"*. **Razão da posição:** se o alarme está inundando, **todo número abaixo
  é suspeito** — a saúde precede a leitura.
- **N2 — Resumo executivo:** só as dimensões **com dado** (mata o gate das 4) + um **5º cartão:
  Alarmes** (hoje inexistente no resumo — a prova de que a dimensão é enteada).
- **N3 — Alarmes:** tendência 14d clicável + heatmap prioridade×hora + fila com ack.
- **N4 — Dimensão:** só as que têm dado. Filtros do recorte **ancorados na seção**, não no header
  (a `FilterBar` que muda de forma conforme o modo é exatamente o que produz o "tem bastante coisa").
  **Régua do turno promovida ao topo da Atividade** — é a melhor peça da tela (ocupação ÷ janela de
  trabalho, não ÷ 24h).
- **N5 — Ferramentas (`canConfigure`):** silenciamentos · limpar histórico · fonte do histórico.

### 2.5 O que se perde — e a mitigação
- **Duas escalas temporais incompatíveis** (risco nº 1): "taxa/min nos últimos 30 dias" **não existe
  no back** e não pode ser inventada. → N1 **não obedece** ao filtro e **diz isso na cara**. As duas
  verdades convivem em **alturas diferentes**, nunca lado a lado sob o mesmo filtro.
- **Dois relógios:** a Saúde repinta a cada 7s; o Relatório é carga única. → **só N1 tem timer**; o
  corpo histórico não pisca embaixo do gestor.
- **RBAC:** a Saúde era protegida pela **rota**. Ao fundir, o bloco de silenciamento **precisa de
  `canConfigure` explícito** — senão vaza ação de configuração para o operador.
- **e2e é load-bearing:** os specs fixam h1 "Relatório Operacional", o botão de modo "Atividade", o
  `tablist` "Seção" com 5 tabs, e `/alarmes-saude` no gate mobile. Renomear/matar **quebra 2 specs** —
  atualizar no **MESMO PR** (regra A18).

## 3. Tags BLE + Estações BLE — uma tela com abas

| desenho | itens de menu | veredito |
|---|---|---|
| A — grupo novo "BLE" com 2 itens | 2 (+1 header) | **pior**: mais superfície e mantém a decisão "Tags ou Estações?" |
| B — mover Estações para Operação, ao lado de Tags | 2 | barato (1 linha), meia-solução |
| **C — uma tela "BLE" com abas (Tags \| Estações)** | **1** | **recomendado** |

**C**, pelo critério da casa (menos superfície, menos decisão): tira um item do rail, a aba Estações
fica *gated* por `canConfigure`, e a relação **Tag ↔ Estação** (RSSI, saúde) passa a viver onde o
operador já está. É o padrão que a casa já usa duas vezes (modos do Relatório, abas do
CameraWorkspace). **Manter `/tags-ble` como path default** (o e2e navega por ele).

## 4. A árvore

```
ANTES (superadmin: 12)                  DEPOIS (superadmin: 9)
Operação                                Operação
  Mapa            /                       Mapa        /
  Central         /monitoramento          Central     /monitoramento  ← calibrar vive AQUI (modo)
  Câmeras         /cameras                Câmeras     /cameras
  Relatório       /relatorio               BLE         /tags-ble       ← abas: Tags | Estações
  Tags BLE        /tags-ble                Relatório   /relatorio      ← absorve a Saúde de alarmes
  Calibração      /calibracao    ✗SAI   Administração (canConfigure)
Administração                             Turnos      /turnos
  Saúde alarmes   /alarmes-saude ✗SAI     Simulação   /replay          ← renomeado (bate com o h1)
  Turnos          /turnos                 Usuários    /usuarios
  Estações BLE    /estacoes      ✗SAI   Conta
  Replay (sim)    /replay                 Meu perfil  /perfil
  Usuários        /usuarios
Conta
  Meu perfil      /perfil
```

Operador 7→6 · engenheiro 11→9 · superadmin 12→9. **Os itens de alto uso não mudam de lugar nem de
nome** (Mapa, Central, Câmeras, Relatório). O que sai do rail é de engenharia — uso raro, usuário
treinado. Risco de memória muscular: baixo.

## 5. Achados colaterais (entram junto)

1. 🔴 **A multi-antena não persiste os pontos das estações.** `CalibrationPanel.tsx:375` envia
   `stations`; a allowlist de `cleanCalibration` (`server/camcfg.js:204-245`) **não conhece o campo**
   e descarta; `api.ts:315` não o declara. Marca a 2ª antena, salva, recarrega → **sumiu**. Conserto
   nas 3 camadas + teste de contrato (é a "regressão silenciosa nº 1" do CLAUDE.md, literal).
2. **"Limpar histórico" é visível para todos** — mas o servidor **barra** (`data.js:36`,
   `requireSuper`). Não é furo; é um botão que existe para dizer "não". Vai para N5 sob `canConfigure`.
3. **"Replay (sim)"** no menu × h1 "Bancada de simulação" — **sem interseção lexical**. Vira "Simulação".
4. **`e2e/mobile.spec.ts:10` está podre**: espera "Central de câmeras" num título que hoje é
   "Central". Não falha porque o campo `heading` **nunca é asserido**. Campo morto — ou usa, ou sai.
5. **Item "Calibração" sem RBAC** apontando para uma tela que recusa o operador. Morre junto com a rota.

## 6. Fora de escopo

Redesign visual · tema claro · lib nova de UI · mudar o que o Relatório **calcula** (a poda é de
apresentação e de duplicata — nenhum indicador novo, nenhuma fórmula alterada) · deep-link de câmera.

## 7. Ordem (sequenciada atrás da Onda E, que está com esses arquivos abertos)

1. **BLE abas** + **bug da multi-antena** (independentes de tudo) — [P]
2. **Calibração modo**: extrair `useStageModes` → hook → aba → matar rota — [S, depois da UI F3]
3. **Relatório unificado**: a poda primeiro (só remove), a fusão depois (N1..N5) — [S]
