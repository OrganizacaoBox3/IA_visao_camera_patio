// Aba "Por quê" do drawer da câmera — A TELA DO PORQUÊ (bug B8 do laudo de 2026-07-13:
// `diagnoseFunnel()` existia, excelente e TESTADO, com ZERO consumidor de UI; quando o sistema não
// associava, ele simplesmente CALAVA — o operador via "Pessoa" e não tinha como saber se faltou
// rádio, faltou movimento, ou se a tag é uma ÂNCORA).
//
// A TESE DE PRODUTO: o produto não é só ACERTAR — é DIZER POR QUE NÃO SABE. Um sistema que cala sem
// explicar treina o operador a não confiar nele. Um que diz "não sei, e é porque você está parado" é
// honesto e ACIONÁVEL (o operador anda; o gestor move a câmera).
//
// Componente PURO de apresentação: o estado/timing vive em ../../fusion/useFunnelDiagnosis e a
// matemática dos vetos em ../../fusion/associate (fonte única — nada é recalculado aqui).
//
// INVARIANTES respeitadas:
//  • ADR-003 "a imagem é soberana": o funil vive no PAINEL, nunca sobre o vídeo.
//  • Going-gray: o gate que barrou é INFORMAÇÃO — ícone (forma) + texto + tom, nunca só cor. E o
//    silêncio POR FÍSICA (pessoa parada) NÃO é anormalidade: não ganha cor saturada. O que ganha
//    aviso é o que está ERRADO na configuração (âncora no crachá, motor local).
//  • Regra 8: leitura CRUA e leitura DISTINTA aparecem SEPARADAS — 81,2% do que o hub recebe é
//    cópia do valor anterior (sample-and-hold), então o número cru mente ~4× para cima.
import { type ReactNode } from "react";
import {
  CircleCheck,
  CircleMinus,
  CircleSlash,
  MessageSquare,
  Move,
  Radio,
  Sigma,
} from "lucide-react";
import { Alert, Badge, HelpTip, Kpi, SectionTitle, type Tone } from "../../ui";
import type { FunnelVerdict, PairFunnel } from "../../fusion/associate";
import type { FunnelDiagnosis, PersonFunnel } from "../../fusion/useFunnelDiagnosis";

/** Número em pt-BR com 3 casas (a variância de distância vive na 3ª casa: mediana medida = 0,003). */
export function fmt3(n: number): string {
  return n.toFixed(3).replace(".", ",");
}

/** Por que a fusão tag↔pessoa não está rodando, conforme o MOTOR ativo (ADR-009). PURA/testável.
 *
 *  • "local": a fusão é ESTRUTURALMENTE morta — o `labelFor` só é populado por tracks do HUB, que em
 *    modo local não existem (B7 do laudo). É uma ESCOLHA de deploy, não um defeito → aviso NEUTRO e
 *    discreto (going-gray: cor saturada só p/ anormalidade). O operador merece o motivo PRECISO em
 *    vez de achar que o sistema está quebrado.
 *  • "hub": o motor do hub DEVERIA entregar pistas e não está (hub calado) → isso É anormalidade
 *    (warn).
 *
 *  RESSALVA (documentada, não é feature): mesmo com o motor no hub, o nome só aparece quando a
 *  ASSOCIAÇÃO por rádio de fato acontece — que é RARA (pessoa parada = 94,6% do silêncio medido).
 *  Ligar o hub é NECESSÁRIO, não SUFICIENTE; persistência de rótulo + ReID são ondas futuras. Não
 *  se promete aqui o que a física não entrega. */
