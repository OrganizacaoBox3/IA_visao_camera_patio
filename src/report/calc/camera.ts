// ─────────────────────────────────────────────────────────────────────────────
// FILTRO POR CÂMERA — "quero o relatório só da Doca 1".
//
// POR QUE ELE É GLOBAL E NÃO MAIS UM FILTRO DE MODO. Área, ponto, setor e posto são recortes
// DE DENTRO de um modo. A câmera atravessa todos: é o objeto físico que o cliente nomeia
// ("a câmera da portaria"), e é o escopo que o papel `cliente` já tem no RBAC. Por isso ele
// mora na barra de recorte, ao lado de período e turno, e não desce para a seção.
//
// ────────────────────────────────────────────────────────────────────────────────────────────
// O PONTO DIFÍCIL, E A RAZÃO DESTE ARQUIVO EXISTIR: NEM TODA DIMENSÃO SABE DE QUAL CÂMERA VEIO.
//
//   atividade  ✓ a célula carrega `cameraId`
//   fluxo      ✓ o bucket é câmera × linha × hora
//   alarmes    ✓ o evento carrega `cameraId`
//   leitura    ~ PARCIAL: `perCamera` tem as LEITURAS por câmera, mas `boxes`/`passages` são
//               do PONTO — duas câmeras no mesmo ponto compartilham o mesmo total
//   objetos    ✗ o bucket é `setor|classe|hora`; a câmera não é gravada
//   fadiga     ✗ o bucket é `posto|hora`; idem
//
// Filtrar o que dá e deixar o resto passando INALTERADO seria o pior desenho possível: a tela
// diria "Doca 1" no cabeçalho e mostraria os objetos do pátio inteiro. Um número errado é ruim;
// um número certo sob um rótulo errado é pior, porque ninguém desconfia dele.
//
// Então a regra aqui é: filtra quem PODE, e quem não pode DECLARA. `cameraSuportadaEm` é a
// fonte única dessa verdade — a UI pergunta a ela para decidir entre mostrar o dado ou mostrar
// o aviso, e o CSV/PDF carrega a mesma ressalva.
//
// RESIDUAL: dar câmera a objetos/fadiga é mudança de INGEST (o bucket precisa nascer com ela) e
// só vale para o dado NOVO — histórico antigo não se conserta para trás. Está fora deste PR de
// propósito; o que entra aqui é parar de mentir sobre o que já existe.
// ─────────────────────────────────────────────────────────────────────────────

import type { Cell, Dataset } from "./atividade";
import type { FlowCell, FlowDataset } from "./flow";

/** Sentinela de "sem recorte" — mesma convenção de "Todas"/"Todos" do resto do relatório. */
export const TODAS_CAMERAS = "Todas";

/** Modos do relatório, na grafia de `labels.ts`. */
export type ModoRelatorio =
  | "resumo"
  | "atividade"
  | "fluxo"
  | "leitura"
  | "objetos"
  | "fadiga"
  | "alarmes";

/** Quanto da dimensão o filtro de câmera alcança. */
export type AlcanceCamera = "total" | "parcial" | "nenhum";

/**
 * O filtro de câmera vale neste modo? Fonte ÚNICA — a tela, o CSV e o PDF perguntam aqui.
 * "parcial" existe para a leitura, onde as LEITURAS são por câmera mas as CAIXAS são do ponto:
 * esconder essa diferença seria afirmar precisão que o dado não tem.
 */
export function cameraSuportadaEm(modo: ModoRelatorio): AlcanceCamera {
  switch (modo) {
    case "atividade":
    case "fluxo":
    case "alarmes":
      return "total";
    case "leitura":
      return "parcial";
    case "objetos":
    case "fadiga":
      return "nenhum";
    // O Resumo agrega dimensões de alcances diferentes: cada cartão declara o seu.
    case "resumo":
    default:
      return "parcial";
  }
}

/** A frase que a tela mostra quando o recorte não alcança o modo. `null` = alcança tudo. */
export function avisoDeAlcance(modo: ModoRelatorio, camera: string): string | null {
  if (camera === TODAS_CAMERAS) return null;
  const alcance = cameraSuportadaEm(modo);
  if (alcance === "total") return null;
  if (alcance === "parcial")
    return "As leituras são separadas por câmera, mas o volume de caixas é medido por PONTO — duas câmeras no mesmo ponto compartilham o total. Os números abaixo não estão recortados por câmera.";
  return "Este modo não registra de qual câmera veio o dado (o histórico é gravado por setor/posto). Os números abaixo são de TODAS as câmeras — o recorte por câmera não se aplica aqui.";
}

/** Uma câmera para o seletor. `label` é o que o operador lê; `id` é a chave do dado. */
export type OpcaoCamera = { id: string; label: string };

/**
 * Opções do seletor, montadas do CADASTRO (não do histórico): a câmera que não produziu dado
 * no período é exatamente a que o gestor precisa poder abrir para descobrir por quê — é o
 * mesmo motivo do seletor de linhas. Ordenado por rótulo, em pt-BR.
 */
export function opcoesDeCamera(cameras: ReadonlyArray<OpcaoCamera>): OpcaoCamera[] {
  const vistas = new Map<string, string>();
  for (const c of cameras) if (c && c.id) vistas.set(c.id, c.label || c.id);
  return [...vistas.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

/** Rótulo humano de uma câmera (ou a sentinela). Cai no id quando a câmera saiu do cadastro —
 *  nunca some do cabeçalho, porque o recorte continua valendo sobre o dado. */
export function rotuloDaCamera(
  camera: string,
  cameras: ReadonlyArray<OpcaoCamera>,
): string {
  if (camera === TODAS_CAMERAS) return "Todas as câmeras";
  return cameras.find((c) => c.id === camera)?.label ?? camera;
}

/**
 * Recorta o dataset de ATIVIDADE por câmera. Filtra no DATASET, antes das agregações, de
 * propósito: as funções de `calc/` continuam intocadas e toda a cadeia (janela, régua de turno,
 * heatmap, evolução, eficiência, cobertura) passa a enxergar só o recorte, sem cada uma
 * precisar aprender o que é uma câmera.
 *
 * `areas` é REFEITA a partir das células que sobraram — senão o seletor de área continuaria
 * oferecendo áreas de outra câmera, que agora rendem tela vazia.
 */
export function datasetDaCamera(ds: Dataset, camera: string): Dataset {
  if (camera === TODAS_CAMERAS) return ds;
  const cells: Cell[] = ds.cells.filter((c) => c.cameraId === camera);
  const areas = [...new Set(cells.map((c) => c.area))].sort();
  return { ...ds, cells, areas };
}

/** Recorta o dataset de FLUXO por câmera (o filtro de LINHA continua recortando por dentro). */
export function fluxoDaCamera(ds: FlowDataset, camera: string): FlowDataset {
  if (camera === TODAS_CAMERAS) return ds;
  const cells: FlowCell[] = ds.cells.filter((c) => c.cameraId === camera);
  return { ...ds, cells };
}

/** Recorta uma lista de eventos que carrega `cameraId` (alarmes, eventos de atividade). */
export function eventosDaCamera<T extends { cameraId?: string }>(
  eventos: ReadonlyArray<T>,
  camera: string,
): T[] {
  if (camera === TODAS_CAMERAS) return [...eventos];
  return eventos.filter((e) => e.cameraId === camera);
}
