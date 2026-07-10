# Calibração de câmera — o problema do X,Y avulso e como o mercado resolve

> Feedback do dono: "a câmera pode estar em qualquer posição, então X,Y não são suficientes para
> definir o ponto." Correto sobre a UX/robustez. Pesquisa do estado da arte + proposta. Honestidade
> técnica: separo o que a MATEMÁTICA já resolve do que a nossa UX faz mal.

## O que a homografia JÁ resolve (não é o problema)
Uma **homografia de plano** (3×3) mapeia pixel ↔ chão para QUALQUER posição/ângulo de câmera pinhole —
os 8 graus de liberdade da H absorvem rotação + translação + intrínsecos projetados no plano. Então
"a câmera em qualquer posição" **é coberto pela H** — PARA PONTOS NO CHÃO. E o nosso caso é esse: a
pessoa é localizada pelo **PÉ** (bottom-center da caixa), que está no chão (Z=0). Isso é o padrão de
mercado p/ rastreio de pessoas em superfície plana (ground-plane homography). Fontes abaixo confirmam.

**Limite honesto:** a H só coloca pontos que estão NO PLANO (chão). Um ponto FORA do chão (cabeça,
objeto numa prateleira) precisa da altura — 1 homografia de chão não resolve. E lente muito grande-angular
(distorção) quebra a suposição pinhole → aí precisa corrigir distorção (calibração intrínseca).

## Onde ERRAMOS (o problema real): a UX de obter a H
Hoje pedimos **X,Y em metros de 4 pontos AVULSOS** — o operador teria que saber "esse ponto do chão é
(3,2, 1,5) m". Ninguém sabe. É frágil (qualquer inconsistência entre os 4 quebra a H) e impraticável.
**A matemática está certa; o MÉTODO de calibrar está errado.**

## Como o mercado faz (obter a H sem coordenadas avulsas)
1. **Retângulo de dimensão conhecida (o mais comum):** o operador marca os 4 CANTOS de um retângulo REAL
   no chão (uma área demarcada, um pallet, um tapete, N ladrilhos) e digita só **largura × comprimento**
   (2 números). A H sai dos 4 cantos ↔ (0,0),(L,0),(L,C),(0,C). Fácil, robusto, reusa a nossa `computeHomography`.
2. **Distâncias de referência:** marca pares de pontos e informa a distância real de cada par (metros).
3. **Homografia de ALTURA:** p/ medir objetos fora do chão, calibra uma 2ª homografia por altura conhecida
   (estende p/ superfícies planas em alturas dadas) — só se precisarmos de pontos fora do piso.
4. **Calibração 3D completa (tabuleiro de xadrez):** intrínsecos (foco/distorção) + extrínsecos. Corrige
   lente e mapeia pontos 3D arbitrários — mais pesado (precisa do padrão + OpenCV-like). Só se a distorção
   for forte ou precisarmos de 3D real.
5. **Auto-calibração por pessoas em movimento:** infere o chão pelo movimento de pedestres (sem alvo/UX) —
   avançado; alguns produtos de vigilância fazem.

## Proposta (o que melhorar, na ordem)
1. **Trocar a UX por "retângulo de dimensão conhecida"** (item 1) — mantém a homografia (nosso módulo já
   faz DLT com 4+ pontos), muda só a captura: marcar 4 cantos de um retângulo do chão + digitar L×C. É o
   maior ganho de praticidade/robustez, baixo custo (reusa `computeHomography`, só a UI muda). Manter também
   a opção de distâncias de referência (item 2) p/ quem não tem um retângulo limpo.
2. **Checagem visual da qualidade:** projetar de volta uma **grade métrica** (ex.: linhas a cada 1 m) sobre
   a imagem — se a grade "assenta" no chão, a calibração está boa. Mercado sempre mostra isso; dá confiança
   e pega erro de marcação na hora.
3. **Deixar explícito que localizamos o PÉ no chão** (Z=0) — correto e suficiente p/ a tag na pessoa. Pontos
   fora do chão (item 3) e correção de distorção (item 4) ficam como evolução SE o campo exigir.

## Recomendação
Implementar **1 (retângulo conhecido) + 2 (grade de verificação)**. Reusa toda a matemática atual
(`homography.ts`), troca a `CalibrationPanel` da entrada "X,Y por ponto" para "marque um retângulo + L×C",
e some a grade de conferência. Não precisa de calibração 3D/tabuleiro p/ o caso pessoa-no-chão — isso só
entra se houver distorção forte de lente ou necessidade de medir fora do piso.

## Fontes
- Ground-plane homography p/ rastreio em superfície plana (padrão): pesquisa IEEE/ResearchGate
  "Online extrinsic multi-camera calibration using ground plane induced homographies".
- Homografia de altura p/ objetos fora do chão: "visual measurement extended for arbitrary planar surfaces
  with known heights".
- Auto-calibração por pedestres: "recover parameters of a static surveillance camera based on appearance
  and motion of persons".
