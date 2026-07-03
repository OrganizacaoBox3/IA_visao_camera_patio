# Como incluir câmeras reais e relevantes

> Guia de entrada para colocar câmeras na aplicação e extrair valor delas. "Relevante" = a câmera está
> **posicionada para enxergar o que cada modo analisa**. Para os detalhes técnicos de RTSP por fabricante,
> veja [Câmeras IP / RTSP (geral)](./manual-camera-rtsp.md) e [Intelbras](./manual-intelbras-rtsp.md).

## Antes de começar (pré-requisitos)
- O **servidor (hub)** e a **câmera** precisam estar na **mesma rede** (mesma sub-rede/VLAN; firewall liberando a porta **554**).
- **ffmpeg** disponível no servidor (o hub detecta automaticamente; se falhar, defina `FFMPEG_PATH`).
- Você precisa estar logado como **superadmin** para cadastrar câmeras.
- A câmera precisa expor **RTSP** (a maioria das câmeras de CFTV profissionais expõe; linhas domésticas às vezes não — ex.: Intelbras **Mibo**).

---

## Passo 1 — Escolher uma câmera RELEVANTE (posicionamento por modo)
Antes de conectar, pense **o que aquela câmera deve capturar**. Cada modo pede um enquadramento diferente:

| Modo | O que a câmera deve enquadrar | Dicas de posicionamento |
|------|------------------------------|--------------------------|
| **Atividade / presença por zona** | A área de trabalho de cima/diagonal (doca, corredor, expedição, estoque) | Ângulo alto/diagonal cobrindo a zona inteira; movimento visível; evita contraluz |
| **Objetos / contagem** | Caminhões, empilhadeiras, paletes, pessoas passando | Enquadrar o fluxo (entrada de doca, corredor); objetos de tamanho razoável no quadro (não minúsculos ao fundo) |
| **Leitura de código** | Etiqueta/código **de perto e legível** (caixa, palete, portal) | Close no ponto de leitura, boa nitidez e luz; código ocupando parte significativa do quadro |
| **Fadiga (operador)** | O **rosto** do operador de frente | Câmera à frente da pessoa (ex.: posto/empilhadeira), rosto bem iluminado, sem contraluz |

**Regra de ouro:** a câmera resolve **um** propósito bem melhor do que tentar cobrir tudo. Uma câmera de doca (atividade/objetos) é diferente de uma câmera de operador (fadiga).

---

## Passo 2 — Descobrir a câmera na rede (achar o IP)
Em ordem de facilidade:
1. **ONVIF Device Manager** (recomendado) — descobre a câmera na LAN **e já mostra a URL RTSP pronta**.
2. **Lista de DHCP do roteador** — ver o IP que a câmera recebeu.
3. **Ferramenta do fabricante** — Hikvision **SADP** · Dahua/Intelbras **ConfigTool** · Intelbras **IP Utility** · **AXIS IP Utility**.
4. **Varredura na sua rede:** `nmap -p 554,80,8000 192.168.x.0/24` (uso legítimo na própria rede).

Anote: **IP**, **usuário** e **senha** da câmera (de preferência crie um **usuário só-leitura** dedicado, não use o admin).

---

## Passo 3 — Montar a URL RTSP
Use a **porta 554** e, sempre que possível, o **sub-stream** (resolução menor → menos CPU/banda; a detecção já roda em resolução reduzida).

| Fabricante | Main-stream (alta) | Sub-stream (recomendado) |
|------------|--------------------|--------------------------|
| **Hikvision** | `rtsp://user:senha@IP:554/Streaming/Channels/101` | `rtsp://user:senha@IP:554/Streaming/Channels/102` |
| **Dahua** | `rtsp://user:senha@IP:554/cam/realmonitor?channel=1&subtype=0` | `...&subtype=1` |
| **Intelbras (VIP/NVR)** | `rtsp://user:senha@IP:554/cam/realmonitor?channel=1&subtype=0` | `...&subtype=1` |
| **Axis** | `rtsp://user:senha@IP:554/axis-media/media.amp` | `...media.amp?resolution=640x480` |
| **Genérico / ONVIF** | descobrir via ONVIF | — |

