// Geração de CSV "rico" para o Relatório Operacional: vários blocos (metadados, indicadores,
// detalhamento e eventos) num único arquivo auto-descritivo. Separador ';' + BOM → abre direto
// no Excel pt-BR com acentos corretos. Sem imagens/identificação (LGPD) — só números agregados.

export type CsvSection = { title?: string; headers?: string[]; rows: (string | number)[][] };

const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

// Monta o CSV a partir de seções; linha em branco separa cada bloco (legível no Excel).
export function buildCSV(sections: CsvSection[]): string {
  const lines: string[] = [];
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
