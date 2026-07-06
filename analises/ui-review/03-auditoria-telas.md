# 03 — Auditoria visual das telas (com evidência)

> **Método.** Todas as telas reais foram capturadas em **1366×768 (desktop)** e **390×844 (mobile)**
> via Playwright (Chromium, webcam fake) contra um **harness isolado** (hub :4123 copiado de
> `server/`, sem PG, admin bootstrap; vite :5191 com `VITE_HUB_URL` apontando pro hub isolado —
> o hub do usuário na :4000 **não foi tocado**; estava fora do ar). Para os painéis aparecerem
> populados, as rotas `GET /api/data/*` e `GET /api/alarms` foram mockadas com **metadados
> sintéticos** (mesmo padrão do e2e `app.spec.ts`) — o **pixel é real**, o dado é de amostra.
> Screenshots em `analises/ui-review/shots/` (`NN-tela--desktop.png` / `--mobile.png`).
>
> **Rubrica por achado:** (1) densidade de texto · (2) componente ultrapassado · (3) alinhamento/grid ·
> (4) ícone/cor semânticos · (5) hierarquia. Severidade: **alta / média / baixa**, com `file:line` e
> correção proposta em 1 linha.

**Panorama honesto:** o shell (menu lateral Lucide + tokens), o Relatório e os diálogos Radix já
estão num padrão bom. O problema é a **convivência de duas gerações de UI**: o shell é "v2"
(Lucide, tooltips, going-gray), mas a **câmera aberta, o drawer de alarmes, /cameras e
/alarmes-saude** ainda carregam glifos de texto/emoji, parágrafos-manual e jargão de engenharia —
exatamente a queixa de "botões/menus de versões ultrapassadas + muito texto".

---

## 1. Login (`01-login--desktop.png`, `01-login--mobile.png`)

Tela limpa e apresentável. Um único resíduo:

| # | Achado | Rubrica | Sev. | Onde | Correção |
|---|--------|---------|------|------|----------|
| 1.1 | Marca usa glifo de texto `▣ Visão de Pátio` — no shell a marca é o ícone Lucide `Cctv` (duas identidades) | ícone | baixa | `src/auth.tsx:138` | Trocar `▣` pelo mesmo `<Cctv/>` Lucide do AppShell (marca única). |

---

## 2. Central — grade (`04-central-grade--desktop.png`, `04-central-grade--mobile.png`)

| # | Achado | Rubrica | Sev. | Onde | Correção |
|---|--------|---------|------|------|----------|
| 2.1 | Botão da fila usa glifo de texto **"▦ Alarmes"** — destoa dos ícones Lucide do shell a 40px de distância | componente ultrapassado / ícone | **alta** (1ª tela que o cliente vê) | `src/routes/DashboardPage.tsx:203` | Trocar `▦` por `<Bell/>`/`<BellRing/>` Lucide (mesmo `NAV_ICON` do shell). |
| 2.2 | Rodapé do tile mostra **"0 zona(s)"** em fonte mono — jargão de configuração na tela do operador | densidade/semântica | média | `src/CameraWorkspace.tsx:1446-1448` | Omitir quando 0; com zonas, mostrar ícone `<SquareDashed/>` + número (tooltip explica). |
| 2.3 | Paginação usa botões de texto `‹`/`›` | componente ultrapassado | baixa | `src/routes/DashboardPage.tsx:183-197` | Usar `<ChevronLeft/>`/`<ChevronRight/>` em `IconButton`. |
| 2.4 | **Mobile:** header quebra em 2 linhas desbalanceadas ("+ Câmera" à direita, "Alarmes" órfão abaixo à esquerda) | alinhamento | média | `src/routes/DashboardPage.tsx:163-221` + `.page-head` | Em ≤640px, agrupar as ações numa única linha compacta (ícones), título acima. |
| 2.5 | **Mobile:** bottom-nav com 7 itens e TODOS os rótulos truncados ("Cent…", "Câm…", "Rela…", "Saú…", "Usu…", "Meu…") | alinhamento/hierarquia | média | `src/index.css:1765+` (bottom-nav) + rótulos do `AppShell.tsx:199-226` | ≤640px: só ícone (o item ativo pode mostrar rótulo) e ≤5 itens (Perfil/Saúde vão para o menu de conta). |
| 2.6 | Estado vazio ("Nenhuma câmera conectada") é só texto, sem ícone/ilustração | hierarquia | baixa | `src/routes/DashboardPage.tsx:224-239` | Usar `EmptyState` com ícone `<Video/>` + uma linha + CTA. |