- **Vários canais (NVR):** troque `channel=` (Dahua/Intelbras) ou o número do canal (Hikvision: canal 2 → `201`/`202`).
- Detalhes e mais fabricantes: [manual RTSP geral](./manual-camera-rtsp.md).

---

## Passo 4 — Incluir na aplicação
1. Abra a **Central**, faça login como **superadmin**.
2. Clique em **"+ Câmera IP"** (ao lado de "+ Nó de câmera").
3. Preencha:
   - **Nome (label):** ex. "Doca 3".
   - **URL:** a URL RTSP do Passo 3.
   - **Transporte:** **TCP** (mais estável).
   - *(Opcional, avançado)* fps / largura / qualidade — **câmera de rua/panorâmica? Suba a largura para 1280–1920** (ver a [receita abaixo](#câmeras-de-ruapanorâmicas--receita-para-reconhecer-pedestres)).
4. Clique **Adicionar**. A câmera aparece na grade e o status do tile evolui:
   - **connecting** → conectando; **online** → recebendo vídeo; **error** → ver Troubleshooting.
5. **Gestão:** na mesma tela você pode **habilitar/desabilitar** ou **remover** câmeras IP cadastradas.

> A URL pode conter usuário e senha — o sistema **mascara** as credenciais na exibição e **não** as registra em log. O arquivo de cadastro (`cameras.json`) **não é versionado**.

---

## Passo 5 — Configurar a câmera (extrair valor)
Com a câmera **online**, clique nela para abrir em tela cheia e:
1. **✎ Zona** — desenhe a(s) zona(s) sobre a área de interesse (a doca, o corredor…). Use a **máscara** (pincel) para recortar só o que importa.
2. **Modo da zona** — escolha **Atividade**, **Objetos**, **Leitura** ou **Fadiga** conforme o Passo 1.
3. **Sensibilidade / limite** — ajuste por zona (o slider mostra a **estimativa de alertas/dia**). Comece conservador para não gerar alerta falso.
4. **⇄ Linha (tripwire)** — para **contagem de entrada/saída** (ex.: caminhões na doca), desenhe a linha e defina a direção.
5. **❄ Congelar** — pausa e permite revisar os últimos segundos (útil para conferir um evento).

As zonas/linhas ficam salvas por câmera. Perfis **operador** só visualizam; **engenheiro/superadmin** editam a configuração.

---

## Reduzir falsos positivos — zona de Exclusão

Vendo a câmera detectar "pessoa" onde não há ninguém? O acompanhamento em campo (soak) mostrou
que **a maioria dos falsos positivos vem de poucos objetos fixos** — uma grade, uma placa, a
janela escura de uma van, uma TV — que o motor lê como torso/cabeça no piso de confiança. Como
esses pontos **não se movem** e as pessoas sim, dá para mascará-los **sem perder recall**:

1. Abra a câmera em tela cheia e clique **✎ Zona**.
2. Desenhe a zona **sobre o objeto fixo** que gera a detecção fantasma (a grade, a placa, a
   janela, a TV) — cobrindo só ele.
3. Clique **⚙ Configurar zona** e escolha **Modo: Exclusão**.

O motor passa a ignorar detecções dentro dessa área. Aplique **por câmera**, um objeto de cada
vez, conferindo em `/api/analysis/status` que as detecções fantasma caíram. É a medida mais
barata de calibração (config por câmera, opt-in, sem tocar em threshold nem modelo).

---

## Câmeras de rua/panorâmicas — receita para reconhecer pedestres

Cena aberta (rua, pátio, doca vista de longe): o pedestre distante ocupa **20–40 px** no stream original.
Com a largura padrão (**720**), depois do corte do detector ele vira **~5–11 px** — abaixo do mínimo físico
do modelo, e a contagem fica em zero mesmo com gente visível. A receita:

1. **Largura 1280–1920 no cadastro.** Em **"+ Câmera IP" → Opções avançadas → Largura**, informe
   `1280` a `1920` (em câmera já cadastrada: remova e recadastre com a largura nova, ou ajuste via
   `PATCH /api/cameras/:id`). O padrão 720 serve para doca/corredor de perto, **não** para cena de rua.
2. **Ligue "Longo alcance / Panorâmica".** Abra a câmera em tela cheia → aba **Camadas** → ative
   **Longo alcance / Panorâmica**. Com o motor de análise ligado, é o **MOTOR no hub** que aplica o
   tiling (varredura por blocos a 640 px) e os limiares para alvos pequenos — o toggle é salvo por
   câmera (camcfg) e vale para o servidor. Com o motor desligado, o mesmo toggle segue valendo para
   a detecção local do navegador (fallback).
3. **Não precisa deixar a câmera aberta.** A análise de pessoas/atividade/fluxo roda **no hub, 24/7**
   (ADR-009) — contagem e indicadores enchem mesmo sem nenhum dashboard aberto. O navegador só
   espelha as caixas que o servidor manda. (Exceção: com o motor desligado, vale o comportamento
   antigo — detecção no navegador, câmera aberta para cadência completa.)
4. **Trade-off honesto:** mais largura = mais CPU no servidor (ffmpeg + decode do motor; tiling
   multiplica as inferências dessa câmera). Aplique **por câmera** (só nas panorâmicas), não como
   padrão global; se o hub pesar, reduza o fps dessa câmera (ex.: 6–8) — o motor amostra a ~1 fps.

> **Operação do motor (hub):** `ANALYSIS_ENABLED=1` no primeiro boot **baixa o modelo** D-FINE
> (sha conferido) para `server/models/`; dali em diante o default liga sozinho se o modelo
> existe (`ANALYSIS_ENABLED=0` desliga). Saúde/telemetria: `GET /api/analysis/status` (fps, fila,
> ms e detecções por câmera). Detalhes: `server/analysis/README.md`.
>
> **Qual modelo (`ANALYSIS_MODEL=n|s|m`):** o default é o **D-FINE-S**, que enxerga ~2× mais
> pessoa média/pequena (o alvo de pé-direito alto/cena aberta) que o antigo nano, ao custo de
> ~2,4× de CPU — na prática ~**7 câmeras por núcleo** @1 fps (contra ~17 no nano). Se o hub
> tiver **muitas câmeras e CPU limitada**, volte ao mais leve com `ANALYSIS_MODEL=n`; `=m` só
> em hub folgado com poucas câmeras (mais recall, ~2× o custo do S). Trocar de modelo pede
> recalibrar o gate de regressão do `eval/` — ver `eval/MODELS.md`.

**Exemplo (câmera pública de Pula, HR — rua com pedestres, 1080p):** cadastre
`https://cdn-004.whatsupcams.com/hls/hr_pula01.m3u8` com **Largura 1920**, ligue **Longo alcance /
Panorâmica** na aba Camadas e desenhe a zona sobre a calçada/rua — com o motor ligado, os
indicadores acumulam sozinhos (confira em Relatório ou `/api/analysis/status`), sem precisar
manter a câmera aberta. Com o padrão 720 e o perfil desligado, essa mesma cena contava **zero**
pedestres — foi exatamente o caso do diagnóstico de jul/2026 (`analises/diagnostico-runtime-2026-07.md`).

---

## Passo 6 — Testar sem uma câmera de LAN à mão (fontes públicas verificadas)

### 6.1 Copy-paste: câmeras públicas diretas (HLS, sem token — colam direto)
Como usar (3 passos): **1)** abra a **Central** (login superadmin) → **2)** clique **"+ Câmera IP"** →
**3)** cole a URL da tabela, transporte **TCP**, dê um label → **Adicionar**.

