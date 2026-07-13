# SPEC — A tela da câmera: calibrar é um MODO, não uma camada empilhada

> Status: **em execução** · Data: 2026-07-13
> Queixa do dono: *"com a junção calibração+câmera os elementos estão totalmente sobrepostos."*
> + pedido: *"não vejo o círculo em cada antena"* → decisão: **marcador + anel de CADA antena**
> (SEM ponto triangulado — trilateração por RSSI foi refutada, n=29.907, piso 1,20 m vs 0,49 m).
> Insumos: 2 auditorias read-only (stacking / inventário+mercado).

## 1. A causa-raiz (medida, não suposta)

**Não é z-index.** A escala `--z-*` já existe; o SVG de calibração acompanha o content-rect e não
tapa o drawer. A causa é: **entrar no modo calibrar NÃO desliga nada.** Com `cal.active`:
- o canvas segue desenhando tracks + zonas + tripwires + anéis de BLE + **a malha de calibração
  SALVA** (`drawScene`, CameraWorkspace.tsx:1262-1297, sem gate em `cal.active`);
- o SVG (`CalibrationLayer`) desenha os marcadores VIVOS da calibração **por cima**;
- **a malha salva (canvas) e a grade viva (SVG) são DUAS grades de chão idênticas empilhadas**;
- o header segue com Zona/Polígono/Linha; a KPI bar com 11 itens; o drawer com 7 abas espremidas
  (`cine.css:146` ainda diz "5 triggers" — recebeu 7).

Operação e calibração desenham o mesmo chrome ao mesmo tempo. É isso o "totalmente sobreposto".

## 2. O padrão (mercado + doutrina)

**Modo = estado que reconfigura o chrome.** Figma Dev Mode (troca a toolbar + o painel inteiro,
canvas vira read-only), Photoshop (Options Bar muda por ferramenta), Milestone (Setup mode substitui
a operação). NN/g: não misturar os vocabulários de dois modos ao mesmo tempo. Fonte-âncora:
Figma Dev Mode + NN/g "Modes in User Interfaces".

## 3. O conserto — Frente A: calibrar reconfigura a tela

**Ao entrar em Calibrar (`cal.active === true`):**
1. **`drawScene` gateia as camadas de OPERAÇÃO** — não desenha tracks, zonas, tripwires, floor-tags
   nem a malha-salva. O palco mostra só o vídeo + a calibração viva (o SVG). Mata a dupla-grade e o
   amontoado numa tacada. (O gate vive na função pura de decisão, testável.)
2. **Header**: os toggles Zona/Polígono/Linha SOMEM em Calibrar (já são mutuamente exclusivos na
   lógica — só falta sumir da UI). "Calibrar" vira o toggle de saída, destacado (estado ativo claro).
3. **KPI bar**: reduz ao essencial em Calibrar (Malha/Tags/HUD de operação sã redundantes — a grade
   de conferência é a própria calibração).
4. **Drawer**: em Calibrar, o painel mostra SÓ o passo-a-passo da calibração — não a 7ª aba entre as
   de operação. Sair volta à operação com as abas normais.
5. **ESC / botão sai do modo** (spring-loaded: o estado é claro e reversível).

**Secundário (fecha o G4 da spec de padronização):**
6. Matar os `z-index: 6` crus (`cine.css:16,43`) → escala `--z-*`.
7. Resolver a dupla definição de `.cam-drawer` (`index.css:1669` absolute × `cine.css:371` static) —
   uma verdade só.
8. `.cam-stage` ganha stacking context próprio (`isolation:isolate` ou z-index) para os z dos filhos
   não vazarem ao contexto do overlay.

## 4. O conserto — Frente B: marcador + anel de CADA antena (o overlay honesto)

Hoje `useFloorTags` desenha o marcador e o anel **só da estação principal** (`station`); as N
estações (`stations`) são inertes de propósito (o comentário barra a trilateração — corretamente).
**A mudança é honesta e limitada:**
1. **Marcador em CADA antena** no chão (todas as de `calibration.stations`), rotulado com o nome da
   estação (útil: o operador vê onde está cada antena).
2. **Anel de distância de CADA antena** para cada tag visível: "a tag está a ~2 m da antena A e
   ~3 m da antena B". Cada anel usa o RSSI **daquela fonte** (`distByStation`/pool por fonte), não o
   RSSI da principal para todas.
3. **NUNCA o ponto de interseção.** A doutrina do arquivo permanece: 1 antena = distância; a
   interseção herda o erro de duas e cai na mesa errada. Não se desenha posição que não existe.
4. Going-gray: anel neutro; só satura em anomalia (residual alto).

**Pré-condição operacional (não é bug):** o anel só aparece com **tag do projeto (OUI 48:87:2D)
em cena** e leitura viva. Sem tag Grendene por perto, não há raio a desenhar — é o estado correto.

## 5. Invariantes (não violar)
- **ADR-007**: a casca fullscreen NÃO vira Radix Dialog. O gate de camadas é no `drawScene`/estado,
  nunca remontando o canvas.
- **ADR-003**: a imagem é soberana — o gate ESCONDE overlays, nunca tapa o vídeo.
- **Ratchet** do `CameraWorkspace.size.test.ts`: extrair, não levantar o teto.
- **Regra 11 / honestidade**: não desenhar precisão que a medição não sustenta (o ponto triangulado).

## 6. Verificação
- Unit: a função de decisão "quais camadas em cada modo" (pura, testável) + o `deriveFloorView` com
  N estações (marcador+anel por fonte, sem interseção).
- e2e: entrar em Calibrar esconde os toggles de operação; sair os traz de volta; a tela não empilha.
- Controle negativo obrigatório em cada gate (injeta a falha → vermelho → reverte → verde).
