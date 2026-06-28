# Frontend — Telas, Componentes de UI e Fluxo de Usuário

> Documento gerado a partir da leitura do código-fonte do MVP de visão computacional
> (frontend React + Vite). Cobre o mapa de rotas, cada tela, os workspaces de câmera,
> a biblioteca de UI baseada em Radix, a tela e geração de relatórios, e o fluxo de
> autenticação/perfis/usuários do ponto de vista da interface.
>
> Todas as referências são no formato `caminho:linha` relativas à raiz do projeto.

---

## 1. Visão geral da arquitetura de UI

A aplicação é uma SPA React montada com `react-router-dom` (`createBrowserRouter`). Há
**duas árvores distintas** de interface, com propósitos e modelos de autenticação diferentes:

1. **Painel humano** (a "Central") — gateado por login de usuário/senha. Engloba o
   Dashboard, o Relatório, a administração de Usuários e o Perfil. Vive dentro do
   `AppShell` (rail lateral + área de conteúdo).
2. **Nó de câmera** (`/camera`) — fica **fora** do login humano e fora do `AppShell`.
   É a visão do dispositivo que captura e transmite frames; autentica por token de
   dispositivo (`?key=`) ou pela sessão de um usuário logado no mesmo navegador.

O entrypoint é `src/main.tsx`, que envolve toda a aplicação nos providers globais de
Tooltip e Toast e injeta o `RouterProvider`:

```
<TooltipProvider><ToastProvider><RouterProvider router={router} /></ToastProvider></TooltipProvider>
```

Referência: `src/main.tsx:28-30`.

### Providers globais (raiz)

| Provider          | Origem                       | Papel                                                        |
|-------------------|------------------------------|-------------------------------------------------------------|
| `TooltipProvider` | `src/ui/Tooltip.tsx:5`       | Habilita tooltips Radix em toda a app (`delayDuration=300`). |
| `ToastProvider`   | `src/ui/Toast.tsx:16`        | Fila de toasts + contexto `useToast` (duração 5000 ms).     |
| `AuthProvider`    | `src/auth.tsx:26`            | Gate de login do painel humano (envolve só o `AppShell`).   |

---

## 2. Mapa de navegação / rotas

Definição em `src/main.tsx:13-26`.

| Rota          | Componente               | Gate / contexto                                  | Dentro do AppShell? |
|---------------|--------------------------|--------------------------------------------------|---------------------|
| `/`           | `DashboardPage`          | `AuthProvider` (login humano)                    | Sim                 |
| `/relatorio`  | `ReportPage`             | `AuthProvider`                                   | Sim                 |
| `/usuarios`   | `UsersPage`              | `AuthProvider` + só renderiza p/ `superadmin`    | Sim                 |
| `/perfil`     | `ProfilePage`            | `AuthProvider`                                   | Sim                 |
| `/camera`     | `CameraPage`             | Token de dispositivo (`?key=`) ou sessão local   | **Não** (standalone)|

Estrutura do router (resumida):

```
createBrowserRouter([
  {
    element: <AuthProvider><AppShell /></AuthProvider>,   // painel humano
    children: [ "/", "/relatorio", "/usuarios", "/perfil" ]
  },
  { path: "/camera", element: <CameraPage /> }            // nó de câmera (fora do login)
])
```

### O AppShell (casca persistente)

`src/components/AppShell.tsx` define a casca da SPA: um **rail lateral slim** (`<nav>`
rotulado) + uma `<main>` que renderiza o `<Outlet/>` das rotas filhas.

- Itens de navegação via `NavLink` (`src/components/AppShell.tsx:20-23`): Central (`/`),
  Relatório (`/relatorio`), Usuários (`/usuarios`, **só para superadmin** — linha 22),
  Meu perfil (`/perfil`).
- Botão "Sair" no rodapé do rail chama `logout()` (`src/components/AppShell.tsx:25`).
- **Acessibilidade**: skip-link "Pular para o conteúdo" (`:17`), `<nav aria-label>`, e o
  foco é movido para `<main>` a cada troca de rota (`useEffect` em `pathname`, `:12`),
  comportamento correto para navegação SPA.

### Hierarquia de componentes (alto nível)