---

## 3. Drawer de alarmes (`05-central-alarmes-drawer--desktop.png`, `--mobile.png`)

| # | Achado | Rubrica | Sev. | Onde | Correção |
|---|--------|---------|------|------|----------|
| 3.1 | **Layout do card QUEBRADO**: texto espremido numa coluna estreita, meta empilhada à direita — há **colisão de CSS global**: `src/report/alarms.css:85` define `.alarm-card{display:grid;grid-template-columns:auto 1fr auto}` (cards do Relatório) e sobrepõe o `.alarm-card{flex-column}` do drawer (`src/routes/alarms.css:119-128`); os filhos do card do drawer caem nas 3 colunas do grid do relatório | alinhamento | **alta** (bug visível nas 2 plataformas) | `src/report/alarms.css:85` × `src/routes/alarms.css:119` | Renomear uma das classes (ex.: `.rep-alarm-card` no relatório) ou escopar (`.rep-body .alarm-card`). |
| 3.2 | Emoji **📍** colorido no meta do card (rosa sobre dark) — viola going-gray e destoa | ícone/cor | média | `src/routes/dashboard/AlarmDrawer.tsx:72` | Trocar por `<MapPin size={12}/>` em `currentColor`. |
| 3.3 | Título "Fila de alarmes **4 novo(s)**" — plural entre parênteses + fonte mono | densidade | baixa | `AlarmDrawer.tsx:107-109` + `src/routes/alarms.css:77-83` | "4 novos" (pluralização real) em texto normal; zero = ocultar. |
| 3.4 | Texto crítico depende do caractere **"⚠" embutido no texto** do alarme (é até o contrato de criticidade da política) | ícone/semântica | média | `AlarmDrawer.tsx:68` (render) · `server/alarm/classify.js:8` (contrato) | No card, exibir ícone `<TriangleAlert/>` derivado de `priority` e ocultar o "⚠" textual. |
| 3.5 | Dois botões por card ("Reconhecer"/"Encaminhar") repetidos N vezes pesam a lista | hierarquia | baixa | `AlarmDrawer.tsx:83-94` | Ação primária visível + secundária num menu "⋯" (DropdownMenu). |

---

## 4. Câmera aberta — tela cheia (`06`–`11-camera-full-*--desktop.png`, `06-camera-full--mobile.png`)

A tela mais importante do produto e a mais "geração 1".