| Nome | Tipo | URL pronta | O que mostra | Verificada em |
|------|------|------------|--------------|---------------|
| Nova Gorica (SI) — Bevkov trg | hls | `https://cdn-006.whatsupcams.com/hls/si_ngbevkovtrg.m3u8` | Praça central, pedestres cruzando (720p) | 2026-07-02 (ffprobe h264 1280x720 + frame com pessoas) |
| Gorizia (IT) — Piazza Vittoria | hls | `https://cdn-008.whatsupcams.com/hls/it_gorizia06.m3u8` | Praça com cafés, pedestres/ciclistas/carros (1080p) | 2026-07-02 (ffprobe h264 1920x1080 + frame com pessoas) |
| Pula (HR) — rua do centro | hls | `https://cdn-004.whatsupcams.com/hls/hr_pula01.m3u8` | Rua/calçada com pedestres (1080p) | 2026-07-02 (ffprobe h264 1920x1080 + frame com pessoas) |
| Mošćenička Draga (HR) — centro | hls | `https://cdn-007.whatsupcams.com/hls/hr_mdraga04.m3u8` | Vila à beira-mar, pedestres na rua (1080p) | 2026-07-02 (ffprobe h264 1920x1080 + frame com pessoas) |
| Bled (SI) — lago (panorâmica) | hls | `https://cdn-001.whatsupcams.com/hls/si_bled1.m3u8` | Lago/promenade, movimento ao longe (1080p) | 2026-07-02 (ffprobe h264 1920x1080) |
| Mux BBB — teste de pipeline | hls | `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` | Vídeo sintético em loop (sempre-online) | 2026-07-02 (ffprobe h264 1280x720) |

