# ADR-021 — Imagem de REFERÊNCIA por câmera (estreitamento do ADR-002)

**Data:** 2026-09-17
**Estado:** aceito
**Decisor:** dono do produto (pedido explícito)
**Toca:** ADR-002 (LGPD / local-first — "nenhuma imagem/frame é persistida no servidor")

## Contexto

Desde 17/09/2026 o painel do papel `cliente` não exibe vídeo ao vivo: mostra as zonas
desenhadas em SVG (ver `src/routes/dashboard/zonasEstaticas.ts`). A medição que motivou está
lá — painel aberto levou o load da máquina de 8,04 para 15,63 em 4 vCPU, e ficou aberto 17%
das horas de uma semana, disputando CPU com a análise que gera o alerta.

O desenho resolveu o custo, mas o dono levantou uma perda real: **polígonos flutuando no vazio
não dizem ao cliente ONDE é aquilo.** Ele recebe "presença em área proibida (Cofre)", abre o
painel e vê um retângulo vermelho sem referência física.

O pedido: o **admin** poder pôr uma imagem estática de fundo, para o cliente ter noção do lugar.

## A distinção que decide este ADR

O ADR-002 proíbe persistir **frame/imagem** no servidor. A razão dele não é a palavra "imagem" —
é o que um frame de câmera contém: **pessoas identificáveis, capturadas continuamente e sem
consentimento no instante da captura.** Frame do pipeline é dado pessoal por construção.

O que se autoriza aqui é outra coisa, e a diferença é inteira:

| | Frame do pipeline (PROIBIDO, ADR-002) | Imagem de referência (permitido, este ADR) |
|---|---|---|
| Origem | capturado pelo sistema, automático | **enviado por um humano**, arquivo escolhido |
| Conteúdo | o que estava na frente da câmera | o que o admin decidiu mostrar |
| Cadência | contínua | uma vez, e só muda se alguém trocar |
| Quem responde | ninguém olhou antes de salvar | o admin que subiu, avisado na tela |

É a mesma natureza de uma **planta baixa** ou de um croqui do galpão: material de referência do
local, não vigilância. O sistema continua **sem nenhum caminho automático** que persista frame:
não há captura do feed, não há "salvar quadro atual", não há botão que puxe do vídeo.

## Decisão

1. Permitir **uma** imagem de referência por câmera, **enviada por upload** de quem tem
   `superadmin`. Nunca capturada do feed pelo sistema.
2. Ela é servida ao cliente como FUNDO do desenho de zonas, e a nada mais.
3. A tela de upload **avisa por extenso**: a imagem fica no servidor e é vista pelo cliente —
   suba o pátio vazio, uma planta ou um croqui, nunca uma foto com pessoas.
4. Limites duros no servidor: tipo (`image/jpeg`, `image/png`, `image/webp`), tamanho (2 MB) e
   uma imagem por câmera (substitui, não acumula).
5. Fica no diretório de ESTADO (`VISAO_STATE_DIR`, o volume) e **no `.gitignore`** — como todo
   estado de runtime. Nunca versionada, nunca em backup de código.
6. Removível: `DELETE` apaga o arquivo e o cliente volta ao desenho sem fundo.

## Consequências

**Ganho:** o cliente passa a ter referência física das áreas sem que o produto volte a
transmitir vídeo. O custo de CPU continua zero — a imagem é estática, servida uma vez e
cacheada pelo navegador.

**Custo aceito:** existe agora UM arquivo de imagem por câmera no volume. Se o admin subir uma
foto com pessoas, isso é dado pessoal em disco — e a responsabilidade é de quem subiu, que foi
avisado na tela. O sistema não tem como impedir, do mesmo jeito que não impede alguém de
escrever um CPF no rótulo de uma zona.

**O que NÃO muda:** o ADR-002 segue valendo inteiro para o pipeline. Frames continuam efêmeros
em memória no relé e no motor; o cine-loop continua em memória; evento de alarme continua só
metadados. Nenhum caminho automático de persistência de frame foi aberto.

**Risco residual declarado:** a imagem envelhece. Um layout que mudou deixa o fundo mentindo
sobre o lugar — e, ao contrário do vídeo, nada avisa. Mitigação: a tela mostra a data do envio
ao lado do fundo, para quem olha saber de quando é.
