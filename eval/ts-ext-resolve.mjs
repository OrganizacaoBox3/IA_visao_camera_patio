// Resolve hook mínimo: o Node 24 executa .ts nativamente (type stripping), mas NÃO aplica a
// resolução de módulos do TypeScript — um `import "../vision/homography"` (sem extensão, como o
// front escreve) não resolve. Este hook tenta o especificador cru e, se falhar, tenta com `.ts`.
// Existe só para o harness de eval poder importar o código de PRODUÇÃO do front sem bundle e sem
// reescrever import nenhum. Nada aqui roda em produção.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith(".")) {
      for (const ext of [".ts", "/index.ts"]) {
        try {
          return await nextResolve(specifier + ext, context);
        } catch {
          /* tenta o próximo */
        }
      }
    }
    throw err;
  }
}