```
main.tsx
└─ TooltipProvider
   └─ ToastProvider
      └─ RouterProvider
         ├─ AuthProvider               (login gate)
         │  └─ AppShell                (rail + <main><Outlet/></main>)
         │     ├─ DashboardPage  ──►  CameraWorkspace | FadigaView  (tile/full)
         │     ├─ ReportPage     ──►  report/mock (cálculos) + report/csv (export)
         │     ├─ UsersPage      ──►  api.ts (CRUD usuários/destinatários/WhatsApp)
         │     └─ ProfilePage    ──►  api.ts (getMe/updateMe)
         └─ CameraPage                 (standalone, fora do AppShell)
```

---

## 3. Fluxo de autenticação (do ponto de vista da UI)

Arquivo: `src/auth.tsx`.

### Modelo

- Login multi-usuário (usuário + senha) validado **no hub** via `POST /api/login`
  (`src/auth.tsx:48`). O servidor devolve `{ token, user }`; a senha nunca persiste no
  cliente.
- A sessão é guardada em `localStorage` sob a chave `vp-auth`
  (`src/auth.tsx:8`, `:30`).
- `AuthUser` tem papel `"superadmin" | "usuario"` (`src/auth.tsx:9-10`), usado para
  habilitar áreas (ex.: a aba Usuários).
- O contexto expõe `{ token, user, logout }` via `useAuth()` (`src/auth.tsx:17-24`).

### Comportamento de gate

`AuthProvider` (`src/auth.tsx:26-35`):
- Se **não há sessão**, renderiza a `LoginScreen` no lugar de tudo (`:33`).
- Se há sessão, provê o contexto e renderiza os filhos (o `AppShell`).
- `logout(reason?)` remove a sessão e pode exibir um motivo (ex.: "Sessão expirada")
  na tela de login (`:31`). O Dashboard chama `logout("Sessão expirada…")` quando o
  socket recebe `connect_error: unauthorized` (`src/routes/DashboardPage.tsx:37`).

### Tela de login (`LoginScreen`, `src/auth.tsx:37-73`)

- Card centralizado (`.login-screen` / `.login-card`) com marca "▣ Visão de Pátio".
- Usa os componentes do design system: `Field` + `Input` para usuário e senha, `Button`
  primário em bloco. O erro é exibido no `Field` da senha (`:66`).
- Estados locais: `usuario`, `senha`, `busy`, `err`. Submit desabilitado enquanto vazio
  ou em andamento; mensagens distintas para credenciais inválidas vs. falha de conexão
  (`:52`, `:55`).

---

## 4. Telas (rotas)

### 4.1 DashboardPage — "Central de câmeras" (`/`)

Arquivo: `src/routes/DashboardPage.tsx`.

**Propósito.** É a central de monitoramento: conecta-se ao hub por WebSocket como
`role: "dashboard"`, recebe a lista de câmeras e os frames, e renderiza cada câmera como
um *tile*; ao abrir uma câmera, mostra-a em overlay de tela cheia.

**Conexão e dados.**
- Socket `socket.io-client` com `auth: { token }` e `query: { role: "dashboard" }`
  (`:33`). Eventos tratados: `connect`/`disconnect` (estado `connected`), `connect_error`
  (logout se `unauthorized`), `cameras` (lista) e `frame` (`:35-44`).
- Frames JPEG binários chegam por `frame` e são decodificados **fora da main thread** em
  `ImageBitmap` via `createImageBitmap` (`drainDecode`, `:49-57`), mantendo só o último
  frame por câmera (descarta atrasados). Cada câmera expõe um *getter* estável de
  `FrameSource` consumido pelas views (`getterFor`, `:70-77`).

**O que exibe / interações (cabeçalho — `:103-115`).**
- Título "Central de câmeras".
- `Switch` "Limite curto (10s)" (`demoMode`) dentro de um `Tooltip` explicativo — encurta
  o limite de parada para demonstração ao vivo.
- Botão "⚙ Câmeras" → abre o modal de configuração de tipo de câmera.
- Link "+ Nó de câmera" → abre `/camera` em nova aba (`camNodeUrl`, `:86`).
- Estatísticas ao vivo (`aria-live="polite"`): estado do hub e número de câmeras.

**Grade / estados (`:117-129`).**
- Vazio: bloco `.dash-empty` com instruções de como abrir um nó de câmera e o endereço
  do hub.
- Com câmeras: grade responsiva cujo número de colunas vem de `colsFor(n)` (1→1, 2→2,
  ≤6→3, senão 4; `:16`).