| # | Achado | Rubrica | Sev. | Onde | Correção |
|---|--------|---------|------|------|----------|
| 4.1 | **Header duplo**: o overlay é `position:absolute` dentro de `.dash-body`, então o header da Central ("+ Câmera", "Alarmes") continua visível acima do header da câmera — dois toolbars competem; no mobile custa ~100px | hierarquia | **alta** | `src/index.css:1917-1924` (`.cam-overlay`) · `src/routes/DashboardPage.tsx:267-304` | Overlay cobrir a `.page` inteira (ou esconder `.page-head` via `:has(.cam)`) — 1 header por contexto. |
| 4.2 | Toolbar inteira em **glifos de texto**: "❄ Congelar", "⏸ Pausar", "✎ Zona", "⇄ Linha", "🖌/🧽" (pincel/borracha), "⤓ Snapshot/Exportar clipe" — inventário de 2 gerações vs. o shell Lucide | componente ultrapassado / ícone | **alta** | `src/CameraWorkspace.tsx:1499-1565`, `1638-1650` | Padronizar em Lucide (`Snowflake`, `Pause`, `PenLine`, `ArrowLeftRight`, `Brush`, `Eraser`, `Download`) com rótulo curto ou só-ícone+tooltip. |
| 4.3 | KPI-bar inferior com glifos "◉ 0 pessoas · ⏱ 0s permanência" + "detecção: CPU ⚠" | ícone | média | `src/CameraWorkspace.tsx:1756-1808` | Ícones Lucide (`Users`, `Timer`) 14px; estados anormais mantêm token de cor. |
| 4.4 | Aba "Presença" **cortada** na borda direita da tablist (desktop E mobile); a rolagem horizontal existe mas não tem affordance | alinhamento | média | `src/camera/cine.css:100-107` + `CameraWorkspace.tsx:1672-1692` | Fade/chevron de overflow na tablist, ou encurtar rótulos ("Zonas/Linhas/Camadas/Linha do tempo→Timeline/Pessoas"). |
| 4.5 | Aba Zonas abre com **parágrafo-manual** (~22 palavras): "Cada zona roda um modo de IA na sua área (…). Para trocar: ⚙ na zona → Modo." | densidade | média | `src/camera/tabs/ZonasTab.tsx:55-60` | Virar tooltip/`(?)` no título da aba; a tela mostra só a lista. |
| 4.6 | Ferramentas da zona são `<button className="del">` cru com glifos ⚙/🖌/✕ (não usam o átomo `IconButton`) | componente ultrapassado | média | `src/camera/tabs/ZonasTab.tsx:90-126` (idem `LinhasTab.tsx:93-111`) | Migrar para `IconButton` + Lucide (`Settings2`, `Brush`, `X`). |
| 4.7 | Aba Linhas: instrução de ~25 palavras no vazio + **nota mecânica de ~30 palavras** no rodapé ("A contagem reusa o rastreio… Contadores são por sessão.") | densidade | média | `src/camera/tabs/LinhasTab.tsx:55-61`, `137-142` | Vazio = 1 linha + ícone; a mecânica vira tooltip do contador. |
| 4.8 | Aba Camadas expõe **identificadores de código**: "padrões em APP_CONFIG.overlay / MODE_PRESETS" (parágrafo de ~35 palavras) + nota de 3 linhas no card "Longo alcance" | densidade/jargão | **alta** (jargão de dev na UI) | `src/camera/tabs/CamadasTab.tsx:98-102`, `115-118` | Remover a referência a código; resumir a 1 linha ("Ajustes valem só nesta sessão") e mover o resto p/ tooltip. |
| 4.9 | Card da zona: telemetria mono densa ("alvo: zona ativa", "alvo 1–8 pessoas", "Fluxo baixo") sem hierarquia p/ operador | hierarquia | baixa | `ZonasTab.tsx:130-184` | Manter métrica+sparkline; rótulos de alvo viram tooltip da própria barra. |
| 4.10 | Badge "🔒 Somente leitura" com emoji | ícone | baixa | `src/CameraWorkspace.tsx:1489` | `<Lock size={12}/>` no Badge. |
| 4.11 | "Legenda do overlay" permanente ocupa o pé do drawer | hierarquia | baixa | `ZonasTab.tsx:306-318` | Colapsar em popover "Legenda" (ícone `<Info/>`). |

---

## 5. Config de zona — Dialog (`07-camera-full-config-zona--desktop.png`)

Dialog já é Radix e está no padrão. Ajustes finos:

| # | Achado | Rubrica | Sev. | Onde | Correção |
|---|--------|---------|------|------|----------|
| 5.1 | Dois helpers empilhados sob o slider ("sem dados suficientes p/ estimar alertas/dia" + "Menor = ignora…") | densidade | baixa | `src/camera/ConfigZonaDialog.tsx` (bloco Sensibilidade) | Manter 1 helper; a estimativa só aparece quando existe ("~N alertas/dia"). |
| 5.2 | Único botão "Concluir" sem "Cancelar" (mudanças aplicam na hora — ok, mas o modelo não é óbvio) | hierarquia | baixa | `ConfigZonaDialog.tsx` (footer) | Rótulo "Fechar" + subtítulo já diz "valem na hora" — ou aplicar em lote com Salvar/Cancelar. |

---

## 6. /cameras (`12-cameras--desktop.png`, `13-cameras-add-ip--desktop.png`, `12-cameras--mobile.png`)

A tela com maior densidade de texto do app — no mobile o 1º scroll é quase só prosa.

