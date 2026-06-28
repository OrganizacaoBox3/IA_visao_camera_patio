# Auditoria de UI/UX e Qualidade de Produto — Visão de Pátio (MVP)

> Auditoria baseada **somente na leitura do código** (sem execução em runtime).
> Hipóteses não comprovadas estaticamente estão marcadas como **(a confirmar em runtime)**.
> Referências no formato `arquivo:linha`. Data: 2026-06-28.

---

## 0. Resumo executivo

- **A regressão histórica "Select dentro de Dialog" está RESOLVIDA no código atual.** O dropdown
  do `Select` aparece na frente do modal e o clique funciona. Detalhe técnico abaixo (seção 2.1).
  Não consegui reproduzir estaticamente nenhum modal que simplesmente "não abre".
- **Não há defeito que comprovadamente impeça o uso (bloqueador absoluto)** detectável por leitura.
  O item de maior risco operacional é o **modo demo ligado por padrão** (alertas a cada 10 s),
  que em produção gera alertas/andon/WhatsApp falsos em massa.
- Os problemas reais são de **maturidade**: erros de API que ficam invisíveis ou vazam mensagens
  técnicas, falhas silenciosas (promessas sem `catch`), feedback inconsistente (poucos toasts),
  overlay de câmera que se comporta como modal mas não é acessível, ausência de rota 404 /
  ErrorBoundary, e responsividade mobile limitada.

---

## 1. Inventário de telas e modais

### 1.1 Telas (rotas) — `src/main.tsx:13-26`

| Rota | Componente | Gate | Dentro do AppShell |
|------|------------|------|--------------------|
| `/` | `DashboardPage` (Central de câmeras) | Login humano (`AuthProvider`) | Sim |
| `/relatorio` | `ReportPage` (Relatório Operacional) | Login | Sim |
| `/usuarios` | `UsersPage` | Login + **só superadmin** | Sim |
| `/perfil` | `ProfilePage` (Meu perfil) | Login | Sim |
| `/camera` | `CameraPage` (Nó de câmera) | Token de dispositivo (`?key=`) ou sessão local | **Não** (standalone) |
| — | `LoginScreen` (`src/auth.tsx:37`) | Renderizada quando não há sessão | substitui tudo |

Sub-telas/overlays (não são rotas, mas se comportam como tela cheia):
- **Workspace de câmera "aberta"** — `CameraWorkspace mode="full"` dentro de `.cam-overlay`
  (`DashboardPage.tsx:132-138`).
- **Console do operador (fadiga)** — `FadigaView mode="full"` (idem overlay).

### 1.2 Modais / Dialogs (Radix `Dialog`)

| Modal | Onde abre | Conteúdo | Select interno? |
|-------|-----------|----------|-----------------|
| **Configuração de câmeras** | Dashboard, botão "⚙ Câmeras" (`DashboardPage.tsx:109,141-151`) | tipo de cada câmera (área × operador) | Sim — `aria-label="Tipo da câmera"` |
| **Configurar zona** | Workspace full, botão ⚙ por zona (`CameraWorkspace.tsx:502,582-627`) | nome, modo, parâmetros por modo, slider, chips | Sim — `aria-label="Modo da zona"` + outros |

Diálogos do SO (não-Radix):
- **`confirm()` nativo** para remover usuário (`UsersPage.tsx:100`).

Outras superfícies "tipo modal" que **não** usam o componente `Dialog`:
- `.cam-overlay` (câmera/console em tela cheia) — é uma `<div>` comum, **sem foco preso/ESC**.
- Bloco de revelação de senha (`.users-reveal`, `UsersPage.tsx:114-119`) — inline, não modal.

---

## 2. Itens quebrados ou suspeitos

### 2.1 [RESOLVIDO] "Select abre ATRÁS do overlay do modal" — a regressão citada nos testes

**Sintoma reportado** (e2e `e2e/app.spec.ts:42`): o dropdown do `Select` abria atrás do overlay do
`Dialog` e o clique na opção não pegava.