**Renderização por câmera (`renderTile`, `:94-99`).** Cada câmera é roteada por **tipo**:
- Tipo "fadiga" (operador) → `FadigaView` em `mode="tile"`.
- Caso contrário → `CameraWorkspace` em `mode="tile"` (passando `demoMode`).
- A câmera atualmente aberta mostra um placeholder "aberta no painel" no lugar do tile
  (`:95`).

**Overlay de câmera aberta (`:132-138`).** Quando `openId` está setado, renderiza a view
correspondente em `mode="full"` dentro de `.cam-overlay` (Workspace ou FadigaView).

**Modal de configuração de câmeras (`Dialog`, `:141-151`).** Para cada câmera, um
`Select` define se é "Câmera de área (zonas)" ou "Operador (fadiga)". A escolha é
persistida via `setCameraCfg` e reflete em `cfgs` (`setKind`, `:81-83`).

**Alertas (`handleAlert`, `:89-92`).** Mensagens de alerta vindas das views disparam um
`toast` (tom `alert` se a mensagem contém "⚠") **e** são repassadas ao hub via
`socket.emit("alert", …)` (andon → webhook externo, se configurado).

**Config por câmera.** `src/cameraConfig.ts` persiste por câmera em `localStorage`
(`vp-camcfg-<id>`) o `CameraCfg = { modo, pontoLeitura, capture, selectedClasses }`,
com defaults e validação defensiva (`getCameraCfg`/`setCameraCfg`, `:16-33`). O default de
modo é "atividade" (retrocompatível).

---

### 4.2 ReportPage — "Relatório Operacional" (`/relatorio`)

Arquivo: `src/routes/ReportPage.tsx` (a maior tela da app). Veja também a seção 7.

**Propósito.** Apresenta indicadores **agregados** (nunca imagens — LGPD) em cinco
dimensões: Resumo executivo, Atividade, Leitura, Objetos e Operador (fadiga). Suporta
filtros, heatmaps, rankings, tendência, tabela de eventos, exportação CSV e impressão PDF.

**Carregamento (`refresh`, `:68-73`).** Em paralelo (`Promise.all`) carrega todos os
datasets e eventos do histórico via `report/store` (`loadDataset`, `loadEvents`,
`loadReadingDataset`, … `loadFadigaEvents`). Estados de `loading`/`busy`.

**Filtros (cabeçalho `:244-271`).**
- `SegmentedControl<Mode>` para escolher a dimensão (Resumo/Atividade/Leitura/Objetos/
  Operador) — `:246`.
- `SegmentedControl<Period>` para o período (Hoje / 7d / 30d) — `:255`.
- `Select` de turno (Todos/Manhã/Tarde/Noite) — `:256`.
- `Select` contextual de filtro: área / ponto / setor / posto, conforme o modo
  (`:257-265`).
- Ações: recarregar (`IconButton ↻`), alternar "Apresentação" (classe `.present`),
  "⬇ CSV" (`downloadCSV`) e "⎙ PDF" (`printPDF`).

**Cálculos (memos).** Todos os indicadores são derivados via funções puras de
`report/mock` dentro de `useMemo` para estabilidade de hooks — por exemplo `windows`,
`kpis`, `heatmap`, `ranking`, `evolution`, `insights` para Atividade (`:79-101`) e os
equivalentes `reading*`, `object*`, `fadiga*` (`:104-157`). Observação importante: os
hooks são **sempre computados** independentemente do modo ativo, para manter a ordem de
hooks estável (comentário em `:76`).

**Renderização por modo.**
- **Resumo** (`:294-339`): quatro `resumo-card` clicáveis (Operação, Segurança, Logística,
  Objetos) que ao clicar trocam o `mode`. Inclui uma faixa "Destaques" combinando os
  primeiros insights de cada dimensão.
- **Atividade** (`:341-410`), **Leitura** (`:412-481`), **Objetos** (`:483-557`),
  **Fadiga** (`:559-608`): cada um exibe uma linha de KPIs (`.kpi big` com `<Delta>`),
  uma faixa de insights, um `SegmentedControl` de sub-abas (`tab`) e os painéis:
  - "Quando" → **heatmap** hora × (área/ponto/classe/posto) com cor por intensidade
    (`heatColor`/`readColor`, `:28-38`).
  - "Onde" / "Setor × Classe" → rankings em barras e matrizes.
  - "Tendência" → gráfico de 14 dias (`.evo`).
  - "Eventos"/"Leituras"/"Ocorrências" → tabela `.rtable`.
