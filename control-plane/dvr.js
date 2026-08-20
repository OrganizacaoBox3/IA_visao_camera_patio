// PONTE DVR — a lógica PURA do domínio (sem banco, sem rede), no molde de login.js/sitekey.js.
// Valida/normaliza os dois payloads da Fase 2:
//   • ENROLLMENT — o integrador liga empresa(box3) ↔ cliente(visão); o visão emite a site_key.
//   • REGISTRO   — o coletor grava marca/modelo/ip/porta do DVR + o consentimento.
//
// INVARIANTE (contratos §3): a credencial do DVR NUNCA trafega — o app só informa que validou.
// Por isso o objeto normalizado é ALLOW-LIST: só os campos abaixo entram; qualquer "senha"/
// "usuario" que venha no corpo é IGNORADO (não persistido). Testável 100% offline.

// Trunca strings (defesa barata contra corpo abusivo) e normaliza vazio → null.
function str(v, max = 200) {
  if (v == null) return null;
  const s = String(v).slice(0, max);
  return s.length ? s : null;
}

// ── ENROLLMENT — liga empresa(box3) ↔ cliente(visão). cliente_id + empresa_id_box3 obrigatórios.
// coletor_id_box3 é opcional (pode chegar só no registro/heartbeat, ou nunca).
function validateEnrollment(body) {
  const b = body || {};
  const cliente_id = str(b.cliente_id, 100);
  const empresa_id_box3 = str(b.empresa_id_box3, 100);
  if (!cliente_id) return { ok: false, error: "cliente_id é obrigatório" };
  if (!empresa_id_box3) return { ok: false, error: "empresa_id_box3 é obrigatório" };
  return {
    ok: true,
    value: {
      cliente_id,
      empresa_id_box3,
      nome: str(b.nome),
      coletor_id_box3: str(b.coletor_id_box3, 100),
    },
  };
}

// ── REGISTRO do DVR — só marca/modelo/ip/porta + consentimento. porta ∈ 1..65535 (ou null).
// consentimento.aceito=true é OBRIGATÓRIO (contratos §3) — sem aceite, não registra.
function normalizeRegistro(body) {
  const b = body || {};
  const d = b.dvr || {};
  const c = b.consentimento || {};
  if (c.aceito !== true) {
    return { ok: false, error: "consentimento obrigatório (consentimento.aceito=true)" };
  }
  let porta = null;
  if (d.porta != null && d.porta !== "") {
    porta = Number(d.porta);
    if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
      return { ok: false, error: "porta inválida (1..65535)" };
    }
  }
  return {
    ok: true,
    value: {
      // ALLOW-LIST: nada de credencial do DVR entra aqui (contratos §3).
      marca: str(d.marca),
      modelo: str(d.modelo),
      ip: str(d.ip),
      porta,
      consentimento: {
        aceito: true,
        quando: Number(c.quando) || Date.now(),
        versaoTexto: str(c.versaoTexto),
      },
    },
  };
}

module.exports = { validateEnrollment, normalizeRegistro, str };
