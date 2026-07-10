# Plano de implementação — **Modo por Zona** (uma câmera, múltiplos modos)

> O modo deixa de ser propriedade da **câmera** e passa a ser propriedade da **zona** desenhada. Uma câmera conecta uma vez; o usuário desenha retângulos e atribui a cada um um modo (Atividade / Leitura / Objetos / Operador-Fadiga). Vários modos rodam simultâneos em regiões diferentes do mesmo feed, com config + visualização consolidadas numa só interface. Pragmático, incremental, sem regressão.

## 1. Princípio de design
- **Reuso máximo**: os 4 pipelines já existem e funcionam. A mudança é de **empacotamento** (de "componente de tela por modo" para "processador por zona"), não de algoritmo.
- **Sem regressão**: cada fase compila e mantém o app utilizável. O modo-de-câmera atual vira o caso particular de "uma zona cobrindo o quadro inteiro".
- **Modelos compartilhados no nível do frame**: nunca rodar o mesmo modelo N vezes por causa de N zonas.

## 2. Modelo de dados
Zona passa a carregar **modo + config específica** (hoje a zona só existe no modo atividade):
```ts
type ZoneMode = "atividade" | "leitura" | "objetos" | "fadiga";
type Zone = Rect & {
  id: string; label: string; modo: ZoneMode;
  cfg: ZoneCfg; // união discriminada por modo
};
// atividade: { idleAlertMs, sensitivity, atividade }
// leitura:   { ponto }
// objetos:   { selectedClasses }
// fadiga:    { } (rosto próximo; ver §5)
```
- Persistência: estende o store de zonas atual (`vp-zones-<cameraId>`), agora com `modo`+`cfg`.
- **`cameraConfig` encolhe** para o que é físico da câmera: `{ capture }` (resolução/fps). `pontoLeitura`/`selectedClasses`/`modo` saem de lá e vão para a **cfg da zona**.
- **Migração automática (1ª carga)**: câmera com `modo` legado (leitura/objetos/fadiga) e sem zonas-com-modo → cria uma zona full-frame daquele modo com a config equivalente. Zonas de atividade existentes (sem `modo`) → `modo:"atividade"`. Nada se perde.

## 3. Arquitetura: "processador de zona"
Extrair o núcleo de cada modo (hoje preso dentro de CameraView/ReadingView/ObjectsView/FadigaView) para módulos **headless** (sem JSX) com interface comum:
```ts
interface ZoneProcessor {
  process(frame: FrameSource, roi: Rect, now: number): void; // roda só na ROI da zona
  draw(ctx, map): void;        // desenha o overlay da zona no canvas compartilhado
  snapshot(): ZonePanelData;   // dados p/ o painel lateral unificado
  recordTick?(now): void;      // histórico (F3)
  dispose(): void;
}
// createAtividadeProcessor(zone) / createLeituraProcessor(zone) / createObjetosProcessor(zone) / createFadigaProcessor(zone)
```
- **`CameraWorkspace`** (componente novo, 1 por câmera): dona do feed, do loop rAF, da lista de zonas e do editor. A cada frame: desenha o feed → para cada zona chama `process()` + `draw()` → compõe o painel lateral com os `snapshot()` de cada zona.
- **Compartilhamento de modelos** (essencial p/ desempenho):
  - **coco-ssd**: 1 `detect()` por frame por câmera (já é singleton); zonas de **atividade** e o fallback de **objetos** consomem o mesmo resultado, filtrando por ROI. Nunca por-zona.
  - **motion diff**: barato, calculado por ROI.
  - **Leitura (ZXing/BarcodeDetector)**: decode por ROI no worker já existente (1 worker, fila).
  - **Objetos (OWL-ViT)**: por ROI da zona no worker já existente; **cap** de zonas simultâneas (§5).
  - **Fadiga (MediaPipe)**: por zona; modelo pesado → idealmente 1 zona de fadiga por câmera (§5).