- Estados auxiliares: `loading` mostra `Skeleton`s (`:280-285`); `noData` mostra um bloco
  explicativo por dimensão (`:286-292`).

**Componente local `Delta`** (`:40-44`): indicador de variação percentual com seta
▲/▼ e classe `good`/`bad` (parametrizável por `goodWhenDown`).

**Impressão (`printPDF`, `:240`).** Define o carimbo `printedAt`, e dispara
`window.print()` após um curto timeout. Há um cabeçalho `.print-head.only-print`
(`:273-277`) e várias seções marcadas `.no-print` para o layout de impressão.

**Limpar histórico (`onClear`, `:74`).** Botão `linkbtn` no rodapé chama `clearAll()`
(POST `/api/data/clear`) e recarrega.

---

### 4.3 UsersPage — "Usuários" (administração, `/usuarios`)

Arquivo: `src/routes/UsersPage.tsx`.

**Propósito.** Painel **exclusivo do superadmin** (gate em `:76-78`: usuários comuns veem
um `EmptyState` "Acesso restrito"). Concentra três seções, alternadas por um
`SegmentedControl` (`secao`: `usuarios` | `notificacoes` | `cameras`, `:122-123`).

**Carga e polling (`:41-51`).** Ao montar (se superadmin), carrega usuários, o token de
enrolamento de câmera, destinatários e configurações de notificação; e faz **polling a
cada 5 s** do status do WhatsApp (`getWaStatus`) para atualizar QR/conexão.

**Seção "Câmeras" (`:125-136`).** Mostra o **link de enrolamento** de câmera
(`/camera?key=<token>`, `:74`) com `Input` somente-leitura + botão "Copiar"
(`navigator.clipboard`). Se não há `CAMERA_TOKEN` no hub, exibe instrução.

**Seção "Notificações" (`:138-226`).**
- **WhatsApp (andon)**: indicador de estado (`wa-dot` on/wait/off). Conforme o estado,
  mostra: desligado, conectado (com teste de envio), QR de pareamento (`<img>` do QR,
  `:153`) ou "iniciando".
- **Mensagens & alertas**: edita `NotifSettings` (marca, incluir local/hora/rodapé) e,
  por tipo de evento, ativa/edita título e instrução (`Switch` + `Input`s, `:174-185`).
  Botões "Salvar" e "Pré-visualizar" (preview renderizado em `<pre>`).
- **Destinatários do WhatsApp**: formulário para adicionar (nome/número/só-críticos) e
  uma tabela `.rtable` com toggles `Switch` (só críticos / ativo) e remoção por linha
  (`:200-226`).

**Seção "Usuários" (`:228-263`).**
- **Novo usuário**: `Input` de usuário, `Input` de senha com `IconButton 🎲` para gerar
  senha (`genSenha`, sem caracteres ambíguos, `:11-15`), `Select` de papel, botão "Criar".
- **Lista**: tabela com `Select` de papel inline, `Switch` ativo/inativo, "Resetar senha"
  e "Remover" (desabilitado para o próprio usuário). Linhas de `Skeleton` durante o load.
- **Reveal de senha** (`:114-119`): ao criar/resetar, a senha aparece **uma única vez**
  num bloco `.users-reveal` para o admin copiar (modelo de reset seguro — a senha só
  existe como hash no servidor).
- Confirmação nativa (`confirm`) ao remover usuário (`:100`).

Todas as operações usam o cliente `src/api.ts` (`listUsers`, `createUser`, `patchUser`,
`deleteUser`, `listRecipients`, `getWaStatus`, `saveNotifSettings`, etc.).

---

### 4.4 ProfilePage — "Meu perfil" (`/perfil`)

Arquivo: `src/routes/ProfilePage.tsx`.

**Propósito.** Qualquer usuário cadastra o **próprio número de WhatsApp** que recebe os
alertas, com preferências e **opt-in (LGPD)**.

**O que exibe / interações.**
- Seção "Conta": usuário e papel atuais (do `useAuth`, `:54-56`).
- Formulário "Notificações por WhatsApp" (`:58-85`):
  - `Field` + `Input` do número (com DDD).
  - `CheckboxRow` de **consentimento (opt-in)** — registra o consentimento; o servidor
    grava `optInEm`.
  - `CheckboxRow` "Receber alertas" (pausar sem apagar o número) e "Apenas alertas
    críticos".
  - Chips de **tipos** de alerta (atividade/fadiga/objetos/leitura) — toggle por
    `toggleTipo` (`:33-35`); vazio = todos.
  - Botão "Salvar" + indicador de estado derivado `willReceive` (opt-in && ativo &&
    número com ≥10 dígitos, `:47`).
  - `Alert` de sucesso/erro e data do consentimento registrado.
