// Geração de CSV "rico" para o Relatório Operacional: vários blocos (metadados, indicadores,
// detalhamento e eventos) num único arquivo auto-descritivo. Separador ';' + BOM → abre direto
// no Excel pt-BR com acentos corretos. Sem imagens/identificação (LGPD) — só números agregados.

import { ALARM_PRIORITY_LABEL, ALARM_STATE_LABEL, type AlarmEvent } from "../types/alarm";

export type CsvSection = { title?: string; headers?: string[]; rows: (string | number)[][] };

const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

// AVISO DE PROPRIEDADE no arquivo exportado. O CSV é o artefato que SAI da empresa e circula
// por e-mail, WhatsApp e pasta compartilhada — sem isto ele viaja sem identificação de origem
// nem de titularidade. Vai como PRIMEIRA linha de propósito: rodapé de planilha longa não é
// lido, e no Excel a linha 1 fica visível junto do primeiro bloco. Gate: csv.test.ts.
export const CSV_AVISO_PROPRIEDADE =
  "Documento gerado por Visão de Pátio — Copyright (c) 2026 Box 3. " +
  "Todos os direitos reservados. Uso interno autorizado; redistribuição vedada.";

// Monta o CSV a partir de seções; linha em branco separa cada bloco (legível no Excel).
export function buildCSV(sections: CsvSection[]): string {
  const lines: string[] = [esc(CSV_AVISO_PROPRIEDADE), ""];
  for (const s of sections) {
    if (s.title) lines.push(esc(s.title));
    if (s.headers) lines.push(s.headers.map(esc).join(";"));
    for (const r of s.rows) lines.push(r.map(esc).join(";"));
    lines.push(""); // separador entre blocos
  }
  return "﻿" + lines.join("\r\n");
}

// Dispara o download de um CSV já montado.
export function downloadCSVFile(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Sufixo de data p/ o nome do arquivo (AAAA-MM-DD), estável para ordenação.
export function dateStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Export dos EVENTOS DE ALARME (metadados, LGPD: sem imagens) ──
// Reusa o padrão de seções; o ReportPage só anexa o bloco retornado às demais seções.
// Rótulos pt-BR: fonte única em types/alarm.ts (com fallback ao valor cru p/ tipos futuros).

export function alarmSection(events: AlarmEvent[]): CsvSection {
  return {
    title: `ALARMES (${events.length})`,
    headers: [
      "Data/hora",
      "Câmera",
      "Zona",
      "Tipo",
      "Prioridade",
      "Estado",
      "Mensagem",
      "Reconhecido por",
      "Reconhecido em",
    ],
    rows: events.map((e) => [
      new Date(e.ts).toLocaleString("pt-BR"),
      e.cameraLabel ?? e.cameraId ?? "—",
      e.zona ?? "—",
      e.tipo,
      ALARM_PRIORITY_LABEL[e.priority] ?? e.priority,
      ALARM_STATE_LABEL[e.state] ?? e.state,
      e.text,
      e.ackBy ?? "—",
      e.ackAt ? new Date(e.ackAt).toLocaleString("pt-BR") : "—",
    ]),
  };
}
