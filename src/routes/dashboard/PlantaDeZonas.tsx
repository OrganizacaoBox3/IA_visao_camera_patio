// O QUE O CLIENTE VÊ NO LUGAR DO VÍDEO: as áreas demarcadas, desenhadas.
//
// Decisão de produto (17/09/2026): o objetivo da plataforma é a NOTIFICAÇÃO, não o plantão de
// olhos. Quem contrata recebe o aviso no WhatsApp e precisa saber ONDE — não precisa de imagem
// ao vivo. Tirar o vídeo do painel do cliente é a economia mais direta que existe: medido em
// produção, painel aberto levou o load de 8,04 para 15,63 numa máquina de 4 vCPU.
//
// O desenho é VETORIAL (polígonos em SVG), e por cima de um FUNDO opcional: a imagem de
// referência que o admin envia (ADR-021) para o cliente ter noção do lugar. O fundo é um
// arquivo ESCOLHIDO POR UM HUMANO, nunca um frame capturado do feed — o ADR-002 segue valendo
// inteiro para o pipeline. Sem imagem enviada, o desenho aparece sozinho e nada quebra.
//
// Custo: zero banda de vídeo, zero frame, e uma imagem estática cacheada pelo navegador.
import { useEffect, useState } from "react";
import { cameraBgUrl, getZones } from "../../api";
import { getVideoTicket } from "../../video/ticket";
import { ZONE_MODE_LABEL, type Zone } from "../../zones";
import {
  COR_DO_MODO,
  VIEWBOX,
  ancoraDoRotulo,
  desenharZonas,
} from "./zonasEstaticas";

export function PlantaDeZonas({
  cameraId,
  cameraLabel,
  /** muda quando alguém edita as zonas por outro posto — força re-busca (idioma `zonesRev`). */
  zonesRev = 0,
  bgRev = 0,
  onOpen,
}: {
  cameraId: string;
  cameraLabel: string;
  zonesRev?: number;
  /** muda quando o admin troca a imagem de referência — força o navegador a largar o cache. */
  bgRev?: number;
  onOpen?: () => void;
}) {
  // `null` = ainda carregando; `[]` = carregou e não há zona. São estados DIFERENTES na tela:
  // "carregando" não pode parecer "esta câmera não vigia nada".
  const [zonas, setZonas] = useState<Zone[] | null>(null);
  const [erro, setErro] = useState(false);

  useEffect(() => {
    let morto = false;
    setZonas(null);
    setErro(false);
    getZones(cameraId)
      .then((z) => {
        if (!morto) setZonas(z);
      })
      .catch(() => {
        // Falha de rede não pode virar "nenhuma zona": o cliente leria uma câmera configurada
        // como câmera que não vigia nada — o falso-OK de sempre, agora no desenho.
        if (!morto) setErro(true);
      });
    return () => {
      morto = true;
    };
  }, [cameraId, zonesRev]);

  // IMAGEM DE REFERÊNCIA (ADR-021): fundo ESTÁTICO enviado pelo admin. Precisa de TICKET porque
  // <image> não manda header (ver cameraBgUrl). Sem imagem enviada o GET dá 404, o `onError`
  // dispara e o fundo some — um quadrado quebrado seria pior que um desenho sem fundo.
  const [fundo, setFundo] = useState<string | null>(null);
  useEffect(() => {
    let morto = false;
    setFundo(null);
    getVideoTicket(cameraId)
      .then((t) => {
        if (!morto) setFundo(cameraBgUrl(cameraId, t, bgRev));
      })
      .catch(() => {
        /* sem ticket, sem fundo — o desenho continua de pé sozinho */
      });
    return () => {
      morto = true;
    };
  }, [cameraId, bgRev]);

  const desenhadas = zonas ? desenharZonas(zonas) : [];
  const corpo = (
    <div className="planta">
      <svg
        className="planta-svg"
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={
          zonas
            ? `Áreas monitoradas em ${cameraLabel}: ${
                desenhadas.map((z) => `${z.label} (${ZONE_MODE_LABEL[z.modo]})`).join("; ") ||
                "nenhuma área demarcada"
              }`
            : `Carregando as áreas de ${cameraLabel}`
        }
      >
        {fundo && (
          // `preserveAspectRatio="none"` casa com o do <svg>: a zona foi desenhada em
          // coordenadas normalizadas sobre ESTE enquadramento, então a imagem tem de esticar
          // igual — respeitar a proporção aqui descolaria o desenho do fundo.
          <image
            href={fundo}
            x={0}
            y={0}
            width={VIEWBOX}
            height={VIEWBOX}
            preserveAspectRatio="none"
            opacity={0.55}
            onError={() => setFundo(null)}
          />
        )}
        {desenhadas.map((z) => {
          const cor = COR_DO_MODO[z.modo];
          const r = ancoraDoRotulo(z.caixa);
          return (
            <g key={z.id}>
              {z.pontos ? (
                <polygon points={z.pontos} fill={cor} fillOpacity={0.14} stroke={cor} strokeWidth={0.6} />
              ) : (
                <rect
                  x={z.caixa.x}
                  y={z.caixa.y}
                  width={z.caixa.w}
                  height={z.caixa.h}
                  fill={cor}
                  fillOpacity={0.14}
                  stroke={cor}
                  strokeWidth={0.6}
                />
              )}
              {/* O NOME é o que liga o desenho à mensagem que o cliente recebeu
                  ("presença em área proibida (Cofre)"). Sem ele o desenho é decoração. */}
              <text x={r.x} y={r.y} className="planta-rotulo" fill={cor}>
                {z.label}
              </text>
            </g>
          );
        })}
      </svg>
      <span className="planta-legenda">
        {erro
          ? "Não foi possível carregar as áreas desta câmera."
          : zonas === null
            ? "Carregando áreas…"
            : desenhadas.length === 0
              ? "Nenhuma área demarcada nesta câmera."
              : `${desenhadas.length} área${desenhadas.length === 1 ? "" : "s"} monitorada${
                  desenhadas.length === 1 ? "" : "s"
                } · imagem ao vivo desligada`}
      </span>
    </div>
  );

  // Sem `onOpen` (cliente) o bloco NÃO é clicável: um botão que não abre nada é promessa falsa.
  if (!onOpen) return corpo;
  return (
    <button
      type="button"
      className="tile tile-open"
      onClick={onOpen}
      aria-label={`Abrir câmera ${cameraLabel}`}
      title="Abrir câmera"
      style={{ all: "unset", cursor: "pointer", display: "block", width: "100%", height: "100%" }}
    >
      {corpo}
    </button>
  );
}