- Carrega via `getMe()` e salva via `updateMe()` (`src/api.ts:31-32`).

---

### 4.5 CameraPage — Nó de câmera (`/camera`, standalone)

Arquivo: `src/routes/CameraPage.tsx`.

**Propósito.** É a visão do **dispositivo de captura** (webcam/celular). Apresenta apenas
o feed (sem controles de análise) e **envia frames** ao hub. Roda fora do login humano e
fora do `AppShell`.

**Autenticação de dispositivo (`cameraToken`, `:8-12`).** Usa `?key=<CAMERA_TOKEN>` da URL
(enrolamento) ou, em fallback, o token da sessão `vp-auth` de um humano logado no mesmo
navegador.

**Identidade da câmera (`:27-33`).** Gera/recupera um `camId` em `sessionStorage`
(`crypto.randomUUID`); o `name` vem de `?name=` ou é derivado do id.

**Captura e transmissão (`useEffect`, `:35-95`).**
- Adquire o stream com `acquireCameraStream()` (contexto seguro + escada de constraints +
  erros granulares, `src/camera/acquire`). Estados: `connecting | on | denied | error`.
- Conecta ao hub como `role: "camera"` com `id` e `label`; trata `connect_error`
  `unauthorized` com mensagem para abrir pelo link de enrolamento ou logar (`:55`).
- Loop de envio (`sendFrame`, `:63-76`): desenha o vídeo num canvas oculto e emite
  **JPEG binário** (não base64) via `socket.emit("frame", …)`, com *back-pressure*
  (descarta frame se o encode anterior não terminou).
- Perfil de captura ajustável pela central via evento `capture` (largura/qualidade/fps),
  exibido no badge (`:81-86`).

**UI (`:97-113`).** `<video>` + `<canvas display:none>`, um badge com `dot-status`,
nome, estado textual e perfil; aviso se o contexto não for seguro (sem HTTPS) e mensagem
de erro. Nenhum controle de análise — "processamento e controles ficam na central".

---

## 5. CameraWorkspace — orquestração de câmera + modos (UI)

Arquivo: `src/CameraWorkspace.tsx` (~630 linhas). É o componente central da Central para
câmeras "de área".

**Conceito.** UMA câmera, VÁRIAS zonas, cada zona com seu próprio **modo**
(`atividade` | `leitura` | `objetos` | `fadiga`). Cada zona roda seu processador na sua
ROI; o componente compõe o overlay (canvas) e o painel num único lugar
(comentário em `:26-27`).

**Props (`:75-84`).** `cameraId`, `label`, `getFrame()` (fonte do frame), `mode`
(`"tile" | "full"`), `demoMode`, e callbacks `onOpen`/`onClose`/`onAlert`.

**Loop de render (`useEffect` + `requestAnimationFrame`, `:190-288`).** A cada frame:
1. Mede FPS (`FrameMeter`). Se pausado, congela (não processa nem redesenha, `:202`).
2. Nível de frame: calcula luma para *motion* e roda detecção `coco-ssd` **fora da main
   thread** (worker) só se houver zona de atividade; cadência mais rápida + *tiling* na
   câmera aberta (`mode==="full"`) vs. mais lenta nos tiles (`:207-224`).
3. Rastreio anônimo de pessoas (`updateTracks`, `:170-184`) — IDs efêmeros, base da aba
   "Presença".
4. **Por zona** (`:235-268`): obtém o processador via `holderFor` (recria se o modo mudou)
   e despacha para o pipeline correspondente:
   - `atividade` → `AtividadeProcessor` (estado, pessoas, parada, fluxo); emite samples,
     eventos para a timeline e **alertas** (`onAlert` + `recordAlert`).
   - `leitura` → `LeituraProcessor` (códigos de barras, taxa, no-reads); grava leituras e
     passagens (`recordReads`/`recordPass`).
   - `objetos` → `ObjetosProcessor` (contagem por classe); grava amostras/eventos.
   - `fadiga` → recorta a ROI da zona (`cropFor`, cap ~480px, `:151-159`) e roda o
     `FadigaProcessor` nela (1 operador por zona).