| # | Achado | Rubrica | Sev. | Onde | Correção |
|---|--------|---------|------|------|----------|
| 6.1 | Parágrafo-manual de **~60 palavras/5 linhas** abrindo a seção ("Uma linha por câmera — … usuário/senha ocultos.") | densidade | **alta** | `src/routes/cameras/IpCamerasSection.tsx:282-288` | Cortar para 1 linha ("Câmeras IP e nós locais; ajustes valem para câmera conectada") + `(?)`/tooltip para o resto. |
| 6.2 | Segundo parágrafo técnico de **~40 palavras** sobre WebRTC/go2rtc/MJPEG/override abaixo do botão | densidade/jargão | **alta** | `IpCamerasSection.tsx:412-416` | Virar tooltip do próprio Select "Vídeo no painel"; some da página. |
| 6.3 | Seção do nó local: mais **~40 palavras** de prosa + nota "conecta sem login humano" + fallback citando `CAMERA_TOKEN`/systemd | densidade/jargão | média | `src/routes/cameras/LocalNodeSection.tsx:52-56`, `77-87` | 1 linha + botão + campo de link; instruções de infra só p/ superadmin em tooltip/help. |
| 6.4 | Nó local exibe **UUID cru** (`815c683e-…`) como identificador da câmera | semântica | média | `IpCamerasSection.tsx:324` | Mostrar "nó local · webcam" (badge); UUID só em tooltip/detalhe. |
| 6.5 | Select carrega o rótulo dentro do valor: "Vídeo no painel: Automático (melhor disponível)" (3 opções repetem o prefixo) | componente | média | `IpCamerasSection.tsx:361-371` | `Field label="Vídeo no painel"` + opções curtas ("Automático", "MJPEG", "WebRTC"). |
| 6.6 | Status "Online" como texto solto — na Central o mesmo estado é pílula com dot | consistência/ícone | baixa | `IpCamerasSection.tsx:329-331` | Reusar a pílula/dot de status (`.cam-status-pill`) aqui. |
| 6.7 | Dialog "Adicionar câmera IP" está no padrão (bom exemplo); só o helper de URL é denso | densidade | baixa | `IpCamerasSection.tsx:~460-490` | Manter; encurtar helper p/ "rtsp:// ou http(s):// (HLS/MJPEG)". |

---

## 7. Relatório (`14`–`17-relatorio-*--desktop.png`, mobile idem)

Tela mais madura do app — achados são de acabamento e going-gray.

| # | Achado | Rubrica | Sev. | Onde | Correção |
|---|--------|---------|------|------|----------|
| 7.1 | Faixa de insights **verde saturado permanente** ("💡 Oportunidades…") — cor de estado para conteúdo neutro viola going-gray; e usa emoji | cor/ícone | média | `src/index.css:1002-1010` (`.insight`) · `src/routes/report/AtividadePanel.tsx:106` (e irmãos: Leitura:93, Objetos:76, Fadiga:75, Alarmes:109) | Fundo neutro (`--panel`) com borda esquerda accent; `<Lightbulb/>` Lucide no lugar do 💡. |
| 7.2 | Pílula "● indicadores · sem imagens" verde saturada SEMPRE ligada no header | cor | baixa | `src/index.css:210-217` (`.privacy`) · `ReportPage.tsx:200` | Neutro (`--state-neutral-*`) com `<ShieldCheck/>`; verde só não diz nada aqui. |
| 7.3 | Ação destrutiva **"limpar histórico" é um link mono de 10px no rodapé** | componente/hierarquia | média | `src/routes/report/chrome.tsx:48-58` (`.rep-foot`, `index.css:1019-1025`) | Mover para menu "⋯" do header do relatório como item danger (o AlertDialog já protege). |
| 7.4 | Rodapé vaza **nome de contrato interno "B1"**: "Eventos de alarme (B1) · só metadados…" | jargão | média | `src/routes/report/AlarmesPanel.tsx:227-232` | Remover "(B1)"; manter "só metadados, sem imagens". |
| 7.5 | Instrução embutida em título de seção: "TENDÊNCIA (14 DIAS) — **CLIQUE P/ FILTRAR O DIA**" (e "…A HORA") | densidade | baixa | `AlarmesPanel.tsx:114`, `146` | Tirar do título; affordance por hover/cursor + tooltip. |
| 7.6 | Resumo: rodapé central "**Toque** num cartão para abrir o detalhe…" em mono (desktop = clique, não toque) | densidade | baixa | `src/routes/report/ResumoPanel.tsx:167` | Remover (os cards já são botões com hover) ou "Clique num cartão". |
| 7.7 | Emoji 📦 no KPI ("predominante: 📦 Caixa") | ícone | baixa | `ResumoPanel.tsx:157` (via catálogo de classes) | Ícone Lucide `<Package/>` ou só o rótulo. |
| 7.8 | Heatmap de ociosidade com **RGB cru** âmbar→vermelho (fora dos tokens; regra da casa: "nunca RGB cru") | cor | média | `src/routes/report/Heatmap.tsx:7-14` | Derivar a escala de `--state-warn`/`--state-critical` (color-mix) — mantém a semântica, obedece o token. |
| 7.9 | Botões de export com glifos de texto "⬇ CSV", "⎙ PDF", "↻" | componente/ícone | baixa | `ReportPage.tsx:280-288` | `<Download/>`, `<Printer/>`, `<RefreshCw/>` Lucide. |
| 7.10 | **Mobile:** toolbar (modo+período+turno+área+histórico+4 botões) consome ~40% da viewport antes do 1º dado; modo "Alarmes" fica cortado no scroll horizontal do SegmentedControl | alinhamento/hierarquia | média | `ReportPage.tsx:182-288` + `SegmentedControl.tsx:26` | ≤640px: filtros colapsam num botão "Filtros" (sheet); exports num menu "⋯". |