> **Aviso honesto:** fonte pública cai **sem aviso**. Se uma der erro: (a) o slug do WhatsUpCams às vezes
> **migra de CDN** — teste a mesma URL trocando `cdn-006` por `cdn-001`…`cdn-008`; (b) rode `npm run cameras`
> (ele testa tudo com ffprobe e imprime só o que está no ar); (c) pegue outra da tabela.
>
> **MJPEG http direto:** em 2026-07-02 **não encontramos** nenhuma fonte MJPEG pública *intencional* estável
> (as clássicas de universidades/Axis morreram; diretórios tipo insecam ficam fora por princípio — são câmeras
> privadas expostas sem intenção). Use as HLS acima — para o hub é igual (o ffmpeg detecta pelo URL).

### 6.2 YouTube lives (pedestres 24/7) — use `npm run cameras`
**Não cole o `.m3u8` do YouTube no cadastro:** a URL resolvida **expira em ~6h** (token com validade) — a
câmera cairia sozinha. Por isso existe o script: **`npm run cameras`** resolve as lives do catálogo
(Times Square, Temple Bar/Dublin, Shibuya ×2, Kabukicho, Porto de Santos) para HLS **na hora**, verifica com
ffprobe e imprime URLs prontas para colar. Caiu depois de umas horas? **Rode de novo** para renovar.
Também aceita qualquer live: `npm run cameras "<url-youtube-live>"`.
Requer `yt-dlp` (`winget install yt-dlp.yt-dlp`) e ffmpeg (auto-detectados mesmo fora do PATH).

Para **cenas industriais reais** de demonstração (portos etc.), veja o catálogo em `analises/cameras-industriais/00-guia.md` (com as ressalvas: YouTube expira, EarthCam/Skyline proíbem extração dos sites deles, trânsito BR é snapshot).

---

## Troubleshooting
| Sintoma | Causa provável | O que fazer |
|---------|----------------|-------------|
| status **error** logo ao adicionar | URL/caminho RTSP errado | Confirme o padrão do fabricante (Passo 3) e o número do canal |
| **401 / não autoriza** | usuário/senha errados ou sem permissão de stream | Verifique credenciais; use usuário com direito a RTSP |
| **error / timeout** | câmera e hub em redes diferentes, ou firewall | Garanta a mesma sub-rede/VLAN e porta **554** liberada |
| conecta mas **trava / pesado** | main-stream em alta resolução ou H.265 | Use o **sub-stream**; prefira H.264 |
| "**ffmpeg não encontrado**" | ffmpeg fora do PATH do servidor | O hub tenta auto-detectar; senão defina `FFMPEG_PATH` e reinicie |
| a câmera **some** ao reiniciar | — | Câmeras IP cadastradas persistem; se limpou `cameras.json`, recadastre |

---

## Segurança & LGPD
- **Câmera de operador (fadiga)** capta rosto → é dado pessoal: use com **opt-in**, finalidade clara e acesso restrito.
- O sistema **não grava imagens** no servidor — só indicadores/eventos (metadados). O cine-loop é temporário e local.
- **Credenciais** das câmeras são sensíveis: usuário só-leitura, rede de CFTV isolada (VLAN) quando possível, e o `cameras.json` fica fora do versionamento.
