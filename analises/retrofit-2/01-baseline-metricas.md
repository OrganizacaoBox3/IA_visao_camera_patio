# Retrofit-2 "Separar para conquistar" — Baseline de métricas (BEFORE)

> **Este é o "before" oficial do retrofit-2.** O "after" será medido com os MESMOS comandos
> (ver §7) e comparado tabela a tabela contra este arquivo. Sem estes números não há retorno mensurável.
>
> **Medido em:** 2026-07-05 · commit `c875a96` ("feat(webcam): fluidez do modo browser…", 2026-07-05 22:42 -0300)
> · node v24.15.0 · Windows 11 · escopo: `src/` + `server/` (ignorando `node_modules`, `dist`,
> `test-results`, `wa-auth`, `.git`) · extensões `.js .mjs .cjs .jsx .ts .tsx`.
>
> **Definições:** "Comentário" = linhas *dedicadas* a comentário (`//`, blocos `/* */`, JSDoc);
> linha com código + comentário no fim conta como código. `% comentário = comentário / (código + comentário)`.

---

## 1. Linhas por área (código × comentário)

| Área | Arquivos | Linhas totais | Código | Comentário | % comentário | Em branco |
|---|---:|---:|---:|---:|---:|---:|
| `server/analysis` (motor D-FINE — núcleo) | 20 | 5.063 | 3.548 | 1.098 | **23,6%** | 417 |
| `server` raiz + `routes` + `alarm` | 36 | 4.839 | 3.848 | 638 | 14,2% | 353 |
| `src/camera+vision+processors+objects+fadiga` | 46 | 8.564 | 6.711 | 1.263 | 15,8% | 590 |
| `src/routes+ui+report` | 70 | 10.422 | 8.950 | 870 | **8,9%** | 602 |
| `src` raiz | 15 | 4.582 | 3.573 | 774 | 17,8% | 235 |
| `src` outros (`components+reading+types`) | 8 | 1.176 | 979 | 102 | 9,4% | 95 |
| `src/vendor` (3rd-party, fora do retrofit) | 4 | 852 | 542 | 181 | 25,0% | 129 |
| **TOTAL** | **199** | **35.498** | **28.151** | **4.926** | **14,9%** | **2.421** |

Leitura: o comentário está concentrado onde moram invariantes (motor 23,6%) — bom sinal —
mas o front de páginas (`routes+ui+report`, 8,9%; `ReportPage.tsx` 3,0%; `FadigaView.tsx` 2,8%)
tem muita lógica com pouco "porquê". O alvo do retrofit é comentário **enxuto e de porquê**,
não volume: espera-se que o % do motor caia levemente (podar redundância) e o do front suba onde falta invariante.

## 2. Top-15 maiores arquivos (linhas totais)

| # | Arquivo | Área | Linhas | Código | Comentário | % com. |
|---:|---|---|---:|---:|---:|---:|
| 1 | `src/CameraWorkspace.tsx` | src raiz | **2.195** | 1.691 | 437 | 20,5% |
| 2 | `src/routes/ReportPage.tsx` | routes+ui+report | 1.018 | 958 | 30 | 3,0% |
| 3 | `server/analysis/engine.js` | server/analysis | 952 | 660 | 243 | 26,9% |
| 4 | `src/vendor/go2rtc/video-rtc.js` | vendor (3rd-party) | 702 | 441 | 152 | 25,6% |
| 5 | `src/routes/cameras/IpCamerasSection.tsx` | routes+ui+report | 597 | 531 | 44 | 7,7% |
| 6 | `src/camera/draw.ts` | camera+vision+… | 592 | 499 | 76 | 13,2% |
| 7 | `server/pgstore.js` | server raiz | 542 | 498 | 27 | 5,1% |
| 8 | `server/rtsp.js` | server raiz | 513 | 405 | 75 | 15,6% |
| 9 | `src/processors/fadiga.ts` | camera+vision+… | 504 | 445 | 35 | 7,3% |
| 10 | `src/report/store.ts` | routes+ui+report | 501 | 419 | 48 | 10,3% |
| 11 | `src/vision/counting.ts` | camera+vision+… | 497 | 282 | 168 | 37,3% |
| 12 | `src/components/AppShell.tsx` | src outros | 496 | 429 | 44 | 9,3% |
| 13 | `src/vision/detect.ts` | camera+vision+… | 487 | 346 | 111 | 24,3% |
| 14 | `src/FadigaView.tsx` | src raiz | 478 | 445 | 13 | 2,8% |
| 15 | `src/routes/AlarmHealthPage.tsx` | routes+ui+report | 434 | 396 | 13 | 3,2% |