---

## 8. /usuarios (`18`–`20-usuarios-*--desktop.png`, mobile idem)

| # | Achado | Rubrica | Sev. | Onde | Correção |
|---|--------|---------|------|------|----------|
| 8.1 | Emoji **🎲** como botão "gerar senha" | ícone | média | `src/routes/users/UsersTab.tsx:141-146` | `<Dices/>` ou `<Wand2/>` Lucide no `IconButton`. |
| 8.2 | Form "Novo usuário" só com placeholders (sem labels visíveis) | componente/a11y | baixa | `UsersTab.tsx:127-157` | Usar `Field label=` como no resto do app. |
| 8.3 | Título "1 USUÁRIO(S)" — plural entre parênteses | densidade | baixa | `UsersTab.tsx:163` | Pluralizar de verdade ("1 usuário"/"3 usuários"). |
| 8.4 | Notificações: status do WhatsApp instrui **"Defina WHATSAPP_ENABLED=1 no hub (systemd)… (Baileys é não-oficial)"** — env var + systemd + lib na UI | jargão | **alta** (indefensável diante do cliente) | `src/routes/users/NotificacoesTab.tsx:176-180` | "WhatsApp desativado neste servidor — peça ao administrador para habilitar" (detalhe técnico vai p/ docs). |
| 8.5 | Checkboxes "local / data/hora / rodapé" espremidos à direita do input "Marca / assinatura", sem agrupamento visual | alinhamento | baixa | `NotificacoesTab.tsx:219-240` (aprox.) | Linha própria "Incluir na mensagem:" com os 3 toggles. |
| 8.6 | Aba "Câmeras" é quase vazia: só o link de inscrição + frase apontando para /cameras (funcionalidade duplicada) | hierarquia | média | `src/routes/UsersPage.tsx:118-131` + `LocalNodeSection` (`compact`) | Remover a aba; o link de inscrição vive só em /cameras (1 lar por função). |

---

## 9. /perfil (`21-perfil--desktop.png`, `--mobile.png`)

Compacta e razoável.

| # | Achado | Rubrica | Sev. | Onde | Correção |
|---|--------|---------|------|------|----------|
| 9.1 | Cada checkbox carrega explicação entre parênteses ("(pode pausar sem apagar o número)", "(consentimento — LGPD)") | densidade | baixa | `src/routes/ProfilePage.tsx` (bloco WhatsApp) | Rótulo curto + tooltip/hint de `Field` p/ o parêntese. |
| 9.2 | Chips de tipo ("Atividade / parada"…) parecem botões comuns — estado on/off pouco distinguível | semântica | baixa | `ProfilePage.tsx` (tipos) | Usar `Toggle`/chips com check visível (mesmo padrão do SegmentedControl). |

---

## 10. /alarmes-saude (`22-alarmes-saude--desktop.png`, `--mobile.png`)

Tela de engenharia — jargão tolerável, mas o formulário de shelve é dev-UX puro.

| # | Achado | Rubrica | Sev. | Onde | Correção |
|---|--------|---------|------|------|----------|
| 10.1 | Criar silêncio exige **digitar chave crua `cameraId\|zona\|tipo` com curingas `*`** (parágrafo de ~35 palavras ensinando a sintaxe) | componente ultrapassado / densidade | **alta** | `src/routes/AlarmHealthPage.tsx:303-316` | Trocar o input por 3 Selects (Câmera/Zona/Tipo, com "Todas") que montam a chave por baixo. |
| 10.2 | Anglicismos "Shelves ativos", "Criar shelve" como rótulos primários | jargão | média | `AlarmHealthPage.tsx:236-238`, `257`, `340` | "Silenciamentos ativos" / "Silenciar" (manter "shelve" só em tooltip/doc). |
| 10.3 | Subtítulo cita normas "(ISA-18.2 / EEMUA 191)" e KPI diz "dentro do alvo EEMUA" | jargão | baixa | `AlarmHealthPage.tsx:159`, `219` | "Saúde do sistema de alertas" no subtítulo; norma vira tooltip do KPI. |
| 10.4 | Glifos de texto ⏳ e ● em vez de ícones | ícone | baixa | `AlarmHealthPage.tsx:162-164`, `274` | `<Hourglass/>`, dot com token. |