**Análise da causa-raiz e do estado atual.** O `Select` é portado para o `<body>`
(`src/ui/Select.tsx:17` — `RSelect.Portal`), fora da subárvore do `Dialog` (também portado,
`src/ui/Dialog.tsx:13`). Dois fatores poderiam quebrar:
1. **Z-index** — overlay do dialog `z-index:100` e conteúdo `z-index:101` (`ui.css:125-126`).
   O conteúdo do select tem `z-index:150` (`ui.css:74-76`). Crucial: o Radix Popper **copia o
   z-index computado do conteúdo para o wrapper posicionado** (`node_modules/@radix-ui/react-popper/dist/index.js:228-241`:
   `setContentZIndex(window.getComputedStyle(content).zIndex)` aplicado no
   `[data-radix-popper-content-wrapper]`). Logo o wrapper fica em `z-index:150 > 101` → na frente.
2. **Pointer-events** — quando o `Dialog` modal trava o `body` (`pointer-events:none`), o select
   portado ficaria sem clique. O CSS força `pointer-events:auto` no conteúdo (`ui.css:77`).

**Conclusão:** o defeito está **corrigido** no código atual e coberto por dois testes de regressão
(`e2e/app.spec.ts:30` e `:51`). **(a confirmar em runtime)** — recomendo manter os e2e rodando em CI,
pois a correção depende de um detalhe interno do Radix (cópia do z-index) que pode mudar entre versões;
seria mais robusto fixar `z-index` diretamente em `[data-radix-popper-content-wrapper]`.

### 2.2 [Alto] Modo demo ("Limite curto 10 s") ligado por padrão

- **Arquivo:** `src/routes/DashboardPage.tsx:28` — `useState(true)`.
- **Sintoma:** toda zona de atividade dispara alerta após **10 s** parada (`config.ts:44`,
  `demoIdleAlertMs`), sobrepondo o limite real por área. Cada alerta vira toast **e** `socket.emit("alert")`
  (`DashboardPage.tsx:89-92`) → andon/WhatsApp. Em produção isso gera **alertas falsos em massa** e
  potencial spam de WhatsApp aos destinatários/usuários.
- **Correção:** default `false` em produção (ou derivar de `import.meta.env.DEV`); deixar o switch
  como recurso explícito de demonstração. Persistir a escolha por usuário/sessão.

### 2.3 [Alto] Erros de API no Relatório ficam invisíveis (parecem "sem dados")

- **Arquivos:** `src/routes/ReportPage.tsx:68-73` (`refresh` sem `try/catch`) +
  `src/report/store.ts:20-21,128` (`fetchBuckets`/`fetchEvents`/`clearAll` engolem o erro com
  `.catch(() => [])`).
- **Sintoma:** se a API do hub estiver fora/retornar 5xx, `load*` resolvem vazio → a tela mostra o
  estado "**Sem histórico ainda**" (`ReportPage.tsx:286-292`) **idêntico** ao caso legítimo de ausência
  de dados. O usuário não distingue "quebrado" de "vazio". O `loading` **não** trava (bom), mas a falha
  some.