`CameraWorkspace.tsx` sozinho é ~6% de todo o código do projeto — a maior violação de
responsabilidade única (alvo do R2; frente paralela já editando). No motor, `engine.js` (952)
já é declaradamente ORQUESTRAÇÃO: a extração R5 tirou `model.js`, `worker-host.js`,
`automask.js` e `go2rtc-source.js` para módulos vizinhos testados.

## 3. Testes

| Sensor | Valor (before) |
|---|---|
| Vitest — testes | **386** (386 passed / 0 failed — execução real `npx vitest run --reporter=json`) |
| Vitest — suites | 134 |
| Arquivos `*.test.*` em `src/`+`server/` | 27 |
| Contagem estática `it(`/`test(` | 386 (bate com a execução) |
| Playwright e2e (`e2e/`) | 9 `test(` (8 em `app.spec.ts` + 1 em `mobile.spec.ts`) |

Cobertura concentrada nas lógicas puras do motor e portes: `server/analysis/counting.test.js` (423 l),
`autoscale.test.js` (345), `bytetrack.test.js` (207), `zones.test.js` (183), `automask.test.js` (167),
`src/vision/counting.test.ts` (416), `bytetrack.test.ts` (203) etc.

## 4. Precisão do motor (eval — D-FINE-S obj2coco)

### 4a. Gate de regressão (`eval/thresholds.json`, calibrado 2026-07-03, S@640 squash, fixture 21+8)

| Check | Piso/teto | Medido na calibração |
|---|---|---|
| `f1_all@0.35` | ≥ 0,7708 | **82,1%** |
| `recall_all@0.25` | ≥ 0,8763 | **92,6%** |
| `precision_all@0.35` | ≥ 0,6936 | **74,4%** |
| `fp_empties@0.50` | ≤ 0 | **0** |

### 4b. Última execução do eval (`eval/last-results.json`, ranAt 2026-07-06T00:48Z)

Modo **tiled 2×2 overlap 0,1** (perfil longRange), full-set (150 c/ pessoa + 150 vazias, **591 GT**),
IoU≥0,5, pipeline de produção (`fork` de `server/analysis/worker.js`).
`avgDecode` 73,5 ms · **`avgInfer` 1.593,3 ms/frame** · wall 500,9 s.
(Os 1.593 ms casam com a linha tiled@512 do estudo de input — §5; era a medição em curso do estudo.)

| thr | P all | R all | F1 all | R S (pequena) | R M | R L | FP em vazias (dets) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0,25 | 39,7% | 79,0% | 52,9% | 75,0% | 84,8% | 77,3% | 99 |
| 0,30 | 45,3% | 79,0% | 57,6% | 75,0% | 84,8% | 77,3% | 67 |
| 0,35 | 50,7% | 78,2% | **61,5%** | 72,8% | 84,8% | 77,3% | 44 |
| 0,40 | 55,2% | 76,8% | 64,3% | 70,1% | 84,3% | 76,7% | 30 |
| 0,45 | 58,8% | 75,5% | 66,1% | 67,9% | 82,8% | 76,7% | 23 |
| 0,50 | 61,5% | 73,9% | 67,2% | 65,2% | 81,4% | 76,7% | 20 |
| 0,55 | 63,9% | 72,6% | 68,0% | 62,9% | 79,9% | 76,7% | 18 |

