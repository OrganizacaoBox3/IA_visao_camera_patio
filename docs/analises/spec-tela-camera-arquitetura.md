# SPEC — A tela da câmera: três naturezas, não sete abas

> Status: **aprovada pelo dono** (2026-07-13) — decisões: (1) avançar **fase a fase**, com validação
> do dono entre cada uma (não big-bang — é a tela que o operador mais usa); (2) as 3 seções de
> observação (Pessoas/Por quê/Timeline) convivem como **sub-abas dentro de um painel único**, não
> empilhadas em rolagem. F1 só começa depois que a onda de correção em voo (calibrar-vira-modo) pousar.
> · Data: 2026-07-13
> Queixa: *"a tela está tentando colocar tudo num local só. Faz sentido separar em modais ou visões?"*
> Insumos: 2 auditorias read-only (taxonomia + ADR-007 / mercado). Fontes: NN/g, Material 3, Figma,
> Frigate, Genetec, Milestone, tldraw.

## 1. A raiz (medida): não é densidade, é TAXONOMIA

As 7 abas do drawer (`CamDrawer.tsx:59-127`) parecem irmãs porque estão num único `Tabs`. Mas são
**três naturezas incompatíveis** achatadas em pares navegáveis. Três provas no código:

1. **A metáfora de aba MENTE.** `Tabs` diz "escolha 1 dos 7 para olhar". Mas a exclusividade real de
   3 delas (Zonas/Linhas/Calibrar) é imposta em OUTRO arquivo (`useStageModes.ts:46` `stageTarget`,
   `CameraWorkspace.tsx:1329`) — porque não são *vistas*, são **estados do palco que não coexistem**.
   Os outros 3 (Pessoas/Timeline/Por quê) *poderiam* estar visíveis ao mesmo tempo, e a aba impede.
2. **Duplicação header × drawer.** Zona/Linha/Calibrar existem como toggle no `CamHeader` **E** como
   aba no `CamDrawer`. Duas portas para o mesmo modo — sintoma clássico de natureza mal separada.
3. **Config-de-exibição partida em dois.** HUD/Malha/Tags (`CamKpiBar.tsx:61-80`) e
   Caixas/Máscara/Zonas/Heatmap (`CamadasTab.tsx:80-95`) são a MESMA natureza em dois lugares.

## 2. A fronteira que decide tudo (o dono pediu para esclarecer)

**Uma pergunta só: isso precisa do VÍDEO AO VIVO por baixo enquanto está em uso?**

| resposta | forma | por quê (mercado + ADR-007) |
|---|---|---|
| **SIM — desenha/clica sobre a imagem** | **MODO no palco** (nunca modal) | O Portal do Radix remontaria o `<canvas>` e mataria o rAF (ADR-007). Frigate desenha o polígono clicando na imagem; Figma/tldraw usam *tools* na toolbar. **Ninguém abre modal para desenhar sobre o vídeo.** |
| **NÃO — só observa/lê estado** | **PAINEL LATERAL** (não-modal, convive) | Observação/diagnóstico que fica aberto enquanto o vídeo roda ao lado. Genetec side panel, Figma panels, Material side sheet. |
| **NÃO — formulário curto de 1 item** | **MODAL Radix** (livre) | Tarefa curta e focada que interrompe, sem precisar do vídeo. NN/g: modal = "act on information". É o que o `ConfigZonaDialog` **já faz certo**. |

**O ConfigZonaDialog é a prova viva da fronteira:** ele é Radix Dialog, abre por cima da casca sem
remontá-la, e edita vértices por **tabela** (`VertexTable`) — sem tocar no canvas. Funciona porque, ao
nomear/ajustar uma zona, você não precisa ver o vídeo ao vivo por baixo. O trap de foco manual da
casca cede ao Radix nesse momento (já previsto no ADR-007).

## 3. A arquitetura proposta: 7 abas → barra de modos + 1 painel + modais

