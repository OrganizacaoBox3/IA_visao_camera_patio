// CONTRATO DE EVIDÊNCIA do motor de fusão indoor (ADR-013, item 2) — o VOCABULÁRIO que todo sensor
// futuro (AoA/UWB/mmWave/2ª antena) implementa para entrar pela MESMA porta do BLE de hoje.
//
// NÃO confundir com `src/localizacao/evidence.ts` (trilha outdoor/AirTag do ADR-012: relatório de
// coletor móvel com GPS). Este arquivo é do domínio FUSION (indoor, câmera+rádio) e não importa nada
// de lá — os dois contratos coexistem porque descrevem entradas de motores diferentes.
//
// A TAXONOMIA DOS DOIS EIXOS (QUEM × ONDE — ADR-013):
// todo sensor de localização vota em DOIS problemas distintos, IDENTIDADE (QUEM é este track) e
// POSIÇÃO (ONDE ele está), com forças diferentes. A taxonomia do motor são os eixos, não a lista
// de sensores — trocar de hardware troca os PESOS com que cada eixo é alimentado, nunca a
// arquitetura. O `MeasurementKind` tipa a evidência pela NATUREZA da medição:
//
//   eixo ONDE (posicional):
//   - "position2d"      → posição 2D no plano do chão (câmera calibrada via homografia; mmWave;
//                          UWB multi-âncora resolvido). Voto forte em ONDE.
//   - "range"           → distância escalar à fonte (UWB two-way ranging; RSSI→distância SE um dia
//                          voltar calibrado — a v4 caiu, ver ADR-013). Voto médio em ONDE.
//   - "bearing"         → ângulo de chegada (AoA). Voto médio-forte em ONDE (1 antena = semirreta).
//   eixo QUEM (identidade):
//   - "identity-series" → escalar correlacionável no TEMPO (o RSSI de hoje: a série sobe/desce
//                          junto com o corpo real — corr −0,91 em campo). Voto forte em QUEM,
//                          quase nada em ONDE. É o que o associador de produção consome.
//   - "identity-claim"  → identidade EMBUTIDA na medição (UWB: o pacote ranging já diz qual tag é).
//                          Voto direto em QUEM, sem precisar correlacionar.
//
// Cada tipo novo só nasce quando um sensor REAL o exigir (YAGNI vigiado pelo checklist —
// `docs/cientifica/checklist-entrada-sensor.md`).
//
// SOBRE `sigma` (incerteza) SER OPCIONAL — decisão, não esquecimento: o ADR-013 exige incerteza
// obrigatória POR MEDIÇÃO em espírito (sem ela, fundir fontes heterogêneas é chute com cara de
// conta). Mas as DUAS fontes de hoje ainda não a estimam: o RSSI entra como série correlacionável
// (a incerteza vive no gate de significância do associador — n_eff/correlação — não na leitura), e
// o track de câmera não propaga covariância da homografia. Tipar `sigma` como obrigatório AGORA
// forçaria as fontes atuais a inventar um número — pior que não ter. Fica OPCIONAL (campo aditivo)
// e VIRA OBRIGATÓRIO quando a primeira fonte posicional real (UWB/AoA/mmWave) chegar — é ela que
// torna "fundir posições com covariância" necessidade em vez de abstração (ADR-013, item 6).
//
// ESTE ARQUIVO NÃO É CONSUMIDO PELOS CONTRATOS EXISTENTES (RawReading/FusionFrame seguem intactos —
// aditividade do ADR-013): é a peça de vocabulário que os ADAPTERS futuros implementam. A métrica
// de universalidade do ADR (item 7) prevê que plugar a 2ª fonte mude ~zero linhas do motor —
// adapter novo emitindo este contrato, e mais nada.

/** Natureza da medição — em que EIXO (QUEM/ONDE) a evidência vota. Ver taxonomia no header. */
export type MeasurementKind =
  | "position2d"
  | "range"
  | "bearing"
  | "identity-series"
  | "identity-claim";

/** Tipo da FONTE física. União aberta (`string & {}` preserva o autocomplete dos literais
 *  conhecidos sem fechar a porta): sensores futuros declaram o seu ("uwb", "aoa", "mmwave", ...)
 *  sem esperar release deste arquivo. */
export type SourceKind = "ble-rssi" | "camera-track" | (string & {});

/** Metadados que TODA evidência declara: de QUAL fonte física veio (sourceId — ex.: o stationId
 *  da estação BLE, o cameraId da câmera), de que TIPO ela é (sourceKind) e em que eixo vota
 *  (kind). `sigma` = desvio-padrão da medição na unidade dela (m para range/position2d, rad para
 *  bearing) — opcional HOJE por decisão declarada (ver header). */
export type EvidenceMeta = {
  sourceId: string;
  sourceKind: SourceKind;
  kind: MeasurementKind;
  sigma?: number;
};
