# Plano — 3º modo de câmera: "Identificação de Objetos / Contagem"

> Novo **modo de câmera** (não confundir com Atividade). Objetivo: a câmera **reconhece e conta** objetos/equipamentos de uma **lista predefinida selecionável** (ex.: pessoa, caixa, palete, empilhadeira, paleteira) e um **painel mostra/conta** o que está em cena — por câmera e **por setor (zona)**. Casos de uso: *"a empilhadeira está fisicamente no Setor X?"*, *"tem alguém carregando uma caixa?"*, *"quantas caixas/paletes parados na doca?"*. **Aditivo**, mesma base do projeto (hub/socket/ImageBitmap/IndexedDB/shell). UI minimalista, semântica, sem scroll. **Sem código ainda — plano.**

---

## STATUS (2026-06-09): MODO COMPLETO — F0 + F1 + F2 + F3 + F4, build verde
**F4 (alertas de presença):** `ObjectsView` detecta entrada/saída de cada (setor,classe) com histerese (1.8s; pessoa excluída; sem burst inicial) → toast na central + evento gravado (entrada/saida). Report: KPI carregamentos só conta carregamento; aba "Eventos" lista entrada/saida/carregamento. Os 3 modos prontos.

**F3 (histórico+relatório):** `store` VER 3 (`objectBuckets` setor|classe|hora: samples/countSum/peak/present; `objectEvents` carregamento); `ObjectsView` grava (acumula 1×/s, emite 5×; evento carregamento debounce 4s); `mock` com agregações (presença matriz setor×classe %, ranking setor/classe, heatmap classe×hora, tendência, eventos, seed); `ReportPage` ganhou **3º modo Objetos** (KPIs objetos médios/pico/predominante/presença%/carregamentos + abas Quando/Setor×Classe/Tendência/Carregamentos + filtro setor + CSV). **Próximo: F4 alertas de presença/ausência por setor + acabamento.**

**F2 (OWL-ViT real):** `@xenova/transformers` instalado; `objects/owlvitWorker.ts` (pipeline `zero-shot-object-detection`, modelo `Xenova/owlvit-base-patch32`, recebe RGBA+labels, devolve boxes); `objects/detector.ts` usa OWL-ViT como **primário** (worker) e coco-ssd como **andaime** enquanto o modelo carrega; `config.objects` (model/procWidth 640/threshold 0.1/detectIntervalMs 700); **CSP liberou** `huggingface.co`/`*.hf.co` no `connect-src` (transformers.js baixa o modelo do HF na 1ª vez). Chunk `owlvitWorker-*.js` (~808kB, onnxruntime-web) é lazy — só carrega no modo objetos. Notas: 1ª carga baixa o modelo (precisa internet, depois cacheia); OWL-ViT ~1-3s/inferência (ok p/ presença); ajustar `threshold` por ambiente. **Próximo: F3 histórico/relatório, F4 alertas de presença/carregamento.**

## STATUS — F0 + F1 (andaime)
`objects/catalog.ts` (5 classes: pessoa/caixa/empilhadeira/palete/paleteira; coco+prompts+cor). `cameraConfig` (modo `objetos` + `selectedClasses[]`). `objects/detector.ts` (backend coco-ssd; assinatura pronta p/ owlvit). `ObjectsView.tsx` (tile com chips de contagem; console full: inventário + **matriz Setor×Classe** reusando zonas; heurística pessoa×caixa = carregamento; bbox coloridos por classe). `DashboardPage` (seção objetos na grade + overlay + seletor de classes em chips no modal ⚙). Hoje só **pessoa** é detectada (coco-ssd); caixa/empilhadeira/palete entram no **F2 (OWL-ViT)**. **Próximo: F2 — adicionar `@xenova/transformers` + worker OWL-ViT (precisa npm install).**

