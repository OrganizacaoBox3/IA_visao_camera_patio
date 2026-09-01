const DELIVERY_ACK = 3;
const ERROR_ACK = 0;

function normalizeDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function recipientCandidates(value) {
  const digits = normalizeDigits(value);

  if (digits.length < 10) {
    throw new Error("número inválido");
  }

  const candidates = [digits];

  // No Brasil, cadastros antigos podem existir no WhatsApp sem o nono dígito.
  // A variante só é consultada; nunca enviamos para ela sem o WhatsApp confirmar
  // que existe e devolver o JID correspondente.
  if (
    digits.startsWith("55") &&
    digits.length === 13 &&
    digits[4] === "9"
  ) {
    candidates.push(`${digits.slice(0, 4)}${digits.slice(5)}`);
  }

  return candidates;
}

function phoneDigitsFromJid(jid) {
  return normalizeDigits(String(jid ?? "").split("@")[0]?.split(":")[0]);
}

async function resolveRecipient(socket, value) {
  if (!socket || typeof socket.onWhatsApp !== "function") {
    throw new Error("WhatsApp sem suporte à validação do destinatário");
  }

  const candidates = recipientCandidates(value);
  const results = await socket.onWhatsApp(...candidates);
  const existing = Array.isArray(results)
    ? results.filter((item) => item?.exists && item?.jid)
    : [];

  let match = null;
  for (const candidate of candidates) {
    match = existing.find(
      (item) => phoneDigitsFromJid(item.jid) === candidate,
    );
    if (match) break;
  }

  if (!match) {
    throw new Error("número não encontrado no WhatsApp");
  }

  // Sessões recém-pareadas usam LID. Enviar ao PN quando o WhatsApp já forneceu
  // um LID pode resultar em ACK assíncrono 463 e nenhuma entrega.
  const jid = match.lid || match.jid;

  return {
    jid,
    addressing: match.lid ? "lid" : "phone",
  };
}

function ackError(message, code, httpStatus = 502) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

class DeliveryTracker {
  constructor() {
    this.pending = new Map();
    this.recent = new Map();
  }

  observe(updates) {
    if (!Array.isArray(updates)) return;

    for (const item of updates) {
      const id = item?.key?.id;
      const status = Number(item?.update?.status);
      if (!id || !Number.isFinite(status)) continue;

      const failureCode = item?.update?.messageStubParameters?.[0];
      this.recent.set(id, { status, failureCode });
      if (this.recent.size > 500) {
        this.recent.delete(this.recent.keys().next().value);
      }

      this.#settle(id, status, failureCode);
    }
  }

  waitFor(id, initialStatus, timeoutMs) {
    if (!id) {
      return Promise.reject(
        ackError("WhatsApp não retornou identificador da mensagem", "NO_ID"),
      );
    }

    const prior = this.recent.get(id);
    const immediate = this.#outcome(
      prior?.status ?? Number(initialStatus),
      prior?.failureCode,
    );
    if (immediate) return immediate;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          ackError(
            "WhatsApp aceitou a mensagem, mas não confirmou a entrega",
            "DELIVERY_TIMEOUT",
            504,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });
  }

  rejectAll(message = "Conexão do WhatsApp encerrada antes da entrega") {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(ackError(message, "CONNECTION_CLOSED", 503));
      this.pending.delete(id);
    }
  }

  #outcome(status, failureCode) {
    if (!Number.isFinite(status)) return null;

    if (status === ERROR_ACK) {
      const suffix = failureCode ? ` (código ${failureCode})` : "";
      return Promise.reject(
        ackError(`WhatsApp recusou a entrega${suffix}`, "DELIVERY_ERROR"),
      );
    }

    if (status >= DELIVERY_ACK) {
      return Promise.resolve({ delivery: "delivered", status });
    }

    return null;
  }

  #settle(id, status, failureCode) {
    const waiter = this.pending.get(id);
    if (!waiter) return;

    const outcome = this.#outcome(status, failureCode);
    if (!outcome) return;

    clearTimeout(waiter.timer);
    this.pending.delete(id);
    outcome.then(waiter.resolve, waiter.reject);
  }
}

module.exports = {
  DeliveryTracker,
  normalizeDigits,
  recipientCandidates,
  resolveRecipient,
};