export function fusionOffReason(engine: "hub" | "local"): { text: string; anomaly: boolean } {
  if (engine === "local")
    return {
      text: "Identidade por tag exige o motor de análise no servidor (modo atual: local). Enquanto a análise rodar localmente, a fusão tag↔pessoa nem chega a rodar — nenhuma pessoa em cena recebe o nome da tag.",
      anomaly: false,
    };
  return {
    text: "A fusão não está rodando: o motor de análise do hub não está entregando pistas para esta câmera. Sem as caixas das pessoas vindas do hub, não há distância para correlacionar com o rádio — nenhuma tag será associada, em nenhuma hipótese.",
    anomaly: true,
  };
}
function fmt2(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

/** O veredito do funil em PORTUGUÊS CLARO — o que barrou, por quê, e o que FAZER a respeito.
 *  `tone`: "ok" só quando falou; "warn" só quando há algo ERRADO a corrigir (empate/config);
 *  o silêncio previsto pela física fica NEUTRO (going-gray: cor saturada só p/ anormalidade). */
export const VERDICT_PT: Record<
  FunnelVerdict,
  { title: string; why: string; action: string; tone: Tone | "default" }
> = {
  SPOKE: {
    title: "Identificada",
    why: "A correlação entre o sinal da tag e o movimento da pessoa foi forte o bastante e sem empate.",
    action: "Nada a fazer.",
    tone: "ok",
  },
  lowMovement: {
    title: "A pessoa está parada",
    why: "O método compara COMO o sinal da tag muda com COMO a distância da pessoa até a estação muda. Sem movimento não há o que comparar — o cálculo fica indefinido e o sistema prefere calar a chutar.",
    action:
      "Ande alguns passos (aproxime-se ou afaste-se da estação) por ~20 s. Solução estrutural: reposicionar a câmera para a pessoa permanecer mais tempo no campo de visão.",
    tone: "default",
  },
  constantSeries: {
    title: "O sinal da tag não mudou",
    why: "A série de RSSI ficou constante na janela (o rádio repetiu o mesmo valor). Correlação de série constante é matematicamente indefinida.",
    action:
      "Normal com tag e pessoa paradas. Se persistir com a pessoa andando, a tag pode estar anunciando devagar demais ou o app pode estar repetindo a última leitura.",
    tone: "default",
  },
  "distSamples<minSamples": {
    title: "Pouco tempo em cena",
    why: "A pessoa apareceu há pouco: não há amostras de distância suficientes na janela.",
    action:
      "Aguarde — em campo, episódios abaixo de 8 s NUNCA alcançam evidência (0 de 52 medidos); a partir de 18 s, 92% alcançam.",
    tone: "default",
  },
  "rssiSamples<minSamples": {
    title: "Rádio fraco ou intermitente",
    why: "Chegaram poucas leituras da tag na janela.",
    action: "Verifique a estação BLE (viva? ouvindo?) e a distância da tag até ela.",
    tone: "default",
  },
  "aligned<minSamples": {
    title: "Leituras e imagem não coincidiram no tempo",
    why: "Havia tag e havia pessoa, mas os instantes das leituras não casaram com os das caixas na janela.",
    action:
      "Verifique se o motor de análise do hub está entregando pistas na mesma cadência das leituras.",
    tone: "default",
  },
  belowMinConfidence: {
    title: "Evidência fraca",
    why: "Houve movimento e houve rádio, mas a correlação não alcançou o mínimo exigido para falar.",
    action: "Movimento mais amplo (variar a distância até a estação) fortalece a evidência.",
    tone: "default",
  },
  lostTieBreak: {
    title: "Outra pessoa levou esta tag",
    why: "A atribuição é 1-para-1: a tag foi para a pessoa que a explicava melhor.",
    action:
      "Se o rótulo foi para a pessoa errada, avise — é caso de erro de associação, não de silêncio.",
    tone: "warn",
  },
  belowMinMargin: {
    title: "Empate entre duas pessoas",
    why: "Duas pessoas explicam esta tag quase igualmente bem. Sem margem, o sistema prefere calar a arriscar o rótulo errado.",
    action:
      "Afaste-se da outra pessoa, ou faça movimentos diferentes dos dela por alguns segundos.",
    tone: "warn",
  },
};

type ElState = "ok" | "blocked" | "skipped";

const EL_ICON: Record<ElState, typeof CircleCheck> = {
  ok: CircleCheck,
  blocked: CircleSlash,
  skipped: CircleMinus,
};
const EL_SR: Record<ElState, string> = {
  ok: "passou",
  blocked: "barrou aqui",
  skipped: "não avaliado",
};
const EL_CLS: Record<ElState, string> = {
  ok: "text-ok",
  blocked: "text-warn",
  skipped: "text-text-muted",
};

/** Um elo da cadeia: ícone (forma) + estado por extenso (nunca só-por-cor) + o NÚMERO e a RÉGUA. */
function Elo({
  icon: Icon,
  name,
  state,
  children,
}: {
  icon: typeof Radio;
  name: string;
  state: ElState;
  children: ReactNode;
}) {
  const Mark = EL_ICON[state];
  return (
    <li className="flex items-start gap-2">
      <Icon size={14} strokeWidth={1.75} aria-hidden className="mt-0.5 text-text-muted" />
      <span className={`mt-0.5 inline-flex ${EL_CLS[state]}`}>
        <Mark size={14} strokeWidth={1.75} aria-hidden />
        <span className="sr-only">
          {name}: {EL_SR[state]}.
        </span>
      </span>
      <span className="text-sec">
        <b className="text-text">{name}:</b> <span className="text-text-muted">{children}</span>
      </span>
    </li>
  );
}

/** Estado de cada elo a partir do veredito (a cadeia é ORDENADA: o que vem depois do gate que matou
 *  não foi avaliado — dizer "reprovou" ali seria mentira). PURA e exportada p/ teste. */
export function eloStates(v: FunnelVerdict): {
  radio: ElState;
  movimento: ElState;
  evidencia: ElState;
} {
  if (v === "rssiSamples<minSamples")
    return { radio: "blocked", movimento: "skipped", evidencia: "skipped" };
  if (v === "distSamples<minSamples" || v === "aligned<minSamples")
    return { radio: "ok", movimento: "skipped", evidencia: "blocked" };
  if (v === "constantSeries" || v === "lowMovement")
    return { radio: "ok", movimento: "blocked", evidencia: "skipped" };
  if (v === "belowMinConfidence" || v === "lostTieBreak" || v === "belowMinMargin")
    return { radio: "ok", movimento: "ok", evidencia: "blocked" };
  return { radio: "ok", movimento: "ok", evidencia: "ok" }; // SPOKE
}

function PersonCard({
  ordinal,
  p,
  windowMs,
}: {
  ordinal: number;
  p: PersonFunnel;
  windowMs: number;
}) {
  const secs = Math.round(windowMs / 1000);
  // Sem tag no ar: o funil nem existe — o elo RÁDIO é o veredito.
  if (!p.best) {
    return (
      <div className="funnel-card">
        <div className="funnel-head">
          <b className="text-body">Pessoa {ordinal}</b>
          <Badge>sem tag no ar</Badge>
        </div>
        <ul className="funnel-chain">
          <Elo icon={Radio} name="Rádio" state="blocked">
            nenhuma tag BLE foi ouvida nesta janela de {secs} s — não há candidata para associar.
          </Elo>
        </ul>
        <p className="m-0 text-sec text-text-muted">
          Sem leitura de rádio o sistema não tem o que correlacionar. Verifique a estação BLE e se a
          tag está ligada/no alcance.
        </p>
      </div>
    );
  }
  const b: PairFunnel = p.best;
  const t = b.thresholds;
  const V = VERDICT_PT[b.verdict];
  const st = eloStates(b.verdict);
  return (
    <div className="funnel-card">
      <div className="funnel-head">
        <b className="text-body">Pessoa {ordinal}</b>
        {/* Going-gray: o veredito é TEXTO (o tom só reforça). */}
        <Badge tone={V.tone === "default" ? undefined : V.tone}>{V.title}</Badge>
      </div>
      <ul className="funnel-chain">
        <Elo icon={Radio} name="Rádio" state={st.radio}>
          melhor candidata <b className="text-text">{b.tag}</b> — {p.rawReadings} leitura(s)
          recebida(s), <b className="text-text">{p.distinctReadings} distinta(s)</b> na janela de{" "}
          {secs} s (o resto é cópia do valor anterior). Mínimo do motor: {t.minSamples} amostras.
        </Elo>
        <Elo icon={Move} name="Movimento" state={st.movimento}>
          {b.movVar === null
            ? "não calculável — a série do rádio ficou constante (nada varia, nada a correlacionar)."
            : `variação da distância até a estação: ${fmt3(b.movVar)} — necessário ${fmt2(
                t.minMovement,
              )}.`}
        </Elo>
        <Elo icon={Sigma} name="Evidência" state={st.evidencia}>
          {b.alignedSamples} amostra(s) alinhada(s) (mínimo {t.minSamples}) ·{" "}
          {b.corr === null
            ? "correlação indefinida"
            : `correlação r = ${fmt2(b.corr)} · força ${fmt2(b.score)} (necessário ${fmt2(
                t.minConfidence,
              )})`}
          {b.margin === null ? "" : ` · margem ${fmt2(b.margin)}`}
        </Elo>
        <Elo icon={MessageSquare} name="Veredito" state={st.evidencia === "ok" ? "ok" : "blocked"}>
          <b className="text-text">{V.title}.</b> {V.why}
        </Elo>
      </ul>
      <p className="m-0 text-sec text-text-muted">
        <b className="text-text">O que fazer:</b> {V.action}
      </p>
    </div>
  );
}

export function PorQueTab({ diag }: { diag: FunnelDiagnosis }) {
  const { running, analysisEngine, hubTracks, tagsHeard, anchors, people, warmingUp, windowMs } =
    diag;
  // B7 — a PORTA ZERO: sem tracks do hub a fusão NEM RODA. O MOTIVO depende do motor: em modo
  // LOCAL é estrutural (escolha de deploy) → aviso neutro; em HUB é o hub calado → anormalidade.
  const off = running && hubTracks === null ? fusionOffReason(analysisEngine) : null;
  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>Por que não identificou?</SectionTitle>
      <p className="m-0 text-sec text-text-muted">
        A cadeia que decide se uma pessoa em cena ganha o nome da tag — e onde ela parou.{" "}
        <HelpTip label="Ajuda do diagnóstico">
          O sistema associa tag↔pessoa correlacionando a força do sinal (RSSI) com a distância da
          pessoa até a estação, medida pela câmera. Quando ele cala, um elo da cadeia barrou. Em
          campo (n=129 episódios), 94,6% do silêncio [IC 95% 89,2–97,3%] é PREVISTO pela física:
          pessoa parada, sinal constante ou tempo em cena curto demais. Silêncio honesto não é
          defeito — é o sistema não chutando.
        </HelpTip>
      </p>

      {!running && (
        <p className="empty-note">
          Diagnóstico desligado: esta câmera não está recebendo leituras BLE (nenhuma estação
          entregando) — sem rádio não há o que associar, e portanto não há cadeia a percorrer.
        </p>
      )}

      {/* B7 — a PORTA ZERO: sem pistas do motor do hub, a fusão NEM RODA (falha 100% silenciosa até
          aqui: 9 h de gravação com 0 tracks e ~6.500 leituras/h). Going-gray: modo LOCAL é ESCOLHA
          de deploy (motivo preciso, neutro/discreto); hub calado é anormalidade real (warn). */}
      {off &&
        (off.anomaly ? (
          <Alert tone="warn">{off.text}</Alert>
        ) : (
          <p className="empty-note">{off.text}</p>
        ))}

      {/* B5 — a ÂNCORA: excluída da fusão de propósito. Se a tag do crachá é âncora AQUI, ela é
          permanentemente inassociável NESTA câmera — e até hoje isso acontecia em silêncio. */}
      {anchors.length > 0 && (
        <Alert tone="warn">
          {anchors.length === 1 ? "A tag " : "As tags "}
          <b>{anchors.map((a) => a.label).join(", ")}</b>
          {anchors.length === 1 ? " está cadastrada" : " estão cadastradas"} como ÂNCORA desta
          câmera (calibração). Âncora é infraestrutura fixa, nunca vai numa pessoa:{" "}
          {anchors.length === 1 ? "ela nunca será associada" : "elas nunca serão associadas"} a
          ninguém aqui. Se essa tag está num crachá, remova-a das âncoras na aba Calibrar.
        </Alert>
      )}

      {running && hubTracks !== null && (
        <>
          <div className="kpis">
            <Kpi value={hubTracks} label="pessoas em cena" />
            <Kpi value={tagsHeard} label="tags no ar" />
            <Kpi value={`${Math.round(windowMs / 1000)}s`} label="janela" />
          </div>
          {warmingUp && (
            <p className="m-0 text-sec text-text-muted">
              Coletando evidência (a janela de {Math.round(windowMs / 1000)} s ainda está enchendo)
              — os números abaixo ainda vão assentar.
            </p>
          )}
          {people.length === 0 ? (
            <p className="empty-note">Ninguém em cena — nada a identificar agora.</p>
          ) : (
            people.map((p, i) => (
              <PersonCard key={p.trackId} ordinal={i + 1} p={p} windowMs={windowMs} />
            ))
          )}
        </>
      )}
    </div>
  );
}