---

## 11. Nó de câmera `/camera` (`03-camera-node--desktop.png`)

| # | Achado | Rubrica | Sev. | Onde | Correção |
|---|--------|---------|------|------|----------|
| 11.1 | Hint inferior ("Nó de câmera · processamento e controles ficam na central") em cinza ~40% sobre vídeo — ilegível | cor/contraste | baixa | `src/routes/CameraPage.tsx` (badge inferior) | Usar o mesmo scrim/contraste do badge superior (`--cam-overlay-scrim`). |

---

# TOP-15 — priorizado pelo impacto na 1ª impressão do cliente

| # | Achado | Tela | Sev. | Refs |
|---|--------|------|------|------|
| 1 | **Colisão CSS `.alarm-card`** quebra o layout dos cards na fila de alarmes (desktop+mobile) — parece produto defeituoso | Drawer de alarmes | alta | `src/report/alarms.css:85` × `src/routes/alarms.css:119` · shot `05-*` |
| 2 | **Header duplo na câmera aberta** — a tela-hero do demo mostra dois toolbars competindo | Câmera full | alta | `src/index.css:1917-1924` · shots `06`–`11` |
| 3 | **Toolbar da câmera em glifos/emoji** (❄ ⏸ ✎ ⇄ 🖌 🧽 ⤓) vs. shell Lucide — "duas gerações" na mesma tela | Câmera full | alta | `CameraWorkspace.tsx:1499-1565` |
| 4 | **Wall-of-text em /cameras** (~140 palavras de prosa em 3 blocos, com go2rtc/MJPEG/override) | /cameras | alta | `IpCamerasSection.tsx:282-288,412-416` · `LocalNodeSection.tsx:52-87` |
| 5 | **Jargão de infra na UI**: `WHATSAPP_ENABLED=1`, systemd, Baileys | /usuarios·Notificações | alta | `NotificacoesTab.tsx:176-180` |
| 6 | **Shelve por chave crua `cameraId\|zona\|tipo`** com curingas digitados à mão | /alarmes-saude | alta | `AlarmHealthPage.tsx:303-316` |
| 7 | **Vazamento de identificadores de código** na aba Camadas (`APP_CONFIG.overlay / MODE_PRESETS`) | Câmera full | alta | `CamadasTab.tsx:98-102` |
| 8 | **"▦ Alarmes"** — glifo de texto no botão mais importante do header da Central | Central | alta | `DashboardPage.tsx:203` |
| 9 | **Emoji como ícone funcional** (📍 no card de alarme, 🎲 gerar senha, 💡/🔔 insights, 📦 KPI, 🔒 badge) | várias | média | `AlarmDrawer.tsx:72` · `UsersTab.tsx:145` · `AtividadePanel.tsx:106` · `ResumoPanel.tsx:157` · `CameraWorkspace.tsx:1489` |
| 10 | **Mobile bottom-nav com 7 itens truncados** ("Cent…","Câm…","Saú…") | shell (todas mobile) | média | `index.css:1765+` · shots `*--mobile` |
| 11 | **Parágrafos-manual nas abas da câmera** (Zonas ~22p, Linhas ~55p, Camadas ~50p, Presença) | Câmera full | média | `ZonasTab.tsx:55-66` · `LinhasTab.tsx:55-61,137-142` · `CamadasTab.tsx:98-118` · `PresencaTab.tsx:28-31` |
| 12 | **Going-gray violado por verde decorativo**: faixa `.insight` e pílula `.privacy` saturadas em estado normal | Relatório | média | `index.css:1002-1010`, `210-217` |
| 13 | **"limpar histórico" destrutivo escondido como link mono 10px** no rodapé | Relatório | média | `chrome.tsx:48-58` |
| 14 | **Aba "Presença" cortada** na tablist do drawer da câmera (desktop e mobile), sem affordance de scroll | Câmera full | média | `cine.css:100-107` · shots `06`,`06--mobile` |
| 15 | **UUID cru + Select com rótulo embutido no valor** na lista de câmeras | /cameras | média | `IpCamerasSection.tsx:324`, `361-371` |

**Regra de ouro para o retrofit:** promover o padrão do shell (Lucide `NAV_ICON`, tooltips, tokens,
Radix) a TODAS as superfícies; toda prosa >1 linha vira tooltip/`(?)`; cor saturada só para
anormalidade; jargão de engenharia (env vars, contratos, libs, chaves) nunca renderiza em JSX.