### (A) MODOS de edição — saem das abas, vivem na TOOLBAR do header
**Zona/Polígono · Linha · Calibrar.** Mutuamente exclusivos por construção (`stageTarget`), precisam
clicar sobre o vídeo. Já são toggles no header — a mudança é **tirá-los das abas** (fim da
duplicação) e, ao entrar num modo, mostrar o painel contextual DAQUELE modo (o "chrome" do editor),
como a onda em voo já faz para Calibrar. Padrão: Figma tools / Milestone Setup / Frigate editor.

### (B) OBSERVAÇÃO — viram UM painel lateral não-modal que convive com o vídeo
**Pessoas · Por quê · Timeline.** Mesma natureza (só-leitura), coexistem entre si e com qualquer
modo. São a visão diária do operador. Viram uma superfície de leitura única (sub-abas ou rolagem),
sempre disponível ao lado do vídeo — não 3 abas que competem com os modos de edição. Padrão: Genetec
side panel. RBAC: **todas visíveis ao operador** (é operação, não config).

### (C) EXIBIÇÃO — consolida num popover "Camadas" na toolbar
HUD/Malha/Tags (KPI bar) **+** Caixas/Máscara/Zonas/Heatmap/Confiança/Preset (aba Camadas) são a
mesma coisa em dois lugares. Viram **um controle único** de "o que mostrar" — popover/segmento leve
na toolbar, não uma aba de config. Padrão: Figma layers / Verkada toggles.

### (D) MODAIS — config pontual de 1 item, replicando o ConfigZonaDialog
O `ConfigZonaDialog` é o modelo. **Replicar** para: configurar 1 linha/tripwire (nome, sentido,
threshold), e migrar **"Longo alcance/Panorâmica"** (`CamadasTab.tsx:125` — persiste no backend, é
config de engenharia da câmera, não toggle de overlay) para modal. Tarefa curta, sem vídeo ao vivo
necessário → Radix Dialog é seguro.

### O resultado
De **7 abas heterogêneas** para: **barra de modos** (edição) + **1 painel lateral** (observação) +
**popover de exibição** + **modais** para config pontual. Menos superfície, cada coisa no registro
certo, e a metáfora deixa de mentir.

## 4. Sequência (e como convive com a onda em voo)

A onda `wlglaxd08` (calibrar-vira-modo + anéis) já entrega a **primeira peça de (A)** — Calibrar como
modo que reconfigura o chrome. Ela NÃO se perde; é o piloto do padrão. As fases:

- **F1 — generalizar o padrão de (A)** para Zona e Linha (tirar das abas, painel contextual por modo).
  Depende da onda em voo pousar (mesma região de código).
- **F2 — o painel de observação (B)**: fundir Pessoas/Por quê/Timeline numa superfície não-modal.
- **F3 — o popover de exibição (C)**: unir os toggles hoje partidos entre KPI bar e aba Camadas.
- **F4 — os modais (D)**: ConfigLinhaDialog + migrar "Longo alcance".

## 5. Invariantes / riscos
- **ADR-007**: modos de edição NUNCA viram modal (o mercado confirma, não contradiz). Modais só para
  o que não precisa do vídeo ao vivo.
- **ADR-003**: observação vai para o painel, nunca sobre a imagem; o vídeo é soberano.
- **Ratchet** do `CameraWorkspace.size.test.ts`: extrair, não inchar (a redução das abas ajuda).
- **Regra A18**: o e2e navega por nome acessível — mudar rótulos/estrutura de aba atualiza o spec no
  mesmo PR.
- **Risco de memória muscular**: é uma reorganização real da tela que o operador mais usa. Por isso a
  sequência é incremental (F1..F4), cada fase validável, não um big-bang.

## 6. Fora de escopo
Redesenho visual (a identidade fica); mudar o que cada painel CALCULA; a CineBar/revisão (é um modo
temporal ortogonal, já bem contido).