5. Persiste samples agregados periodicamente (`recordSamples`, throttle 3 s, `:272`).
6. Desenha a cena (`drawScene`) e atualiza o painel/perf/presença em cadência reduzida
   (`:276-283`).

**Desenho do overlay (`drawScene`, `:290-369`).** Respeita DPR; calcula o "content rect"
(letterbox) com `getContentRect`; desenha o frame, as bboxes de pessoas (com rótulos
detalhados quando pausado), e por zona pinta o retângulo/máscara na cor do modo, rótulos
de estado, e overlays específicos (bboxes de objetos, landmarks de fadiga via
`drawFadigaZone`, `:58-71`). Também desenha a grade ao pintar máscara e o retângulo em
arrasto.

**Editor de zonas (UI no `mode="full"`).**
- Desenhar zona: alterna `drawMode`, arrasta um retângulo no viewport (`onDown`/`onMove`/
  `onUp`, `:410-429`); cria `Zone` com defaults e persiste (`saveZones`).
- Pintar área irregular ("blueprint" em grade): `startPaint` ativa a máscara; pincel
  (`🖌`)/borracha (`🧽`), tamanho do pincel via `Select` (1×/2×/3×), "Limpar" e
  "✓ Concluir" (`:476-481`). Máscaras são codificadas/decodificadas com `zoneMask`.
- Pausar (`⏸`) congela o frame para inspeção e rotula quem está em cena (`:483`).

**Painel lateral (drawer, `mode="full"`, `:491-570`).** `SegmentedControl` com três abas:
- **Zonas**: card por zona com badge de modo, ⚙ (configurar), 🖌 (pintar) e ✕ (remover);
  KPIs específicos por modo (estado/pessoas/parada; taxa/lidas-min/no-reads; chips de
  contagem; risco/EAR/📱). Inclui **legenda do overlay** dinâmica (`legend`, `:441-454`).
- **Timeline**: lista de eventos recentes com severidade.
- **Presença**: KPIs agora/pico/permanência (tracks anônimos).

**Barra de KPI inferior (`:573-580`)** e **Dialog de configuração de zona**
(`:582-627`): nome, modo (`Select`), e campos contextuais — atividade/limite/sensibilidade
(`Slider`), ponto de leitura, classes de objeto (chips), e nota para fadiga.

**Modo "tile" (`:457-468`).** Versão compacta: viewport + badge de alertas + rodapé com
nome e número de zonas; clicar abre a câmera (`onOpen`).

---

## 6. FadigaView — monitor de operador

Arquivo: `src/FadigaView.tsx`. É a view dedicada para câmeras marcadas como "Operador
(fadiga)". É descrita como "casca fina": o pipeline (Face/Hand/coco) e o motor de risco
vivem em `FadigaProcessor`; a view cuida de feed/overlay, painel, beep e telemetria
(comentário `:11-13`).

**Props (`:19-29`).** Além de `cameraId`/`label`/`getFrame`/`mode`/`onOpen`/`onClose`/
`onAlert`, recebe `onSample`/`onEvent` (que o Dashboard liga a `recordFadigaSamples`/
`recordFadigaEvent`, ver `src/routes/DashboardPage.tsx:97`/`:135`).

**Loop (`:92-136`).** Processa o frame no `FadigaProcessor`, alimenta os medidores
(`FrameMeter` para face/mãos/celular), desenha a cena (`drawFadigaScene`), encaminha
eventos/amostras e gerencia o **alarme sonoro** e o "gesto-como-ação":
- Só a câmera aberta (`mode==="full"`) emite beep (`beep`, `:75-90`), com cooldown.
- Em alerta, repete o beep até voltar a OK; o gesto 👍 (JOINHA) "reconhece" o episódio e
  silencia até OK (`ackRef`, `:116-121`); o mute silencia sempre.
- A UI é atualizada em cadência reduzida (140 ms em full, 350 ms em tile, `:123-131`).

**Modo tile (`:142-158`).** Card com viewport, badge de risco e ícone 📱, rodapé com EAR
e sinal/contagem de mãos. Cor do card por estado de risco (`RISK_CLS`).

