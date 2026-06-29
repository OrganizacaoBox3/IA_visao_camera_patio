// Catálogo de objetos detectáveis no modo "Objetos / Contagem".
// `coco`: classes equivalentes no coco-ssd (andaime F1 — só "person" existe hoje).
// `prompts`: textos p/ o detector zero-shot OWL-ViT (F2) — PT/EN aumentam o recall.
// `color`: cor categórica do bbox/chip (paleta distinta por classe).

export type ObjClass = {
  key: string;
  label: string;
  emoji: string;
  color: string;
  coco: string[];
  prompts: string[];
};

export const OBJECT_CATALOG: ObjClass[] = [
  {
    key: "pessoa",
    label: "Pessoa",
    emoji: "🧍",
    color: "#38bdf8",
    coco: ["person"],
    prompts: ["person", "pessoa"],
  },
  {
    key: "caixa",
    label: "Caixa",
    emoji: "📦",
    color: "#f59e0b",
    coco: [],
    prompts: ["cardboard box", "box", "caixa de papelão"],
  },
  {
    key: "empilhadeira",
    label: "Empilhadeira",
    emoji: "🚜",
    color: "#22c55e",
    coco: [],
    prompts: ["forklift", "empilhadeira"],
  },
  {
    key: "palete",
    label: "Palete",
    emoji: "🟫",
    color: "#a78bfa",
    coco: [],
    prompts: ["wooden pallet", "pallet", "palete"],
  },
  {
    key: "paleteira",
    label: "Paleteira",
    emoji: "🛒",
    color: "#f472b6",
    coco: [],
    prompts: ["pallet jack", "hand pallet truck", "paleteira"],
  },
];

export const OBJECT_KEYS = OBJECT_CATALOG.map((c) => c.key);
const BY_KEY = new Map(OBJECT_CATALOG.map((c) => [c.key, c]));
export function objClass(key: string): ObjClass | undefined {
  return BY_KEY.get(key);
}

// coco-ssd → chave do catálogo (reverso), p/ o backend de andaime (F1).
const COCO_TO_KEY = new Map<string, string>();
for (const c of OBJECT_CATALOG) for (const cl of c.coco) COCO_TO_KEY.set(cl, c.key);
export function keyForCoco(cocoClass: string): string | undefined {
  return COCO_TO_KEY.get(cocoClass);
}
