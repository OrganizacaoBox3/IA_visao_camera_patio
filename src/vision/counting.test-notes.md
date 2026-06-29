# counting.ts — notas de uso e contrato para a CW-3

Biblioteca **pura** (sem React/canvas/I/O/deps). Coordenadas **normalizadas 0..1**,
origem topo-esquerda, x→direita, y→baixo — iguais a `zones.ts` e a `Track.cx/cy` do
`CameraWorkspace`.

## API exportada (assinaturas)

### Tipos

```ts
type Point = { x: number; y: number };
type Tripwire = { id: string; a: Point; b: Point };
type CrossDir = "in" | "out";
type TripwireCounts = { in: number; out: number };
type TrackPoint = { id: number | string; cx: number; cy: number };
type CrossEvent = {
  tripwireId: string;
  trackId: number | string;
  dir: CrossDir;
  x: number;
  y: number;
};
type CounterOptions = { minMove?: number; ttl?: number };
type OccupancyPoint = { x: number; y: number; weight?: number };
type OccupancyOptions = {
  cols: number;
  rows: number;
  decay: number;
  addAmount?: number;
  max?: number;
  decayOnAdd?: boolean;
};
```

### Geometria pura

```ts
orient(a: Point, b: Point, p: Point): number              // >0 direita da seta a→b, <0 esquerda
segmentsIntersect(p1,p2,p3,p4: Point): boolean            // interseção própria de segmentos
inwardNormal(w: Tripwire): Point                          // normal unitária do sentido "in" (p/ desenhar a seta)
centroidOfBBox(bbox:[x,y,w,h], frameW, frameH): Point     // bbox px (model.ts) → centróide normalizado
```

### Tripwire / contagem com direção

```ts
createCounter(tripwires?: Tripwire[], opts?: CounterOptions): Counter

type Counter = {
  update(tracks: TrackPoint[], now?: number): CrossEvent[];  // 1x/frame; retorna cruzamentos do frame
  counts(): Record<string, TripwireCounts>;                  // snapshot (cópia)
  totals(): TripwireCounts;
  setTripwires(tripwires: Tripwire[]): void;                 // edita geometria, preserva contadores por id
  tripwires(): Tripwire[];
  reset(): void;                                             // zera contadores + histórico de posições
};
```

### Heatmap de ocupação

```ts
createOccupancy(options: OccupancyOptions): Occupancy

type Occupancy = {
  readonly cols: number; readonly rows: number;
  add(points: OccupancyPoint[]): void;       // decai (se decayOnAdd) + acumula — 1x/frame
  decayStep(): void;                         // só decai (frames sem pontos/pausa)
  grid(): Float32Array;                      // NORMALIZADO 0..1 (raw/max). Buffer reutilizado — copie p/ reter
  rawGrid(): Float32Array;                   // cru acumulado (live view; não mutar)
  dwellSeconds(fps: number): Float32Array;   // aprox. de permanência (relativa) por célula
  reset(): void;
};
```

## Convenção de direção (entrada/saída)

- Seta = `a → b`. `side(p) = (b.x-a.x)*(p.y-a.y) - (b.y-a.y)*(p.x-a.x)`.
- `side>0` → DIREITA da seta; `side<0` → ESQUERDA (coords de imagem, y p/ baixo).
- Cruzar **esquerda→direita** (−→+) = **"in"** (ENTRADA). **direita→esquerda** (+→−) = **"out"** (SAÍDA).
- Inverter o sentido: troque `a` e `b`. `inwardNormal(w)` aponta no sentido de uma entrada.

## Integração na CW-3 (loop rAF do CameraWorkspace)

```ts
// montagem / quando o usuário editar as linhas:
const counter = createCounter(tripwires, { minMove: 0.01, ttl: 1500 });
const occ = createOccupancy({ cols: 32, rows: 18, decay: 0.97, addAmount: 0.6, max: 6 });

// no loop, por frame, reusando os tracks já existentes (tracksRef.current = Track[]):
const tps = tracks.map((t) => ({ id: t.id, cx: t.cx, cy: t.cy })); // Track já tem id/cx/cy
const crossings = counter.update(tps, now); // now = performance.now()
crossings.forEach((e) =>
  pushTimeline(`${e.dir === "in" ? "Entrada" : "Saída"} · ${e.tripwireId}`, "info"),
);

occ.add(tps.map((t) => ({ x: t.cx, y: t.cy })));
const g = occ.grid(); // desenhar como o heatmap atual: índice g[row*cols + col]
const c = counter.counts(); // { [wireId]: { in, out } } para HUD/painel/relatório
```

- `counter.update` mantém o last-pos por id internamente e limpa por TTL os tracks
  que sumiram (`ttl` na mesma unidade de `now`). Se `now` for omitido, usa um relógio
  interno de frames.
- Micro-jitter abaixo de `minMove` é ignorado (acumula até passar o limiar) — evita
  contagem espúria e dupla contagem perto da linha.
- Para detecções cruas (objetos, bbox em px): `centroidOfBBox(d.bbox, f.w, f.h)`.

## Sanidade da direção (exemplo — verificado em runtime)

Tripwire vertical `a={0.5,0}` → `b={0.5,1}` (seta apontando p/ BAIXO).
Aqui `side(p) = -(p.x - 0.5)`, então **x menor (oeste) fica à DIREITA da seta** e
**x maior (leste) à ESQUERDA** (regra da mão direita de quem caminha p/ o sul).

- Track `cx 0.6 → 0.4` (leste→oeste = esquerda→direita da seta): `side` − → + ⇒ **in**.
- Track `cx 0.4 → 0.6` (oeste→leste = direita→esquerda da seta): `side` + → − ⇒ **out**.
- Movimento paralelo (sem cruzar o segmento) ⇒ nenhum evento.

Dica de intuição: para uma seta apontando p/ a DIREITA da tela (`a={0,0.5}`→`b={1,0.5}`),
cruzar de CIMA→BAIXO da tela (y menor→maior) = `side` − → + ⇒ **in**.
