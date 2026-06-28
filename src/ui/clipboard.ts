// Cópia para a área de transferência com fallback. `navigator.clipboard` só existe em contexto
// seguro (HTTPS/localhost); fora dele (HTTP comum) é `undefined`. Aí caímos no
// `document.execCommand("copy")` via <textarea> oculto. Retorna true se copiou.
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    console.warn("[clipboard] writeText falhou, tentando fallback", e);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    console.warn("[clipboard] fallback execCommand falhou", e);
    return false;
  }
}