> Nota honesta: R S/M/L acima recalculados de tp/fn por bucket do JSON; o F1 "all" @0,35 do
> **squash 640** (modo default de produção) no full-set é **73,7%** (§5) — o tiled troca recall de
> pessoa grande por pequena e paga em precisão. Referência de produção = squash 640.

## 5. Latências conhecidas (`analises/perf-input-size-dfine.md`, tier S, full-set, 8 cores, hub parado)

**Squash (default de produção):**

| Input | Infer médio/frame | Δ vs 640 | R all @0.35 | F1 @0.35 | R pequena @0.35 | Veredito |
|---:|---:|---:|---:|---:|---:|---|
| **640 (default)** | **385 ms** | — | 84,8% | **73,7%** | 69,2% | **MANTIDO** |
| 512 | 295 ms | −23,4% | 80,0% | 71,8% | 61,2% (−8,0pp) | escape hatch (`ANALYSIS_INPUT=512`) |
| 416 | 232 ms | −39,7% | 74,6% | 70,9% | 48,2% (−21pp) | REJEITADO (reprova gate) |

**Tiled 2×2 (longRange):** 640 = **1.789 ms** · 512 = 1.593 ms (−11%) — tiling ≈ **4,6× o custo** do squash.

**Dimensionamento (`server/analysis/README.md`, CPU EP 2 threads):** S (default) ~0,93 câmera/core
@1fps (≈7 câmeras em 8C) · N ~2,2 · M ~0,53. RSS do worker 190–260 MB.

## 6. Bundle (dist/assets — build de 2026-07-05 22:42, mesmo timestamp do HEAD)

| Asset | Bytes | Nota |
|---|---:|---|
| `ort-wasm-simd-threaded.jsep-*.wasm` | 21.596.019 | ONNX Runtime Web (inferência **client-side**) |
| `detectWorker-*.js` | 1.884.102 | worker de detecção no navegador |
| `index-*.js` | 910.295 | bundle principal |
| `owlvitWorker-*.js` | 873.277 | modo Objetos (OWL-ViT) |
| `dist-BUek44hP.js` | 726.229 | chunk vendor |
| `zxingWorker-*.js` | 410.572 | modo Leitura |
| `dist-DoX1IY-g.js` | 401.581 | chunk vendor |
| `index-*.css` | 83.586 | |
| `video-stream-*.js` | 10.614 | |
| `coco-ssd.es2017.esm.min-*.js` | 6.430 | |
| **TOTAL** | **26.902.705 (~25,7 MB)** | **80%** é o wasm do ORT client-side |

## 7. Como reproduzir (comandos do "after")

```bash
# 1) LOC/comentários por área + top-15 + testes estáticos
node analises/retrofit-2/baseline-scan.mjs .   # ver script no apêndice; salve-o com este nome
# 2) Testes (contagem real)
npx vitest run --reporter=json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const l of s.split(/\r?\n/)){try{const o=JSON.parse(l);if(o.numTotalTests!==undefined)console.log(o.numTotalTests,o.numPassedTests,o.numFailedTests)}catch{}}})"
# 3) Precisão do motor (gate no fixture; full-set é run-eval.mjs)
node eval/gate.mjs
# 4) Bundle
npm run build && ls -la dist/assets
```

### Apêndice — script de varredura (conteúdo integral; rodou no scratchpad nesta medição)