## 0. Decisões travadas (2026-06-09)
- **Motor:** **Zero-shot OWL-ViT/OWLv2 via transformers.js** (detecção por texto, sem treino). Roda em **worker**, cadência baixa (~2–4 s), lazy-load (chunk próprio). Dep a adicionar: `@xenova/transformers`.
- **Lista inicial de objetos:** **pessoa, caixa (caixa de papelão), empilhadeira, palete, paleteira**. Cada um vira `prompt(s)` em PT/EN no catálogo (ex.: empilhadeira → "forklift").
- **Faseamento ajustado:** como caixa/palete/empilhadeira **só** aparecem no OWL-ViT, o andaime coco-ssd (F1) valida só **pessoa**; a entrega real vem no F2. Construir F1 e F2 em sequência curta.

## 1. Viabilidade e a decisão central (qual modelo)
O detector atual (`coco-ssd`, classes COCO) **não tem "caixa" nem "empilhadeira"**. Ele tem `person`, `truck`, `car`, `backpack`, `suitcase`, etc. Para enxergar caixa/empilhadeira de verdade, precisamos de um modelo que conheça essas classes. Três caminhos:

| Opção | Como | Caixa/Empilhadeira? | Velocidade | Custo de montagem | Offline |
|---|---|---|---|---|---|
| **A. coco-ssd (já temos)** | classes COCO | ❌ (só pessoa, caminhão, bolsa/mala) | rápido (já roda) | zero | sim |
| **B. Zero-shot OWL-ViT/OWLv2 (transformers.js)** | detecção **por texto** ("empilhadeira", "caixa de papelão", "palete") — **sem treinar** | ✅ qualquer rótulo da lista | lento (≈1–4 s/inferência em WASM; melhor com WebGPU) | baixo (só adicionar lib + worker) | sim |
| **C. YOLO treinado (onnxruntime-web)** | YOLOv8/v11 **fine-tunado** num dataset de logística (Roboflow Universe tem datasets de forklift/box/pallet) → exporta ONNX | ✅ classes do treino | rápido (~real-time) | alto (dataset + treino + export) | sim |

**Recomendação:** **B (zero-shot)** é o melhor encaixe para "lista predefinida selecionável" com caixa/empilhadeira **sem precisar treinar** — e como o objetivo é **presença/contagem** (não rastreio fino a 8 fps), rodar a inferência a cada ~2–4 s já resolve "a empilhadeira está no setor?". A lentidão deixa de ser problema nessa cadência. **A** serve de **andaime imediato** (validar UX/painel hoje com pessoa/caminhão). **C** fica como evolução para produção (velocidade/robustez), alinhada à task #28 (borda/nuvem).

---

## 2. Modelo de modo (igual ao padrão Leitura)
- `cameraConfig`: `modo: "atividade" | "leitura" | "objetos"`. Default segue `atividade` (retrocompatível).
- Config por câmera do modo objetos: **`selectedClasses: string[]`** (subconjunto do catálogo) + cadência de inferência + (reusa as **zonas** existentes como **setores**).
- Catálogo predefinido (`objects/catalog.ts`): `[{ key, label, prompts?, color }]` — ex.: `pessoa, caixa, palete, empilhadeira, paleteira, caminhão, carrinho`. Em zero-shot, `prompts` são os textos enviados ao modelo ("empilhadeira", "forklift", "caixa de papelão"…). Em coco-ssd, mapeia para as classes COCO equivalentes.

## 3. Pipeline (novo `ObjectsView.tsx`, irmão de ReadingView)
- Reusa o **shell de feed** (ImageBitmap → canvas, tile/full) já padronizado.
- Detecção **em worker** (como o ZXing) p/ não travar o feed — essencial para OWL-ViT, que é pesado. `objects/detector.ts` abstrai o backend (coco-ssd | owlvit) atrás de `detect(bitmap, classes) → [{class, score, bbox}]`.
- Cadência configurável (ex.: 1 inferência a cada 2–4 s no zero-shot; mais rápida no coco-ssd).
- Para cada detecção: desenha bbox + rótulo + score; atribui a um **setor** (zona) por centro do bbox (reusa `zoneAt`); atualiza **contagens por classe** e **por setor**.
- **Eventos/heurísticas:**
  - *Presença por setor*: classe X presente/ausente no Setor Y (com histerese p/ anti-flicker). Alerta opcional "empilhadeira ausente do Setor X" ou "empilhadeira detectada no Setor X".
  - *"Pessoa carregando caixa"*: bbox de `pessoa` sobreposto/encostado em bbox de `caixa` → evento "carregamento manual".

