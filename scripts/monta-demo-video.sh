#!/bin/bash
# Uso: bash scripts/monta-demo-video.sh   (requer ffmpeg no PATH; ~2 min de render)
#
# Monta o VÍDEO-DEMONSTRAÇÃO comercial do produto a partir de duas gravações de campo
# (2026-07-25, CD da Grendene). Roteiro, timestamps e racional de cada cena:
#   docs/analises/demo-video-roteiro.md
#
# Reprodutível de propósito: ajustar uma legenda ou um corte é editar UMA linha e rodar de
# novo — nada de projeto de editor binário que ninguém consegue revisar em diff.
#
# ENTRADAS (mídia bruta, NÃO versionada — video/ está no .gitignore; peça ao dono os arquivos):
#   video/20260725_120848.mp4    galpão real, 1080p @240fps (a câmera lenta sai de graça daqui)
#   video/VID-20260725-WA0022.mp4  gravação de tela do painel em operação, 720p30, 2:47
# SAÍDAS: video/demo-visao-patio.mp4 (1080p30) + video/demo-visao-patio-720p.mp4 (WhatsApp)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
V1="$REPO/video/20260725_120848.mp4"
V2="$REPO/video/VID-20260725-WA0022.mp4"
for f in "$V1" "$V2"; do
  [ -f "$f" ] || { echo "ERRO: fonte ausente: $f (mídia bruta não é versionada — ver docs/analises/demo-video-roteiro.md)"; exit 1; }
done
T="${TMPDIR:-/tmp}/demo-visao-patio"
rm -rf "$T" && mkdir -p "$T"
cd "$T" # o drawtext do ffmpeg não aceita 'C:/…' em fontfile — fontes copiadas p/ cá e usadas por caminho relativo
BG=0x0b0f14 # mesmo fundo do painel (going-gray: a cor fica para a informação)
cp -f /c/Windows/Fonts/segoeuib.ttf fb.ttf 2>/dev/null || cp -f /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf fb.ttf
cp -f /c/Windows/Fonts/segoeui.ttf fr.ttf 2>/dev/null || cp -f /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf fr.ttf
FT=fb.ttf
FR=fr.ttf

# Legenda simples (uma linha) e legenda com CONTEXTO (título + explicação) — scrim escuro
# atrás do texto para legibilidade sobre qualquer cena.
lt() { echo "drawtext=fontfile=$FR:text='$1':fontsize=44:fontcolor=0xe6edf3:x=(w-text_w)/2:y=h-150:box=1:boxcolor=$BG@0.78:boxborderw=22"; }
lt2() { echo "drawtext=fontfile=$FT:text='$1':fontsize=46:fontcolor=0xe6edf3:x=(w-text_w)/2:y=h-190:box=1:boxcolor=$BG@0.80:boxborderw=20,drawtext=fontfile=$FR:text='$2':fontsize=30:fontcolor=0x9fb4c9:x=(w-text_w)/2:y=h-118:box=1:boxcolor=$BG@0.80:boxborderw=14"; }

# S0 — card de abertura (3s)
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=$BG:s=1920x1080:d=3:r=30" -vf "\
drawtext=fontfile=$FT:text='Visão de Pátio':fontsize=96:fontcolor=0xe6edf3:x=(w-text_w)/2:y=(h/2)-90,\
drawtext=fontfile=$FR:text='inteligência operacional por câmeras':fontsize=42:fontcolor=0x7dd3fc:x=(w-text_w)/2:y=(h/2)+30,\
drawtext=fontfile=$FR:text='demonstração em CD industrial':fontsize=30:fontcolor=0x8b949e:x=(w-text_w)/2:y=(h/2)+100,\
fade=t=in:st=0:d=0.4,fade=t=out:st=2.6:d=0.4" -an "s0.mp4"

# S1 — galpão real em câmera lenta 0.35× (fonte 0.0–1.7s → ~4.9s)
ffmpeg -hide_banner -loglevel error -y -ss 0 -t 1.7 -i "$V1" -vf "\
setpts=PTS/0.35,fps=30,scale=1920:1080,$(lt 'CD industrial — operação real'),\
fade=t=in:st=0:d=0.3,fade=t=out:st=4.5:d=0.3" -an "s1.mp4"

# S2 — o HARDWARE: a câmera SICK no tripé sobre a operação (1.9–3.3s → ~4.0s)
ffmpeg -hide_banner -loglevel error -y -ss 1.9 -t 1.4 -i "$V1" -vf "\
setpts=PTS/0.35,fps=30,scale=1920:1080,$(lt2 'câmera industrial SICK' 'filma a operação e entrega o vídeo por RTSP direto ao hub — sem infraestrutura extra'),\
fade=t=in:st=0:d=0.3,fade=t=out:st=3.7:d=0.3" -an "s2.mp4"