```js
#!/usr/bin/env node
// Baseline do retrofit-2 — varre src/ e server/ e computa LOC/comentários por área.
// Uso: node baseline-scan.mjs <raiz-do-projeto>
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = process.argv[2] || '.';
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'test-results', 'wa-auth', '.git']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      yield* walk(join(dir, e.name));
    } else if (CODE_EXT.has(extname(e.name))) {
      yield join(dir, e.name);
    }
  }
}

// code / comment (// e /* */ incl. JSDoc, linha inteira) / blank.
// Linha com código + comentário no fim conta como código.
function countFile(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/);
  let code = 0, comment = 0, blank = 0, inBlock = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (inBlock) {
      comment++;
      if (l.includes('*/')) {
        inBlock = false;
        const after = l.slice(l.indexOf('*/') + 2).trim();
        if (after && !after.startsWith('//')) { comment--; code++; }
      }
      continue;
    }
    if (l === '') { blank++; continue; }
    if (l.startsWith('//')) { comment++; continue; }
    if (l.startsWith('/*')) {
      comment++;
      if (!l.includes('*/')) inBlock = true;
      else {
        const after = l.slice(l.indexOf('*/') + 2).trim();
        if (after && !after.startsWith('//')) { comment--; code++; }
      }
      continue;
    }
    code++;
  }
  return { total: lines.length, code, comment, blank };
}

function areaOf(rel) {
  const p = rel.replace(/\\/g, '/');
  if (p.startsWith('server/analysis/')) return 'server/analysis';
  if (p.startsWith('server/routes/') || p.startsWith('server/alarm/') || /^server\/[^/]+$/.test(p)) return 'server raiz+routes+alarm';
  if (/^src\/(camera|vision|processors|objects|fadiga)\//.test(p)) return 'src/camera+vision+processors+objects+fadiga';
  if (/^src\/(routes|ui|report)\//.test(p)) return 'src/routes+ui+report';
  if (/^src\/[^/]+$/.test(p)) return 'src raiz';
  if (p.startsWith('src/vendor/')) return 'src/vendor (3rd-party)';
  if (/^src\/(components|reading|types)\//.test(p)) return 'src outros (components+reading+types)';
  return 'outros';
}

const areas = new Map();
const files = [];
let testFiles = 0, testCases = 0;

for (const base of ['src', 'server']) {
  for (const f of walk(join(ROOT, base))) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    const c = countFile(f);
    const area = areaOf(rel);
    const a = areas.get(area) || { files: 0, total: 0, code: 0, comment: 0, blank: 0 };
    a.files++; a.total += c.total; a.code += c.code; a.comment += c.comment; a.blank += c.blank;
    areas.set(area, a);
    files.push({ rel, area, ...c });
    if (/\.test\.(ts|tsx|js|mjs|cjs)$/.test(rel) || /_test\.(cjs|mjs|js)$/.test(rel)) {
      testFiles++;
      const src = readFileSync(f, 'utf8');
      testCases += (src.match(/^\s*(it|test)\s*\(/gm) || []).length;
    }
  }
}

const pct = (a) => (a.comment + a.code ? ((100 * a.comment) / (a.comment + a.code)).toFixed(1) : '0.0');
const order = [
  'server/analysis', 'server raiz+routes+alarm',
  'src/camera+vision+processors+objects+fadiga', 'src/routes+ui+report', 'src raiz',
  'src outros (components+reading+types)', 'src/vendor (3rd-party)', 'outros',
];

console.log('## Por área');
console.log('| Área | Arquivos | Linhas totais | Código | Comentário | % comentário | Em branco |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
let T = { files: 0, total: 0, code: 0, comment: 0, blank: 0 };
for (const k of order) {
  const a = areas.get(k);
  if (!a) continue;
  console.log(`| ${k} | ${a.files} | ${a.total} | ${a.code} | ${a.comment} | ${pct(a)}% | ${a.blank} |`);
  T.files += a.files; T.total += a.total; T.code += a.code; T.comment += a.comment; T.blank += a.blank;
}
console.log(`| **TOTAL** | **${T.files}** | **${T.total}** | **${T.code}** | **${T.comment}** | **${pct(T)}%** | **${T.blank}** |`);

console.log('\n## Top-15 maiores arquivos');
console.log('| # | Arquivo | Área | Linhas | Código | Comentário | % comentário |');
console.log('|---:|---|---|---:|---:|---:|---:|');
files.sort((x, y) => y.total - x.total).slice(0, 15).forEach((f, i) => {
  console.log(`| ${i + 1} | ${f.rel} | ${f.area} | ${f.total} | ${f.code} | ${f.comment} | ${pct(f)}% |`);
});

console.log(`\n## Testes (estático)\n- Arquivos *.test.*: ${testFiles}\n- Casos it()/test(): ${testCases}`);
```

---

## 8. Leitura do baseline — separação de responsabilidade hoje (nota: **6,5/10**)

**O que já está bem separado (não mexer à toa):**

- `server/analysis` (o núcleo — motor de pessoas) é o domínio mais saudável: 20 arquivos pequenos
  (mediana ~190 l), `engine.js` explicitamente só orquestra (extração R5 já feita: `model.js`,
  `worker-host.js`, `automask.js`, `go2rtc-source.js`), teste colocalizado por módulo, 23,6% de
  comentário concentrado em invariantes/contratos.
- `server/routes/*` fino (18–99 l/arquivo); `src/processors/*` um modo por arquivo; `src/vision`
  e `src/camera` com lógica pura testada ao lado.

**Onde a responsabilidade vaza (alvos do retrofit):**

1. **`src/CameraWorkspace.tsx` (2.195 l)** — god-component: casca fullscreen + editor de zonas +
   transporte + overlays + modos. Alvo do R2; frente paralela já atacando.
2. **`src/routes/ReportPage.tsx` (1.018 l, 3% comentário)** — página + agregação + gráficos no mesmo arquivo.
3. **`src` raiz mistura domínios** (4.582 l): views (`CameraWorkspace`, `FadigaView`), API client,
   config, zonas — sem dono claro de pasta/domínio.
4. **Duplicação deliberada hub↔front**: `bytetrack`/`counting`/`zones` existem em `server/analysis`
   (JS) E `src/vision` (TS) como ports 1:1 com testes de paridade — custo consciente, mas qualquer
   mudança de precisão hoje precisa tocar os DOIS lados.
5. **`server/pgstore.js` (542 l, 5% comentário)** — persistência de todos os kinds num arquivo só.

## 9. Mapa de ataque perf/precisão (arquivo dono de cada alavanca)

| Alavanca | Arquivo dono | Número baseline |
|---|---|---|
| Latência de inferência (input/threads/tiles) | `server/analysis/worker.js` | 385 ms/frame S@640 squash |
| Custo do tiling longRange (4,6×) | `server/analysis/worker.js` (`detectTiled`) + flag em `engine.js` | 1.789 ms/frame |
| Threshold de operação / nascimento de track | `server/analysis/engine.js` (`ANALYSIS_HIGH_SCORE`) | 0,35 → F1 73,7% squash |
| Recall pessoa pequena (gargalo nº 1) | modelo em `server/analysis/model.js` + eval `eval/run-eval.mjs` | R S@0.35 = 69,2% (squash 640) |
| FP estático (objeto fixo lido como pessoa) | `server/analysis/zones.js` (exclusão) + `automask.js` | 47–86% dos FP são estáticos |
| Precisão de contagem/fluxo | `server/analysis/bytetrack.js` + `counting.js` | paridade com `src/vision/*` |
| Cadência/CPU por câmera | `server/analysis/engine.js` (@1fps último-vence) + `autoscale.js` | ~0,93 câmera/core (S) |
| Sensor de regressão de precisão | `eval/gate.mjs` + `eval/thresholds.json` | 4 checks (§4a) |
| Peso client-side (25,7 MB) | `src/vision/detectWorker.ts` + `src/objects/owlvitWorker.ts` (ORT wasm) | 20,6 MB só de wasm |
| Custo de render de overlays no navegador | `src/camera/draw.ts` (592 l) + `interpolate.ts` | — (medir no after se virar alvo) |