## 4. Painel (a tela que o usuário pediu) — minimalista e semântico
- **Tile (grade):** miniatura do feed + **chips de contagem** das classes selecionadas (ex.: `🧍 2 · 📦 5 · 🚜 1`), cor semântica por classe; dot de status (detectando/ocioso).
- **Console (drill-in):** feed com caixas desenhadas + **inventário ao vivo** (lista classe → contagem, com seta ↑/↓ na variação) + **matriz Setor × Classe** (presente/contagem por setor) — responde direto "empilhadeira no Setor X?". Eventos recentes (entrou/saiu, carregamento manual).
- **Card por câmera/ponto** consistente com os cards de ponto da leitura (mesma linguagem visual: tokens `--sp-*`, chips `.badge.*`, números mono).

## 5. Histórico + Relatório (fase posterior)
- `store`: `objectBuckets` (por câmera/setor/classe/hora: contagem média, pico, presença em minutos) + `objectEvents` (entrou/saiu/carregamento). Bump `VER`. (LGPD: só contagens/indicadores, nunca imagens; pessoa = contagem anônima.)
- Relatório ganha 3º modo no seletor: KPIs (objetos médios/pico, % de presença da empilhadeira por setor, nº de carregamentos), abas Quando/Onde(setor×classe)/Tendência/Eventos.

## 6. Reuso x novidade
- **Reusa:** hub/socket binário, ImageBitmap, shell, zonas (=setores), padrão de worker, tokens/CSS, store/relatório em abas, padrão de modo central por câmera.
- **Novo:** catálogo de classes, seletor de classes na UI, `ObjectsView`, `objects/detector.ts` (+ worker), painel de inventário/contagem, matriz setor×classe, eventos de presença/carregamento.

## 7. Fases
- **F0 — modelo de modo + seletor de classes:** `modo:"objetos"`, config por câmera, catálogo, UI de seleção no ⚙ Câmeras. (sem detecção nova ainda)
- **F1 — painel + contagem (andaime com coco-ssd):** `ObjectsView` desenha/contabiliza as classes que o coco-ssd já tem (pessoa/caminhão/etc.), painel ao vivo + matriz setor×classe + drill-in. Valida toda a UX **hoje**, sem modelo novo.
- **F2 — caixa/empilhadeira de verdade (zero-shot OWL-ViT em worker):** adiciona o backend zero-shot; lista passa a incluir caixa/palete/empilhadeira/paleteira; cadência baixa; presença por setor; "pessoa carregando caixa".
- **F3 — histórico + relatório** do modo objetos.
- **F4 — alertas** (presença/ausência por setor, carregamento) + acabamento; (opcional **F5**: trocar OWL-ViT por YOLO treinado p/ velocidade/precisão).

## 8. Riscos / atenção
- **Desempenho do zero-shot:** OWL-ViT é pesado; rodar em **worker**, cadência ~2–4 s, resolução moderada (ROI/centro), WebGPU quando disponível. Aceitável para presença, **não** para rastreio rápido.
- **Tamanho do modelo/lib:** transformers.js + pesos OWL-ViT (dezenas de MB) → **lazy-load** só no modo objetos (chunk próprio, fora do bundle de atividade/leitura), com indicador de "carregando modelo".
- **Acurácia em ambiente industrial:** ângulo/iluminação/oclusão. Zero-shot erra mais que treinado; mitigar com histerese de presença e limiar de confiança ajustável por classe.
- **LGPD:** mantém indicadores/contagens, sem rosto/identidade, sem armazenar imagem.

## 9. Ordem sugerida
**F0 → F1** primeiro (modo + painel funcionando com o que já temos), depois **F2** (caixa/empilhadeira via zero-shot) — que é o que entrega o objetivo final. F3/F4 fecham relatório e alertas.
