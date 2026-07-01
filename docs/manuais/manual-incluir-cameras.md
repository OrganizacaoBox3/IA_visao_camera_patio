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
   - *(Opcional, avançado)* fps / largura / qualidade.
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

## Passo 6 — Testar sem uma câmera de LAN à mão
Só para validar a integração/rede rapidamente, cadastre um **HLS de teste** (funciona igual a uma câmera):
- `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` (sempre-online).

Para **cenas industriais reais** de demonstração (portos etc.), veja o catálogo em `analises/cameras-industriais/00-guia.md` (com as ressalvas: YouTube expira, EarthCam/Skyline proíbem, trânsito BR é snapshot).

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
