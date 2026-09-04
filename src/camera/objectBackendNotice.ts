// Estado do DETECTOR de objetos, em linguagem de operador — o antídoto de um FALSO-OK.
//
// POR QUÊ (bug medido, e a razão de isto ser CÓDIGO e não comentário): **"0 caixas" e "o modelo
// nunca carregou" eram visualmente IDÊNTICOS**. A cadeia, verificada:
//   · o modo Objetos roda 100% no CLIENTE — o motor do hub descarta tudo que não é pessoa
//     (server/analysis/pipeline.js);
//   · o detector primário é o OWL-ViT zero-shot, BAIXADO do HuggingFace em runtime
//     (objects/owlvitWorker.ts fixa `env.allowLocalModels = false`);
//   · sem internet no navegador do operador o worker falha, o latch marca falha PERMANENTE
//     (objects/detector.ts) e o sistema cai no andaime coco-ssd;
//   · o andaime NÃO CONHECE "caixa" — no catálogo (objects/catalog.ts) toda classe não-pessoa
//     tem `coco: []`;
//   · e o default da zona de objetos é exatamente `["caixa"]` (zones.ts).
// Resultado: contagem 0 PARA SEMPRE, indistinguível de "não tem caixa nenhuma". Falso-OK é pior
// que erro — sucesso sem efeito mata o dado em silêncio.
//
// Esta função é PURA (backend × classes selecionadas → aviso, ou `null` quando não há o que
// dizer) e o texto separa MEDIÇÃO de INFERÊNCIA: com o andaime, aquele 0 é do DETECTOR, não da
// cena. O `null` do caminho saudável ("owlvit") é tão testado quanto o aviso — é o que impede o
// aviso de virar decoração permanente.
import type { ObjBackend } from "../objects/detector";
import { objClass } from "../objects/catalog";

export type ObjectBackendNotice = {
  // Só tons de estado que JÁ existem (going gray: saturado só para anormalidade; e modelo caído
  // É anormalidade). "info" = transitório/informativo · "warn" = degradado · "alert" = sem dado.
  tone: "info" | "warn" | "alert";
  text: string; // 1 linha na tela
  help: string; // a prosa vai para o HelpTip (regra de ouro: >1 linha mora no "?")
};

/** De onde vem a contagem de PESSOA da zona (ver ZoneResult em camera/draw.ts). */
export type PeopleSource = "hub" | "aguardando" | "owlvit";

/**
 * Classes selecionadas que o backend ATUAL não tem como enxergar (chaves do catálogo).
 * `peopleSource` "hub"/"aguardando": PESSOA sai desta conta — quem a mede é o motor do servidor
 * (D-FINE), independente do detector do navegador estar caído.
 */
export function blindClasses(
  backend: ObjBackend,
  selectedClasses: readonly string[],
  peopleSource: PeopleSource = "owlvit",
): string[] {
  const doHub = peopleSource !== "owlvit";
  const alcance = doHub ? selectedClasses.filter((k) => k !== "pessoa") : selectedClasses;
  if (backend === "indisponível") return [...alcance];
  // Andaime coco-ssd: só enxerga as classes com equivalente COCO mapeado no catálogo.
  if (backend === "coco") return alcance.filter((k) => !objClass(k)?.coco.length);
  return []; // "owlvit" cobre o catálogo inteiro (zero-shot por prompt); "carregando" ainda não é veredito
}

const REMEDIO =
  "Verifique a conexão do navegador com a internet e recarregue a página: o download do modelo " +
  "é tentado UMA vez por sessão (falhou uma vez, fica no reserva até recarregar).";

export function objectBackendNotice(
  backend: ObjBackend,
  selectedClasses: readonly string[],
  peopleSource: PeopleSource = "owlvit",
): ObjectBackendNotice | null {
  // PESSOA pelo motor do SERVIDOR (D-FINE). MEDIDO (2026-09-03, cozinha real): o OWL-ViT não
  // detecta pessoa em cena interna/oclusa nem no piso 0.15, enquanto o D-FINE rastreia as mesmas
  // pessoas de forma estável — por isso a contagem de pessoa da zona Objetos passou a vir do hub.
  // O operador PRECISA saber qual motor produziu o número (senão volta a ser adivinhação).
  if (peopleSource === "aguardando")
    return {
      tone: "info",
      text: "Aguardando o servidor reportar esta área — o 0 de pessoas não é cena vazia.",
      help:
        "A contagem de PESSOA desta zona vem do motor do servidor (o mesmo que já roda 24/7 na " +
        "câmera), não do detector do navegador. Até ele reportar esta área, pessoa fica FORA da " +
        "contagem de propósito: exibir o 0 do detector do navegador seria falso-OK — foi medido " +
        "que ele não enxerga pessoa em cena interna/oclusa.",
    };
  const pessoaNoHub = peopleSource === "hub";
  const soPessoa = selectedClasses.length === 1 && selectedClasses[0] === "pessoa";
  // Só pessoa selecionada + pessoa medida pelo hub ⇒ o estado do detector do navegador não afeta
  // esta zona. Informa a fonte (sem alarmar) em vez de repetir aviso de detector caído irrelevante.
  if (pessoaNoHub && soPessoa)
    return {
      tone: "info",
      text: "Pessoa contada pelo motor do servidor.",
      help:
        "Esta zona não depende do detector do navegador: quem conta pessoa aqui é o motor de " +
        "análise do servidor (D-FINE), que já roda nesta câmera 24/7. Medido em câmera real: o " +
        "detector do navegador (zero-shot) não reconhece pessoa em cena interna/oclusa.",
    };
  if (backend === "owlvit") return null; // caminho saudável: nada a dizer
  if (backend === "carregando")
    return {
      tone: "info",
      text: "Detector carregando — a contagem ainda não é observação.",
      help:
        "O modelo de objetos é baixado na primeira vez que esta tela abre. Enquanto ele não sobe, " +
        "a contagem mostra 0 por falta de DETECTOR, não por falta de objeto.",
    };
  if (backend === "indisponível")
    return {
      tone: "alert",
      text: "Detector indisponível — esta zona não produz contagem.",
      help:
        "Nem o detector principal nem o de reserva subiram neste navegador. Todo 0 desta zona é " +
        "ausência de MEDIÇÃO, não cena vazia. " +
        REMEDIO,
    };
  // coco = andaime. O caso que mais importa: classes selecionadas que ele não detecta (pessoa
  // sai da conta quando é o hub que a mede — ver blindClasses).
  const cegas = blindClasses(backend, selectedClasses, peopleSource).map(
    (k) => objClass(k)?.label ?? k,
  );
  if (cegas.length)
    return {
      tone: "alert",
      text: `Detector de reserva — ele não detecta ${cegas.join(", ")}. A contagem 0 é do detector, não da cena.`,
      help:
        "O detector principal (zero-shot, baixado da internet) não subiu neste navegador; o de " +
        "reserva reconhece apenas Pessoa. Enquanto isso a contagem destas classes é " +
        "estruturalmente 0 — não use este painel para concluir que a área está vazia. " +
        REMEDIO,
    };
  return {
    tone: "warn",
    text: "Detector de reserva — só Pessoa é reconhecida.",
    help:
      "O detector principal (zero-shot, baixado da internet) não subiu neste navegador. As classes " +
      "selecionadas aqui têm equivalente no detector de reserva, mas o recall é menor. " +
      REMEDIO,
  };
}