- **Correção:** propagar um sinal de erro de `store` (ex.: retornar `{data, error}` ou lançar e tratar
  em `refresh` com `try/catch`) e exibir um estado de erro distinto ("Falha ao carregar do histórico —
  tentar novamente"), separado do empty-state.

### 2.4 [Médio] Falhas silenciosas em ações de Usuários/Notificações

- **Toggles de destinatário sem `catch`:** `UsersPage.tsx:217-219`
  (`patchRecipient(...).then(refreshDests)` e `deleteRecipient(...).then(refreshDests)`).
  **Sintoma:** se o PATCH/DELETE falhar, ocorre *unhandled rejection*, a lista não atualiza e o
  usuário **não recebe nenhum aviso**; o `Switch` (controlado por `d.ativo`/`d.somenteCriticos`)
  volta ao estado antigo sem explicação.
- **Pré-visualizar notificação:** `UsersPage.tsx:65` (`onPreview`) — `catch { /* no-op */ }`: clicar
  "Pré-visualizar" pode não fazer nada sem feedback.
- **Limpar histórico:** `ReportPage.tsx:74` + `store.ts:128` — `clearAll` engole erro; "limpar
  histórico" pode falhar silenciosamente.
- **Correção:** padronizar `try/catch` com `toast`/`Alert` de erro em todas as mutações.

### 2.5 [Médio] Botão "Copiar" link de enrolamento sem feedback (e quebra em HTTP)

- **Arquivo:** `src/routes/UsersPage.tsx:130` —
  `onClick={() => navigator.clipboard?.writeText(enrollUrl)}`.
- **Sintoma:** nenhum feedback de sucesso ("copiado!"). Em contexto **não seguro** (HTTP fora de
  localhost) `navigator.clipboard` é `undefined` → o `?.` silencia e o botão **não faz nada**.
- **Correção:** `await` + `toast("Link copiado")`; fallback de seleção/`document.execCommand` ou
  instrução quando a Clipboard API não existir.

### 2.6 [Médio] Status do nó de câmera é enganoso (não reflete o socket)

- **Arquivo:** `src/routes/CameraPage.tsx:53-55,101-108`.
- **Sintoma:** o badge mostra "**transmitindo ao hub**" assim que `getUserMedia` sucede
  (`status="on"`), **independentemente** do socket. Só há handler para `connect_error`
  `unauthorized` (`:55`) — não há tratamento de `disconnect`/reconexão. Se o hub cair, a câmera
  continua dizendo que transmite, sem indicar a perda de conexão.
- **Correção:** derivar o status também de eventos `connect`/`disconnect`/`reconnect_attempt` do
  socket; mostrar "reconectando…" e diferenciar "câmera ok, hub offline".

### 2.7 [Médio] Overlay de câmera/console em tela cheia não é um modal acessível

- **Arquivo:** `src/routes/DashboardPage.tsx:132-138` (`.cam-overlay`).
- **Sintoma:** comporta-se como modal (cobre a tela), mas é uma `<div>` sem `role="dialog"`,
  **sem foco preso, sem fechar no ESC e sem `aria-modal`**. Só fecha pelo botão "✕"
  (`CameraWorkspace.tsx:485`, `FadigaView.tsx:167`). Teclado/leitor de tela ficam presos no fundo.
- **Correção:** adicionar ESC para fechar e gerência de foco (ou portar para o componente `Dialog`
  com conteúdo full-bleed), e `aria-modal`/rótulo.

### 2.8 [Médio] Sem rota 404 / ErrorBoundary / errorElement

- **Arquivo:** `src/main.tsx:13-26` — router sem `path: "*"` nem `errorElement`; não há ErrorBoundary
  global em `:28-30`.
- **Sintoma:** URL desconhecida ou erro de render → tela de erro padrão do React Router / tela branca,
  sem identidade do produto nem caminho de recuperação.
- **Correção:** rota catch-all com página "404 / não encontrado", `errorElement` por árvore e um
  ErrorBoundary com mensagem amigável + "recarregar".

### 2.9 [Médio] Mensagens de erro técnicas vazando ao usuário

- **Arquivo:** `src/api.ts:14-18` — em falha sem corpo, `msg = "HTTP <status>"`.
- **Onde aparece:** `UsersPage` (`Alert tone="alert">{err}`, `:120`) e `ProfilePage` (`:83`) exibem
  essa string crua. O usuário final pode ver "HTTP 500", "HTTP 403" etc.
- **Correção:** mapear status → mensagens em pt-BR ("Sem permissão", "Falha no servidor, tente
  novamente"), preservando o detalhe técnico só em log.

### 2.10 [Baixo/Médio] `confirm()` nativo para exclusão

- **Arquivo:** `src/routes/UsersPage.tsx:100`.
- **Sintoma:** diálogo do navegador (fora do design system); pode ser suprimido pelo usuário/navegador
  ("não exibir mais"), inconsistente visualmente e bloqueante.
- **Correção:** modal de confirmação com o componente `Dialog` (variante de ação destrutiva).

### 2.11 [Baixo] Referência ARIA pendente no Dialog

- **Arquivo:** `src/ui/Dialog.tsx:15` — quando **não** há `description`, define
  `aria-describedby="ui-dialog-no-desc"`, **id que não existe** no DOM → referência ARIA "quebrada".
- **Correção:** omitir `aria-describedby` quando não houver descrição (deixar `undefined`).

### 2.12 Verificações que passaram (sem defeito)

- **Botões sem handler:** não encontrados; todos os botões auditados têm `onClick`/`type=submit`.
- **Guards de rota/papel:** `AuthProvider` (`auth.tsx:33`) e gate de superadmin no rail
  (`AppShell.tsx:22`) e na própria `UsersPage` (`:76-78`) — coerentes.
- **Aquisição de câmera:** robusta, com erros granulares e contexto seguro (`camera/acquire.ts`).
- **Estabilidade de hooks no Relatório:** memos sempre computados para manter ordem de hooks
  (`ReportPage.tsx:76+`) — correto.
- **Resiliência do loop de vídeo:** `record*` são fire-and-forget e nunca lançam (`store.ts:16-19`).

---

## 3. Lacunas de maturidade de produto

### 3.1 Estados de loading / vazio / erro
- **Relatório:** tem `Skeleton` (`ReportPage.tsx:280-285`) e empty-state (`:286-292`), mas **não tem
  estado de erro** (ver 2.3).
- **Perfil:** sem skeleton — o formulário aparece com campos vazios até `getMe` resolver
  (`ProfilePage.tsx:26-31`); um erro de carga vira `Alert` mas os campos seguem editáveis "vazios".
- **Dashboard:** não há estado "conectando ao hub" — mostra "Nenhuma câmera conectada"
  (`DashboardPage.tsx:118-124`) mesmo antes de o socket conectar; pode confundir.
- **Usuários:** skeleton de linhas ok (`UsersPage.tsx:258`); seções de WhatsApp tratam estados
  (desligado/QR/conectado), bom.

### 3.2 Feedback / toasts
- O `toast` (`useToast`) só é usado no **Dashboard** para alertas (`DashboardPage.tsx:90`).
- Demais ações usam `Alert` inline ou `span` de status (`prof-ok`, `meta-text`) — **inconsistente**;
  e algumas ações **não dão feedback algum** (copiar link 2.5; toggles 2.4).
- **Recomendação:** padronizar confirmação de sucesso/erro via `toast` para todas as mutações
  (salvar perfil, criar/editar/remover usuário e destinatário, salvar notificações, copiar, limpar
  histórico).

### 3.3 Acessibilidade
- Pontos fortes (já presentes): skip-link e foco ao trocar de rota (`AppShell.tsx:12,17`),
  foco visível global (`ui.css:8-11`), `aria-label`/`title` nos ícones, `aria-live` nas estatísticas
  do hub (`DashboardPage.tsx:111`), Dialog com foco preso/ESC (Radix).
- Lacunas:
  - Overlay de câmera não-modal (2.7).
  - Referência ARIA pendente no Dialog (2.11).
  - **Chips toggle sem `aria-pressed`**: classes de objeto e tipos
    (`CameraWorkspace.tsx:615-617`, `ProfilePage.tsx:72-74`, `FadigaView.tsx:199-201`) usam
    `<button class="...on">` sem estado acessível.
  - **Tooltip sobre `<span>` não focável** (`DashboardPage.tsx:106-108`) → dica não aparece via
    teclado.
  - Heatmaps/tabelas são puramente visuais (cor); o `title` por célula ajuda, mas não há resumo
    textual/`<caption>` para leitor de tela.

### 3.4 Responsividade
- A media query cobre pouco (`ui.css:175-180`: segmented com scroll, filtros com wrap, dialog 96vw).
- **Riscos (a confirmar em runtime):** heatmap de **24 colunas** (`ReportPage.tsx:357+`) e tabelas
  `.rtable` tendem a estourar no mobile; o `cam-stage` + `cam-drawer` lateral é claramente
  desktop-first; o rail lateral não tem versão compacta/bottom-nav.

### 3.5 Consistência visual
- Mistura de padrões de feedback (toast vs. `Alert` vs. `span` de status).
- Ícones via emoji (⚙ 📊 👤 ⎙ ↻ 🎲) — aceitável para MVP, mas variam de render por SO; um set de
  ícones SVG daria acabamento mais "produto".
- O design system em `src/ui/*` é coeso e bem fatorado (bom ponto de partida).

### 3.6 Mensagens técnicas / i18n
- Vazamento de "HTTP <status>" (2.9).
- **Sem camada de i18n** — todas as strings hardcoded em pt-BR; datas/locale fixos em `"pt-BR"`.
  Aceitável se o produto é pt-BR único; vira dívida se houver expansão.

---

## 4. Tabela priorizada de defeitos

| # | Severidade | Item | Arquivo:linha | Esforço |
|---|-----------|------|---------------|---------|
| 2.2 | **Alto** (bloqueador operacional em prod) | Modo demo (10 s) ligado por padrão → alertas/WhatsApp falsos | `DashboardPage.tsx:28`; `config.ts:44` | XS (1 linha + guard env) |
| 2.3 | **Alto** | Erro de API no Relatório indistinguível de "sem dados" | `ReportPage.tsx:68-73`; `store.ts:20-21` | M |
| 2.6 | Médio | Status do nó de câmera não reflete o socket | `CameraPage.tsx:53-55,101-108` | S |
| 2.7 | Médio | Overlay de câmera full não é modal acessível (ESC/foco) | `DashboardPage.tsx:132-138` | M |
| 2.4 | Médio | Falhas silenciosas em mutações (sem `catch`/feedback) | `UsersPage.tsx:217-219,65`; `ReportPage.tsx:74` | S |
| 2.5 | Médio | "Copiar" sem feedback e quebra em HTTP | `UsersPage.tsx:130` | XS |
| 2.8 | Médio | Sem 404 / ErrorBoundary / errorElement | `main.tsx:13-30` | S |
| 2.9 | Médio | Mensagens técnicas ("HTTP 500") vazando | `api.ts:14-18`; `UsersPage.tsx:120`; `ProfilePage.tsx:83` | S |
| 3.4 | Médio | Responsividade mobile (heatmap/tabelas/drawer) *(a confirmar)* | `ui.css:175-180`; `ReportPage.tsx:357+` | M-L |
| 3.2 | Médio | Feedback inconsistente (poucos toasts) | vários | M |
| 2.10 | Baixo | `confirm()` nativo para excluir usuário | `UsersPage.tsx:100` | S |
| 3.3 | Baixo | A11y: `aria-pressed` nos chips, tooltip não focável | `CameraWorkspace.tsx:615`; `ProfilePage.tsx:72`; `DashboardPage.tsx:106` | S |
| 2.11 | Baixo | Referência ARIA pendente no Dialog sem descrição | `Dialog.tsx:15` | XS |
| 3.6 | Baixo | Sem i18n (strings/locale hardcoded) | global | L |

Esforço: XS (<1 h) · S (algumas horas) · M (1-2 dias) · L (semana+).

**Bloqueadores absolutos (impedem o uso):** nenhum confirmado por análise estática. O item 2.2 é
classificado como **bloqueador operacional para produção** (impacto alto em alertas reais), não como
falha funcional da UI.

---

## 5. Top 10 recomendações para "parecer produto maduro"

1. **Desligar o modo demo por padrão em produção** (2.2) e tratá-lo como recurso explícito de
   demonstração, persistido por usuário.
2. **Padronizar tratamento de erro + feedback:** um helper que envolve toda mutação de API e dispara
   `toast` de sucesso/erro, com mapeamento de status → mensagens humanas em pt-BR (resolve 2.3, 2.4,
   2.5, 2.9 de uma vez).
3. **Estado de erro distinto no Relatório** (e nas demais cargas), separado do empty-state, com botão
   "tentar novamente" (2.3).
4. **404 + ErrorBoundary global** com identidade visual e caminho de recuperação (2.8).
5. **Tornar o overlay de câmera um modal de verdade:** ESC para fechar, foco preso e `aria-modal`
   (2.7) — preferencialmente reaproveitando o componente `Dialog`.
6. **Status de conexão real no nó de câmera** (connect/disconnect/reconnect), com "reconectando…"
   (2.6).
7. **Auditar responsividade mobile**: heatmaps com scroll horizontal, tabelas em modo card, e uma
   navegação compacta/bottom-nav para o rail (3.4).
8. **Substituir `confirm()` por modal de confirmação destrutiva** do design system, padronizando
   ações de risco (2.10).
9. **Acessibilidade fina:** `aria-pressed` nos chips toggle, tooltips em elementos focáveis, corrigir
   a referência ARIA do Dialog e dar resumo textual aos heatmaps (2.11, 3.3).
10. **Manter os e2e de regressão (Select-em-Dialog) no CI** e, por robustez, fixar `z-index`
    diretamente em `[data-radix-popper-content-wrapper]` em vez de depender da cópia interna do Radix
    (2.1).

---

### Anexo — observação sobre os testes e2e
`e2e/app.spec.ts` faz **login real** (`/api/login`) e conecta uma **câmera fake** (`?key=e2e-cam`),
portanto exige o hub no ar. Os seletores conferem com a UI (`title="Abrir câmera"` no tile
`CameraWorkspace.tsx:460`; `aria-label="Configurar zona"` em `:502`; `aria-label="Modo da zona"` em
`:592`; `aria-label="Tipo da câmera"` em `DashboardPage.tsx:147`; zonas-semente garantidas por
`loadZones`/`config.defaultZones`, `zones.ts:66`). Os dois testes de regressão de Select-em-Dialog
devem passar com o código atual.