**Modo full — "console do operador" (`:161-228`).**
- Cabeçalho com badge de status e fechar.
- Stage com `<canvas overlay>` e um **drawer** lateral com: Risco/EAR/MAR (bocejo),
  Sinais (celular/gesto/modelo facial), Ocorrências (contadores), Controles (mute,
  toggles de detectores Face/Mãos/Celular/Risco via chips, dica do gesto), e
  **Calibração** (sliders por limiar via `FADIGA_THRESHOLD_FIELDS`, com "Restaurar
  padrão"). Os limiares persistem (`loadFadigaThresholds`/`saveFadigaThresholds`, `:67`).
- Barra de KPIs inferior com risco/EAR/MAR/📱/mute/ack e telemetria (FPS, latências).

---

## 7. Sistema de design / componentes Radix reutilizáveis

Diretório: `src/ui/`. É um pequeno **design system** (átomos/moléculas) construído sobre
**Radix UI Primitives** + tokens de CSS do projeto. Tudo é re-exportado pelo barrel
`src/ui/index.ts` — "importe daqui".

Versões Radix (de `package.json`): checkbox, dialog, dropdown-menu, label, scroll-area,
select, slider, switch, tabs, toast, toggle-group, tooltip.

| Componente / export                          | Arquivo                  | Base Radix / natureza                  | Notas |
|----------------------------------------------|--------------------------|----------------------------------------|-------|
| `Button`, `IconButton`                       | `src/ui/Button.tsx`      | `<button>` nativo (forwardRef)         | Variantes `default/primary/danger/ghost`, `size sm/md`, `active`, `block`. `IconButton` força `aria-label`+`title`. |
| `Input`, `Textarea`, `FieldLabel`, `Field`   | `src/ui/form.tsx`        | nativo + `@radix-ui/react-label`       | `Field` = molécula rótulo+controle+dica/erro com associação acessível (`htmlFor↔id`). |
| `Select`, `SelectOption`                      | `src/ui/Select.tsx`      | `@radix-ui/react-select`               | Wrapper com API por array de `options` (DRY p/ os muitos selects). Portal + popper. |
| `Switch`, `Checkbox`, `CheckboxRow`, `Slider`| `src/ui/controls.tsx`    | switch / checkbox / slider / label     | `CheckboxRow` = checkbox + label clicável. `Slider` single-value. |
| `SegmentedControl`, `SegOption`              | `src/ui/SegmentedControl.tsx` | `@radix-ui/react-toggle-group` (single) | Genérico em `<T extends string>`; substitui segmentos *bespoke*. |
| `Tooltip`, `TooltipProvider`                 | `src/ui/Tooltip.tsx`     | `@radix-ui/react-tooltip`              | Provider na raiz (`delayDuration=300`); `Tooltip` envolve qualquer gatilho. |
| `Dialog`                                      | `src/ui/Dialog.tsx`      | `@radix-ui/react-dialog`               | Acessível (foco preso, ESC, ARIA); controlado por `open/onOpenChange`; `trigger`/`footer` opcionais; botão Fechar embutido. |
| `ToastProvider`, `useToast`, `ToastTone`     | `src/ui/Toast.tsx`       | `@radix-ui/react-toast`                | Fila de toasts via contexto; tons `default/alert/ok`; duração 5 s, swipe down. |
| `Badge`, `Spinner`, `Skeleton`, `SkeletonText`, `Alert`, `EmptyState`, `KpiCard`, `Tone` | `src/ui/misc.tsx` | só CSS/markup | `Alert` usa `role=alert` (tom alert) ou `role=status`. `Skeleton` é decorativo (`aria-hidden`). |
| `PageHeader`                                  | `src/ui/PageHeader.tsx`  | só markup                              | `<h1>` + subtítulo + ações à direita (`.spacer`). |

**Tokens e acessibilidade (`src/ui/ui.css`).** Define foco visível global
(`--ui-focus` aplicado em `:focus-visible` de todos os controles, `:8-11`), altura padrão
de controle (`--ui-ctrl-h: 34px`), e estilos das variantes de botão, inputs, etc. O
arquivo declara foco no design system com "alvos ≥32px" e consistência (`:1-2`). Há regras
específicas para encolher controles dentro do drawer estreito da câmera (`:53-55`).

> Observação: `react-dropdown-menu`, `react-scroll-area` e `react-tabs` constam nas
> dependências, mas **não** aparecem nos componentes de `src/ui/` lidos (a confirmar se
> são usados em outros módulos). As abas internas das telas usam `SegmentedControl`
> (ToggleGroup), não `Tabs`.

---

## 8. Relatórios — tela, cálculos, store e CSV

A tela (`ReportPage`) consome três camadas:

### 8.1 `src/report/mock.ts` — cálculos puros (camada de indicadores)

Apesar do nome "mock" (origem: "Etapa A: MOCK realista", `:1`), hoje contém as **funções
de agregação puras** que transformam datasets em indicadores para a tela. Define os tipos
(`Cell`/`Dataset`, `ReadingCell`/`ReadingDataset`, `ObjectCell/...`, `FadigaCell/...`) e
os filtros (`Filters`, `ReadingFilters`, …). Tudo são indicadores (tempo/alertas/
ocupação), **nunca imagens** (`:1-2`).

Por dimensão há um conjunto simétrico de funções:
- `*Windows` — recorta janelas current/previous conforme período/turno/filtro
  (ex.: `windows` `:23-30`, `readingWindows` `:119-126`).
- `*Kpis` — KPIs consolidados (ex.: `kpis` `:34-45`; `readingKpis` calcula taxa, no-reads
  `:128-144`; `fadigaKpis` calcula % em alerta `:309-322`).
- `*Heatmap` — matriz hora × dimensão.
- `*Ranking` / `*ByCamera` / `*ByClass` / `*Presence` — agregações para os painéis "Onde".
- `*Evolution` — séries de 14 dias.
- `*Insights` — frases automáticas de destaque.
- Utilitários: `shiftOf` (mapeia hora → turno, `:7-11`), `deltaPct` (`:47-50`),
  `fmtMin` (`:102-105`).

### 8.2 `src/report/store.ts` — persistência (API do hub)

Camada de histórico, **centralizada no Postgres via API do hub** (antes era IndexedDB por
navegador); a interface pública é a mesma (`:1-3`).
- `record*` → `POST /api/ingest` *fire-and-forget* (envio resiliente: nunca lança dentro
  do loop de vídeo, `:16-19`). Ex.: `recordSamples`, `recordAlert`, `recordReads`,
  `recordPass`, `recordObjectSamples/Event`, `recordFadigaSamples/Event`.
- `load*` → `GET /api/data/<kind>/buckets|events`, transformando *buckets* horários em
  `Dataset`/`Cell` para a tela (ex.: `loadDataset` `:32-44`, `loadFadigaDataset`
  `:112-124`).
- `clearAll` → `POST /api/data/clear` (`:128`).
- `kind`s: `ativ`, `read`, `obj`, `fad`. O turno é derivado por `shiftFor(ts)`.

Esses `record*` são chamados de dentro de `CameraWorkspace.tsx` e `FadigaView.tsx`
durante o processamento; os `load*`/`clearAll` são chamados pela `ReportPage`.

### 8.3 `src/report/csv.ts` — exportação CSV

- `buildCSV(sections)` monta um CSV "rico" multi-bloco (metadados + indicadores +
  detalhamento + eventos) num arquivo auto-descritivo. Separador `;` + **BOM** para abrir
  direto no Excel pt-BR com acentos (`:1-19`). Escape de aspas via `esc` (`:7`).
- `downloadCSVFile(filename, csv)` dispara o download via `Blob` + `<a download>`
  (`:22-29`).
- `dateStamp(d)` gera sufixo `AAAA-MM-DD` para o nome do arquivo (`:32-35`).

A montagem das seções por modo está na própria tela (`downloadCSV`,
`src/routes/ReportPage.tsx:181-237`), que escolhe os blocos conforme a dimensão ativa.

---

## 9. Notas transversais de UX e privacidade

- **Privacidade (LGPD)**: a UI reforça repetidamente "indicadores agregados, sem imagens"
  (Relatório, store, csv). Pessoas recebem IDs efêmeros e anônimos na Presença
  (`CameraWorkspace`). O número de WhatsApp é tratado como dado pessoal com opt-in
  explícito no Perfil.
- **Acessibilidade**: foco visível padronizado, skip-link no shell, `aria-label`/`title`
  nos controles de ícone, `aria-live` em estatísticas, e foco movido ao trocar de rota.
- **Separação de papéis**: a aba/rota Usuários só existe para `superadmin` (no rail e
  dentro da própria tela).
- **Tempo real**: Dashboard e nó de câmera usam `socket.io-client`; o painel humano usa o
  `token` da sessão no handshake, o nó de câmera usa token de dispositivo.
- **Configuração local vs. servidor**: tipo/zonas/limiares de câmera persistem em
  `localStorage` por câmera (`cameraConfig`, `zones`, calibração de fadiga); usuários,
  destinatários e notificações ficam no servidor (`api.ts`).
</content>
</invoke>