## 4. UI/UX (o ganho de usabilidade)
- **Editor unificado**: abrir a câmera → desenhar retângulo → **escolher o modo** num seletor compacto (chips coloridos por modo) → ajustar a mini-config daquele modo ali mesmo. Reusa o desenho de zonas que já existe no modo atividade.
- **Overlay composto**: faixa de leitura, caixas de objetos, estados de atividade e monitor de fadiga aparecem **sobrepostos no mesmo feed**, cada um com a cor/rótulo da sua zona.
- **Painel lateral unificado**: uma seção por zona (cor do modo + nome), mostrando o snapshot daquele modo (taxa de leitura, contagem de objetos, estado de atividade, risco do operador). Sem trocar de tela.
- **Lista de zonas**: editar/renomear/remover/trocar modo; realce ao passar o mouse.
- **Cores semânticas por modo** (tokens já existentes): atividade=verde, leitura=accent, objetos=âmbar/categórico, fadiga=vermelho.

## 5. Desempenho e limites (pragmatismo)
- **Teto de zonas pesadas por câmera** (config): ex. ≤ N zonas de Objetos (OWL-ViT) e ≤ 1 de Fadiga; acima disso, avisar e degradar cadência.
- **Throttle por modo** mantido (decode ~8/s, objetos ~1.5s, atividade ~3/s) e **escalonamento round-robin** quando há muitas zonas (processa uma por vez para não travar o frame).
- **Fadiga** precisa de rosto nítido: a zona de fadiga deve sugerir recorte fechado no operador; a UI sinaliza requisito de resolução/ângulo. Não compartilha modelo entre câmeras (MediaPipe VIDEO mantém timestamp).
- **Telemetria** (FrameMeter já criado) por câmera + por zona pesada → mostrar FPS/latência e ajudar a calibrar o teto.

## 6. Histórico / relatório por zona
- Gravação passa a ser chaveada por **(câmera, zona, modo)** em vez de só por câmera. Os stores por modo já existem (atividade/leitura/objetos/fadiga); adiciona-se o identificador de zona.
- Relatório: os 4 modos já têm aba/seletor; ganham o **recorte por zona** (filtro). O "setor" do modo objetos e o "ponto" do modo leitura passam a derivar da zona.

## 7. Retrocompatibilidade
- Migração automática (§2) preserva tudo. Enquanto a migração e os processadores não cobrem um modo, aquele modo segue pelo caminho antigo (coexistência temporária), removido no final.

## 8. Fases (incremental, cada uma compila e é usável)
- **F1 — Extrair processadores (headless), sem mudar UX.** Mover o núcleo dos 4 modos para `processors/*` com a interface comum; refatorar cada *View para **usar** seu processador (Views viram cascas finas). Zero mudança visível → de-risca o resto. Pode ser feito 1 modo por vez (começar por Atividade, o mais simples).
- **F2 — `CameraWorkspace` multi-zona.** Modelo de zona com modo+cfg + migração + editor de zonas com seletor de modo + overlay composto + painel unificado. DashboardPage passa a renderizar workspace por câmera; modelos compartilhados no nível do frame. (Entrega o valor central.)
- **F3 — Histórico/relatório por zona.** Chave (câmera×zona×modo); filtro por zona no relatório.
- **F4 — Polish/desempenho.** Teto de zonas, escalonamento, dica de fadiga, drill-in por zona, consolidação visual fina; remoção do caminho antigo.

## 9. Riscos / atenção
- **Custo de extração** (F1): os 4 componentes são maduros e acoplados a estado React; extrair com cuidado, um por vez, validando build a cada passo.
- **Desempenho com muitas zonas**: mitigar com compartilhamento de modelo, throttle, round-robin e teto.
- **Fadiga como zona**: requisito de rosto próximo; manter como caso especial bem sinalizado.
- **Sobreposição de zonas**: processadores independentes por ROI (sem acoplamento) — simples e previsível.

## 10. Em uma frase
Extrair os 4 pipelines em **processadores de zona** reutilizáveis e rodá-los, **um por zona desenhada**, dentro de um único **CameraWorkspace** — com modelos compartilhados no nível do frame, overlay e painel consolidados, migração automática do modo-de-câmera atual e histórico por zona. Começo pela extração (F1), que não muda nada para o usuário e destrava o resto.
