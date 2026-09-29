// ─────────────────────────────────────────────────────────────────────────────
// camera-diagnostico.js — QUAIS CÂMERAS NÃO ESTÃO SERVINDO PARA NADA (2026-09-29).
//
// Uma câmera custa sempre (ingest, decode, e inferência quando analisada) — e nem toda devolve
// alguma coisa. Este módulo junta os sinais que o hub JÁ tem e diz, por câmera, se ela é útil,
// se merece atenção, ou se é INÚTIL hoje — e o que fazer. PURO: recebe os sinais, devolve o
// veredito. A rota (routes/cameras.js) é quem coleta; a tela só desenha.
//
// O QUE É "INÚTIL" (o custo existe e o retorno é zero, por construção):
//   offline    — cadastrada mas sem conexão: o hub segue tentando reconectar e não vê nada;
//   congelada  — frame chegando, mas idêntico há minutos (frame-freeze.js);
//   sem-area   — câmera de área sem nenhuma zona nem linha: não gera indicador nenhum.
// O QUE É "ATENÇÃO" (pode ser normal, pode ser desperdício — pede um humano):
//   sem-pessoa — horas de análise sem UMA pessoa detectada: mal posicionada, ou vigiando o
//                que ninguém usa. É "atenção" e não "inútil" porque um depósito fechado à
//                noite também não tem ninguém — o sistema não sabe separar sozinho.
// "desativada" é estado ESCOLHIDO pelo time: aparece à parte, nunca como defeito.
//
// RESIDUAL DECLARADO: `analisadaDesde`/`ultimaPessoaEm` vivem em MEMÓRIA — reiniciar o hub
// zera a contagem de "horas sem pessoa". O texto diz "de análise", nunca "nos últimos N dias".
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const HORAS_SEM_PESSOA = Math.max(1, Number(process.env.DIAG_HORAS_SEM_PESSOA) || 24);
const ORDEM = { ok: 0, atencao: 1, inutil: 2 };

/**
 * @param {{
 *   online: boolean, estado?: string, modo?: string, zonas?: number, linhas?: number,
 *   congelada?: boolean, paradoMs?: number, analiseLigada?: boolean,
 *   analisadaDesde?: number|null, ultimaPessoaEm?: number|null,
 * }} c
 * @param {{ agora?: number, horasSemPessoa?: number }} [opts]
 * @returns {{ utilidade: "ok"|"atencao"|"inutil"|"desativada",
 *             motivos: {codigo:string, nivel:"inutil"|"atencao"|"info", texto:string, sugestao:string}[] }}
 */
function diagnosticar(c, { agora = Date.now(), horasSemPessoa = HORAS_SEM_PESSOA } = {}) {
  if (c.estado === "desativada")
    return {
      utilidade: "desativada",
      motivos: [
        {
          codigo: "desativada",
          nivel: "info",
          texto: "Desativada — não analisa nem alarma.",
          sugestao: "Se ela não vai voltar a operar, remova o cadastro.",
        },
      ],
    };

  const motivos = [];
  if (!c.online)
    motivos.push({
      codigo: "offline",
      nivel: "inutil",
      texto: "Cadastrada, mas sem conexão agora.",
      sugestao:
        "Confira rede e URL. Se a câmera foi retirada, remova o cadastro — o hub segue tentando reconectar.",
    });
  if (c.online && c.congelada === true)
    motivos.push({
      codigo: "congelada",
      nivel: "inutil",
      texto: `Imagem idêntica há ${Math.max(1, Math.round((c.paradoMs || 0) / 60_000))} min — feed congelado ou câmera tampada/escura.`,
      sugestao: "Reinicie a câmera/DVR e confira se a lente está livre.",
    });
  if (c.modo !== "fadiga" && (c.zonas || 0) === 0 && (c.linhas || 0) === 0)
    motivos.push({
      codigo: "sem-area",
      nivel: "inutil",
      texto: "Nenhuma área demarcada nem linha de contagem — não gera indicador.",
      sugestao: "Abra a câmera e desenhe as áreas que importam, ou desative-a.",
    });

  const janelaMs = horasSemPessoa * 3_600_000;
  const analisadaHaMs = c.analisadaDesde ? agora - c.analisadaDesde : 0;
  const semPessoaHaMs = c.ultimaPessoaEm ? agora - c.ultimaPessoaEm : analisadaHaMs;
  if (
    c.analiseLigada !== false &&
    c.online &&
    c.congelada !== true &&
    c.modo !== "fadiga" &&
    analisadaHaMs >= janelaMs &&
    semPessoaHaMs >= janelaMs
  )
    motivos.push({
      codigo: "sem-pessoa",
      nivel: "atencao",
      texto: `Nenhuma pessoa detectada nas últimas ${Math.round(semPessoaHaMs / 3_600_000)}h de análise.`,
      sugestao:
        "Pode estar mal posicionada ou vigiando área sem uso — reavalie o enquadramento ou o turno.",
    });

  if (c.estado === "teste" || c.estado === "manutencao")
    motivos.push({
      codigo: c.estado,
      nivel: "info",
      texto:
        c.estado === "teste"
          ? "Em teste — mede, mas não notifica."
          : "Em manutenção — não notifica.",
      sugestao: "Volte para Produção quando ela estiver pronta.",
    });

  const pior = motivos.reduce(
    (p, m) => (m.nivel !== "info" && ORDEM[m.nivel] > ORDEM[p] ? m.nivel : p),
    "ok",
  );
  return { utilidade: pior, motivos };
}

module.exports = { diagnosticar, HORAS_SEM_PESSOA };
