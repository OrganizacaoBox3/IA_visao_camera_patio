# Roteiro do vídeo-demonstração comercial (2026-07-25)

> Peça de venda/apresentação do produto: mostrar o **hardware industrial (câmera SICK) no
> contexto de CD** e o que ele entrega no painel. Montado por script reprodutível:
> `scripts/monta-demo-video.sh` (ffmpeg puro — trocar legenda/corte é editar uma linha).
> Duração final: **64 s**, 1080p30, **sem áudio** (apresentável em stand/reunião sem som).

## Fontes (mídia bruta — NÃO versionada; `video/` está no `.gitignore`)

| Arquivo | O que é | Formato |
| --- | --- | --- |
| `video/20260725_120848.mp4` | Plano único no galpão real: corredores → **a câmera SICK no tripé** → o notebook exibindo o painel ao lado das caixas. Faz a ponte físico→digital sozinho. | 1080p **@240fps**, 6,3 s (o excesso de fps vira câmera lenta sem perda) |
| `video/VID-20260725-WA0022.mp4` | Gravação de tela do painel em operação real: pessoa e empilhadeira circulando, zonas mudando de estado, permanência subindo, rodapé `análise: hub` @10-11 fps. | 720p30, 2:47 |

Os brutos ficam com o dono (e/ou no drive do time). O script falha com mensagem explícita se não os encontrar.

## Estrutura (cena → fonte → intenção)

| # | Fonte (timestamp) | Imagem | Legenda na tela |
| --- | --- | --- | --- |
| S0 | card | — | **Visão de Pátio** · inteligência operacional por câmeras · demonstração em CD industrial |
| S1 | V1 0,0–1,7 s (0,35×) | corredores do CD com empilhadeira | CD industrial — operação real |
| S2 | V1 1,9–3,3 s (0,35×) | **a câmera SICK no tripé** sobre as caixas | **câmera industrial SICK** / filma a operação e entrega o vídeo por RTSP direto ao hub — sem infraestrutura extra |
| S3 | V1 3,4–6,3 s (0,6×) | notebook com o painel ao lado das caixas reais | **da cena real ao painel** / o mesmo corredor, agora com zonas e estados sobre a imagem ao vivo |
| S4 | V2 30–40 s | operador entra no corredor e é detectado | **detecção de pessoas em tempo real** / sem crachá, marcador ou app; análise no servidor, 24/7 |
| S5 | V2 **78–96 s** | **empilhadeira operando**: corredor fica LENTA (amarelo) → corredor sem movimentação vira ALERTA (vermelho) com aviso no painel | **estados por corredor — automáticos** / a empilhadeira trabalha e o corredor fica LENTA; corredor sem movimentação vira ALERTA e avisa no painel |
| S6 | V2 154–166 s | contador de permanência subindo até 18 s | **tempo de permanência por área** / o indicador nasce da câmera, sem apontamento manual |
| S7 | V1 0,2–1,3 s (0,25×) | galpão em câmera lenta | simples de instalar — direto ao indicador |
| S8 | card | — | **Visão de Pátio** · hardware industrial + IA de visão — do chão de fábrica ao indicador |

## Decisões de acabamento (e por quê)

- **Câmera lenta de graça:** o V1 é 240 fps; `setpts` a 0,25–0,6× dá slow-motion fluido sem
  interpolação (nada de frames inventados).
- **Recorte da gravação de tela:** `crop` tira as abas do navegador e a taskbar do Windows — só
  o painel aparece (a peça é sobre o produto, não sobre o desktop de quem gravou).
- **Upscale 720p→1080p** com lanczos + letterbox no fundo do painel (`#0b0f14`), para casar com
  o material 1080p sem borda branca.
- **Legenda em duas linhas** (título + contexto): a peça precisa se explicar sozinha, sem
  narrador — pedido explícito do dono ("legenda explicando o contexto").
- **Sem áudio:** o ambiente de galpão não agrega e a peça roda em reunião/stand sem som. Trilha
  fica em aberto (se entrar, precisa ser livre de royalties).
- **S5 é a cena-chave** (pedido do dono: "mostre a empilhadeira e o status da área mudando"):
  substituiu uma cena genérica de zonas por 18 s onde o estado muda **por causa da operação
  real** — muito mais convincente que uma zona acendendo isolada.

## Pendência conhecida (declarada)

A gravação disponível mostra a empilhadeira **operando na área** com o estado do corredor
mudando — não o **trajeto completo entre dois corredores** (sair de um, entrar no outro, com
dois chips trocando de estado em sequência). Para isso é preciso **gravar ~30 s novos** com a
empilhadeira circulando; o encaixe no script é uma cena nova (S5b) de poucos minutos.

## Saídas

- `video/demo-visao-patio.mp4` — 1080p30, ~16 MB (apresentação/tela grande).
- `video/demo-visao-patio-720p.mp4` — 720p, ~6 MB (WhatsApp/e-mail).
