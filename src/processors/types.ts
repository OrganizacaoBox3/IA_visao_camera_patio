// Contrato comum dos processadores de zona (Modo por Zona).
// Mantém o mínimo necessário (ISP): cada modo define seu próprio contexto/resultado concretos;
// aqui ficam só os tipos transversais e o ciclo de vida.
import type { NormRect } from "../frame";

export type ZoneMode = "atividade" | "leitura" | "objetos" | "fadiga";
export type Severity = "info" | "warn" | "high";

// Geometria + identidade + modo de uma zona. A config específica do modo vive na cfg da zona.
export type ZoneBase = NormRect & { id: string; label: string; modo: ZoneMode };

// Um processador de zona é descartável (libera modelos/recursos ao remover a zona).
export interface Disposable {
  dispose(): void;
}