# S3 — a PONTE físico→digital: o notebook com o painel ao lado das caixas reais (3.4–6.3s)
ffmpeg -hide_banner -loglevel error -y -ss 3.4 -t 2.9 -i "$V1" -vf "\
setpts=PTS/0.6,fps=30,scale=1920:1080,$(lt2 'da cena real ao painel' 'o mesmo corredor, agora com zonas e estados sobre a imagem ao vivo'),\
fade=t=in:st=0:d=0.3,fade=t=out:st=4.5:d=0.3" -an "s3.mp4"

# Recorte da gravação de tela: fora as abas do navegador (topo 100px) e a taskbar → só o painel.
# Depois upscale 720p→1080p (lanczos) e letterbox no tom do produto.
V2F="crop=1280:576:0:100,scale=1920:864:flags=lanczos,pad=1920:1080:0:108:color=$BG,fps=30"

# S4 — detecção de pessoa em tempo real (30–40s)
ffmpeg -hide_banner -loglevel error -y -ss 30 -t 10 -i "$V2" -vf "\
$V2F,$(lt2 'detecção de pessoas em tempo real' 'o operador entra no corredor e é detectado — sem crachá, marcador ou app; análise no servidor, 24/7'),\
fade=t=in:st=0:d=0.3,fade=t=out:st=9.7:d=0.3" -an "s4.mp4"

# S5 — A CENA-CHAVE (pedido do dono): EMPILHADEIRA operando → corredor fica LENTA (amarelo);
# corredor sem movimentação vira ALERTA (vermelho) com aviso no painel. Trecho 78–96s.
ffmpeg -hide_banner -loglevel error -y -ss 78 -t 18 -i "$V2" -vf "\
$V2F,$(lt2 'estados por corredor — automáticos' 'a empilhadeira trabalha e o corredor fica LENTA; corredor sem movimentação vira ALERTA e avisa no painel'),\
fade=t=in:st=0:d=0.3,fade=t=out:st=17.7:d=0.3" -an "s5.mp4"

# S6 — o INDICADOR: permanência por área subindo até 18s (154–166s)
ffmpeg -hide_banner -loglevel error -y -ss 154 -t 12 -i "$V2" -vf "\
$V2F,$(lt2 'tempo de permanência por área' 'quanto tempo cada área ficou ocupada — o indicador nasce da câmera, sem apontamento manual'),\
fade=t=in:st=0:d=0.3,fade=t=out:st=11.7:d=0.3" -an "s6.mp4"

# S7 — fecho em câmera lenta 0.25× (0.2–1.3s → ~4.4s)
ffmpeg -hide_banner -loglevel error -y -ss 0.2 -t 1.1 -i "$V1" -vf "\
setpts=PTS/0.25,fps=30,scale=1920:1080,$(lt 'simples de instalar — direto ao indicador'),\
fade=t=in:st=0:d=0.3,fade=t=out:st=4.0:d=0.4" -an "s7.mp4"

# S8 — card final (3s)
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=$BG:s=1920x1080:d=3:r=30" -vf "\
drawtext=fontfile=$FT:text='Visão de Pátio':fontsize=84:fontcolor=0xe6edf3:x=(w-text_w)/2:y=(h/2)-60,\
drawtext=fontfile=$FR:text='hardware industrial + IA de visão — do chão de fábrica ao indicador':fontsize=36:fontcolor=0x7dd3fc:x=(w-text_w)/2:y=(h/2)+40,\
fade=t=in:st=0:d=0.4,fade=t=out:st=2.5:d=0.5" -an "s8.mp4"

# Concat (mesmo codec/fps em todos os segmentos → concat de demuxer, sem re-encode extra) + exportes
printf "file '%s'\n" s0.mp4 s1.mp4 s2.mp4 s3.mp4 s4.mp4 s5.mp4 s6.mp4 s7.mp4 s8.mp4 > lista.txt
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i lista.txt -c:v libx264 -preset slow -crf 19 -pix_fmt yuv420p -movflags +faststart "$REPO/video/demo-visao-patio.mp4"
ffmpeg -hide_banner -loglevel error -y -i "$REPO/video/demo-visao-patio.mp4" -vf scale=1280:720 -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p -movflags +faststart "$REPO/video/demo-visao-patio-720p.mp4"
echo "PRONTO:" && ls -la "$REPO"/video/demo-visao-patio*.mp4
