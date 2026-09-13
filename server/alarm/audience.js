// ─────────────────────────────────────────────────────────────────────────────
// audience.js — PARA QUEM a mensagem está sendo escrita.
//
// O PROBLEMA. Existia UMA mensagem para todo mundo. O cliente (papel "cliente" — quem contrata
// o monitoramento e vê só as próprias câmeras) recebia o mesmo texto que o engenheiro de
// plantão, com tudo dentro: id de câmera (`cam-6a8914b424`), endpoint (`Ver
// /api/analysis/status`), vocabulário de engenharia de alarme ("CRÍTICO", "rajada de alertas —
// 4 zona(s) afetada(s)"), duração em ms e a instrução interna de operação.
//
// Isso é ruim por três motivos distintos, e nenhum deles é estético:
//   1. RUÍDO SOBRE QUEM NÃO PODE AGIR. O cliente não vai reiniciar um worker nem abrir um
//      endpoint. Mensagem que não muda a ação de quem lê treina a pessoa a ignorar o canal —
//      e aí ela ignora também a que importava.
//   2. VAZAMENTO DE INTERNO. Id de câmera, caminho de API e jargão nosso são detalhe de
//      implementação nossa saindo num WhatsApp que não controlamos.
//   3. MISTURA DE REGISTROS. "Informativo" e resumo de rajada são contexto de quem OPERA o
//      sistema. Para quem contrata, são interrupções sem conteúdo acionável.
//
// A DECISÃO. Dois perfis de mensagem, um por público:
//   • "equipe"  — superadmin/engenheiro/usuário: a mensagem COMPLETA, exatamente como era.
//                 Quem opera precisa do número, do id e da instrução.
//   • "cliente" — curta, em português comum, sem interno: o que aconteceu, onde, quando.
//
// E o cliente recebe MENOS mensagens, de propósito (é metade do "mais limpo"): só ATENÇÃO e
// CRÍTICO, nunca INFORMATIVO, e nunca resumo de rajada (que é sintoma de infraestrutura).
// Alarme de saúde já não chegava nele (PAPEIS_POR_TIPO em dispatch.js).
//
// NADA AQUI DECIDE SE O ALARME EXISTE. A política já decidiu; este módulo só escolhe a
// redação e o público. Sem regra nova de supressão escondida: o que o cliente não recebe está
// escrito em `clienteRecebe`, numa função só, testada.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

/** Perfil de redação a partir do PAPEL do dono do número. */
function perfilDe(papel) {
  return String(papel || "").toLowerCase() === "cliente" ? "cliente" : "equipe";
}

/**
 * O CLIENTE recebe esta mensagem? (a equipe recebe tudo que a política deixou passar)
 * @param {{priority?:string, summary?:boolean}} meta
 */
function clienteRecebe(meta) {
  const m = meta || {};
  // Resumo de rajada é sintoma de infraestrutura ("possível queda de feed"), não evento de
  // operação: o alarme-raiz já foi (ou será) enviado com a própria gravidade.
  if (m.summary) return false;
  // Informativo é contexto de quem OPERA o sistema (incidente fechado, taxa de leitura,
  // calibração de linha). Para quem contrata, é interrupção sem ação possível.
  //
  // FAIL-OPEN: só um "advisory" DECLARADO segura a mensagem. Prioridade ausente (chamador
  // legado, alarme vindo de fora) NÃO cala o cliente — silêncio por omissão é o pior modo de
  // falha possível num canal de alarme, e é a mesma regra do gate de estado da câmera: errar
  // para o lado do ruído custa uma mensagem; errar para o lado do silêncio custa o incidente
  // que ninguém viu. Em produção a prioridade sempre vem (a política a calcula antes).
  return m.priority !== "advisory";
}

// ── LIMPEZA DO TEXTO PARA O CLIENTE ──────────────────────────────────────────
// Conservadora de propósito: remove o que é COMPROVADAMENTE interno e deixa o resto passar.
// Um filtro agressivo comeria o conteúdo da mensagem, que é pior que um resíduo técnico.
const REGRAS_LIMPEZA = [
  // id de câmera gerado (`cam-` + hex) — nome interno, nunca significa nada para o cliente
  [/\bcam-[0-9a-f]{6,}\b/gi, "a câmera"],
  // caminho de API / instrução de onde olhar ("Ver /api/analysis/status")
  [/\s*(?:—\s*)?(?:ver|consulte|veja)?\s*\/api\/[\w/-]+/gi, ""],
  // Medida de engenharia entre parênteses: ms, fps, p50/p95, worker, pool, thread.
  // A unidade COLADA no número ("4200ms") não casa `\bms\b` — o `\b` exige não-palavra antes
  // do "m", e "0" é palavra. Daí a alternativa com o dígito à frente. (Pego pelo teste.)
  [
    /\s*\([^()]*(?:\d\s*(?:ms|fps)\b|\b(?:ms|fps|p50|p95|worker|pool|thread)\b)[^()]*\)/gi,
    "",
  ],
  // jargão de causa técnica que só a equipe trata
  [/\s*—\s*causa prov[áa]vel [^.;]*/gi, ""],
  // Marcadores de severidade no início do corpo (o cabeçalho já diz a gravidade, sem jargão).
  // Escrito por CÓDIGO (U+26A0 + o seletor de variação U+FE0F) e não como classe de
  // caracteres: "⚠️" é um grafema composto, e dentro de `[...]` ele se decompõe — o lint
  // (no-misleading-character-class) avisa justamente porque a classe casaria o seletor solto.
  [/^(?:\s|!|⚠|️)+/u, ""],
];

/**
 * Texto do alarme → frase limpa para o cliente. PURA e conservadora.
 * @param {string} texto corpo do alarme (já sem o prefixo "local: ")
 * @param {string} [local] rótulo que já vai no CABEÇALHO — se a frase começar repetindo-o,
 *        a repetição sai. O texto interno é escrito para um log ("Doca 2: Doca 2 sem
 *        movimentação"), e na mensagem curta essa duplicata fica gritante.
 */
function limparParaCliente(texto, local) {
  let t = String(texto || "");
  for (const [re, sub] of REGRAS_LIMPEZA) t = t.replace(re, sub);
  const rot = String(local || "").trim();
  if (rot) {
    const esc = rot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`^\\s*${esc}\\s*[:·-]?\\s*`, "i"), "");
  }
  t = t
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
  t = t.replace(/[\s;,—-]+$/u, ""); // sobra de pontuação depois de um corte
  if (!t) return "";
  // Frase de gente: inicial maiúscula e ponto final (o texto interno é telegráfico).
  t = t.replace(/^([a-zà-ú])/u, (m) => m.toUpperCase());
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * Rótulo de LOCAL para o cliente. O `local` sai do prefixo "X: " do texto e pode ser o id
 * cru da câmera quando o emissor não resolveu o rótulo — e id interno não vai para fora.
 * @returns {string} rótulo exibível, ou "" quando só sobrou identificador interno
 */
function localParaCliente(local) {
  const t = String(local || "").trim();
  if (!t) return "";
  // id gerado (`cam-` + hex) sozinho, ou como um dos segmentos de "cam-x · Zona"
  const partes = t
    .split(" · ")
    .filter((p) => !/^cam-[0-9a-f]{6,}$/i.test(p.trim()))
    .map((p) => p.trim())
    .filter(Boolean);
  return partes.join(" · ");
}

module.exports = {
  perfilDe,
  clienteRecebe,
  limparParaCliente,
  localParaCliente,
  REGRAS_LIMPEZA,
};
