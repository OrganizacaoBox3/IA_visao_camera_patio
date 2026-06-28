// Andon digital — repassa alertas críticos do painel para um webhook externo.
// Roda NO HUB (server-side) porque a URL do webhook é segredo e não pode ir no bundle do navegador.
// Webhook genérico: o payload inclui `text` e `content` p/ casar com Slack, Teams, Discord, Zapier,
// Make, n8n e endpoints próprios sem configuração extra. Configurável por env:
//   ALERT_WEBHOOK_URL   (obrigatório p/ ligar)   — URL do webhook
//   ALERT_DEDUP_MS      (default 60000)           — janela que ignora o MESMO alerta repetido
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";
const DEDUP_MS = Number(process.env.ALERT_DEDUP_MS ?? 60_000);

const lastSent = new Map(); // text -> ts (dedup por mensagem)

function andonEnabled() { return !!WEBHOOK_URL; }

async function post(text, ts) {
  const payload = { app: "Visão de Pátio", source: "andon", text, content: text, ts: ts || Date.now() };
  try {
    const res = await fetch(WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) console.error(`[andon] webhook respondeu HTTP ${res.status}`);
  } catch (e) {
    console.error("[andon] falha ao enviar webhook:", e.message);
  }
}

/** Recebe { text, ts } do painel; aplica dedup por mensagem e dispara o webhook. */
function notify(p) {
  if (!andonEnabled() || !p) return;
  const text = String(p.text || "").trim();
  if (!text) return;
  const now = Date.now();
  const prev = lastSent.get(text);
  if (prev && now - prev < DEDUP_MS) return; // mesmo alerta dentro da janela → ignora
  lastSent.set(text, now);
  if (lastSent.size > 300) for (const [k, t] of lastSent) if (now - t > DEDUP_MS) lastSent.delete(k); // limpa antigos
  void post(text, p.ts);
}

module.exports = { notify, andonEnabled };
