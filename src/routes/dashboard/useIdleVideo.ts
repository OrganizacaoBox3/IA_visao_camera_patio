// Cola de DOM da ociosidade do painel. A DECISÃO é pura e testada em idle.ts; aqui só se
// observa o gesto do usuário e se aplica o veredito. Mesma divisão de transport.ts/useVideoTransport.
import { useEffect, useRef, useState } from "react";
import { deveSoltarVideo, IDLE_MS } from "./idle";

// Gestos que contam como "tem gente aqui". `pointermove` cobre mouse e caneta; `touchstart`
// cobre o tablet do supervisor. Passivos: nenhum deles cancela scroll, e marcar passive evita
// que o listener entre no caminho crítico de rolagem.
const GESTOS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

// Resolução do relógio de ociosidade. Não é o timeout: é de quanto em quanto tempo se PERGUNTA
// se ele venceu. 15s dá erro máximo de 15s sobre 5 min (5%), e custa um timer em vez de um
// re-arme de setTimeout a cada pixel de mouse — que era o desenho óbvio e o caro.
const TICK_MS = 15_000;

/**
 * `true` quando o painel está abandonado (sem gesto por `timeoutMs`, ou aba oculta).
 * Quem chama decide o que soltar — aqui não se toca em vídeo nem em socket.
 */
export function useIdleVideo(timeoutMs: number = IDLE_MS): boolean {
  const [ocioso, setOcioso] = useState(false);
  const ultimaRef = useRef<number>(Date.now());
  // Espelho do estado para os listeners: sem ele, cada mudança de `ocioso` recriaria os
  // listeners (o efeito dependeria do state) e o `pointermove` viraria re-registro em rajada.
  const ociosoRef = useRef(false);

  useEffect(() => {
    ociosoRef.current = ocioso;
  }, [ocioso]);

  useEffect(() => {
    const marcar = () => {
      ultimaRef.current = Date.now();
      // Volta na hora: quem mexeu o mouse quer ver imagem agora, não daqui a 15s.
      if (ociosoRef.current) setOcioso(false);
    };
    const aoTrocarVisibilidade = () => {
      if (document.visibilityState === "visible") marcar();
      else setOcioso(true); // oculta: solta já (idle.ts documenta o porquê)
    };

    for (const g of GESTOS) window.addEventListener(g, marcar, { passive: true });
    document.addEventListener("visibilitychange", aoTrocarVisibilidade);

    const id = window.setInterval(() => {
      const solta = deveSoltarVideo(
        Date.now(),
        ultimaRef.current,
        document.visibilityState === "visible",
        timeoutMs,
      );
      // Só escreve na transição — setState com o mesmo valor ainda re-renderiza a árvore de tiles.
      if (solta !== ociosoRef.current) setOcioso(solta);
    }, TICK_MS);

    return () => {
      for (const g of GESTOS) window.removeEventListener(g, marcar);
      document.removeEventListener("visibilitychange", aoTrocarVisibilidade);
      window.clearInterval(id);
    };
  }, [timeoutMs]);

  return ocioso;
}
