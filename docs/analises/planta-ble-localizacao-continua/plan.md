# Plano técnico — localização contínua na Planta BLE

> Implementa [spec.md](./spec.md).  
> Regra de execução: **paralelizar por propriedade exclusiva de arquivo e serializar a revisão**.

## 1. Estratégia

Corrigir o pipeline em camadas, começando pelo sensor que prova o defeito. Primeiro tornar a evidência
temporal íntegra; depois corrigir os dois mecanismos de inferência; em seguida selecionar a saída por
qualidade, aplicar movimento e relacioná-la à geometria independente das áreas. Só então alterar a
apresentação.

Nenhum mecanismo recebe autoridade para encaixar o ponto em uma zona ou mesa.

```text
GET /api/bt/tags
      │ BtReading { stationId, mac, rssi, measuredAt, ... }
      ▼
seleção temporal ───► vetor vivo fresco/sincronizado
      │
      ├──► fingerprint ─► { label?, pos?, margin, uncertainty, quality }
      │
      └──► multilateração calibrada ─► { rawPos, pos?, residual, quality }
                                        │
                         seletor explícito de fonte
                                        ▼
                            filtro de movimento/TTL
                                        ▼
                          posição publicada + halo
                                        │
               polígonos de trabalho ──┴─► distância/dentro/fora
```

## 2. Contratos entre frentes

Os nomes finais podem se ajustar ao padrão local, mas o conteúdo semântico não pode ser perdido.

### 2.1 Leitura temporal

```ts
type BtReading = {
  stationId: string
  mac: string
  rssi: number
  measuredAt: number
  receivedAt?: number
}
```

- Chave distinta: estação canônica + MAC canônico + `measuredAt`.
- Comparação de estação: canônica/case-insensitive; label original preservado para UI.
- Um snapshot sem `measuredAt` válido não pode entrar como nova evidência independente.

### 2.2 Candidato de localização

```ts
type PositionCandidate = {
  pos: { x: number; y: number } | null
  rawPos?: { x: number; y: number }
  source: "fingerprint" | "multilateration"
  measuredAt: number
  uncertaintyM: number
  quality: "high" | "medium" | "low" | "invalid"
  reason?: string
  residualM?: number
  stationsUsed: number
}
```

`pos: null` é uma saída válida e preferível a uma coordenada falsa.

### 2.3 Posição publicada

```ts
type PositionTrack = {
  pos: { x: number; y: number } | null
  state: "moving" | "stopped" | "uncertain"
  source: "fingerprint" | "multilateration" | "held" | "none"
  measuredAt: number | null
  uncertaintyM: number
}
```

### 2.4 Área de trabalho

```ts
type WorkArea = {
  id: string
  label: string
  polygon: Array<{ x: number; y: number }>
}
```

A relação derivada contém `inside`, `distanceM` e a incerteza posicional usada. Não altera o track.

## 3. Ondas de implementação

### Onda A — sensores e baseline

1. Fixar em testes o colapso matemático do fingerprint central no modelo legado.
2. Fixar casos de poll repetido, leitura pré-captura, vetor dessincronizado e diferença de case.
3. Fixar casos de geometria inválida que hoje viram borda.
4. Fixar os contratos do filtro de movimento e distância ponto→polígono.

O teste deve ser observado vermelho contra o comportamento antigo antes do fix correspondente. A falha
é registrada em `resultado.md` sem deixar o branch final vermelho.

### Onda B — tempo e fingerprinting

1. Propagar timestamps reais no contrato HTTP/frontend.
2. Deduplicar captura antes de qualquer mediana/desvio; rejeitar evidência pré-início.
3. Formar vetor ao vivo por tag com idade máxima e dispersão temporal máxima.
4. Agregar múltiplas tags de calibração de forma robusta/balanceada, sem misturar identidades por acaso.
5. Usar variância salva com piso, limitar pesos e balancear votos por rótulo.
6. Emitir posição apenas quando cobertura, distância e margem sustentarem a inferência.

### Onda C — núcleo geométrico

1. Permitir `rssiAt1m` e expoente por estação, mantendo fallback explícito para config antiga.
2. Propagar posição bruta, residual e motivo de rejeição.
3. Avaliar qualidade antes de qualquer operação de desenho.
4. Não publicar coordenada obtida apenas por corte ao retângulo.
5. Manter multilateração como fallback/diagnóstico até que dados de campo comprovem seu ganho isolado.

### Onda D — seleção, movimento e áreas

1. Selecionar a fonte por gates explícitos; fingerprint é primário quando válido.
2. Aplicar limite de velocidade dependente de `Δt`, suavização por estado e TTL de manutenção.
3. Criar geometria pura para ponto-em-polígono e distância à borda.
4. Persistir áreas de trabalho como entidades independentes da zona de fingerprint.
5. Derivar distância e dentro/fora sem modificar a posição.

### Onda E — integração e UI

1. Fazer `useFloorplanMap` consumir o track contínuo, não apenas a coordenada geométrica legada.
2. Desenhar halo de incerteza e distinguir visualmente observada/mantida/incerta.
3. Exibir zona provável, fonte, idade, cobertura e distância à área em camadas separadas.
4. Remover textos que transmitam “coordenada firme” quando residual/idade não sustentarem isso.
5. Preservar progressive disclosure: diagnóstico detalhado sob demanda, mapa limpo por padrão.
6. Manter nomes acessíveis existentes ou atualizar e2e no mesmo diff.

### Onda F — avaliação e fechamento

1. Criar fixture determinística estratificada para barrar regressões matemáticas.
2. Definir protocolo de survey de treino e pontos ground truth de teste independentes.
3. Medir mecanismo por mecanismo e o seletor completo.
4. Registrar `p50`, `p90`, jitter, saltos, cobertura, rejeições e limitação, com `n` e Wilson.
5. Rodar suíte focal, typecheck, build, testes completos e e2e da rota.
6. Criar `resultado.md` com baseline→resultado, evidências, metas não atingidas e riscos residuais.

## 4. Mapa requisito → implementação → sensor

| Requisito | Dono principal | Sensor |
|---|---|---|
| R01–R03 | `src/api.ts`, `src/planta/useFingerprints.ts` | testes de captura temporal/deduplicação |
| R04–R05 | `src/fusion/fingerprint.ts` | `src/fusion/fingerprint.test.ts` |
| R06 | `src/fusion/floorplan.ts`, `src/fusion/floor-plot.ts` | testes de residual/posição bruta/rejeição |
| R07 | `src/planta/useFloorplanMap.ts` ou módulo puro novo de seleção | teste do seletor por qualidade |
| R08 | módulo puro novo em `src/fusion/` | teste de velocidade, parada, TTL e ordem temporal |
| R09 | módulo puro novo em `src/fusion/`; `server/bt/floorplan.js` se persistido | teste ponto/polígono + contrato servidor |
| R10 | `src/planta/drawFloorplan.ts`, `src/planta/FloorplanCanvas.tsx`, `src/routes/PlantaBlePage.tsx` | unit de desenho + Playwright |
| R11 | harness/fixture em `eval/` ou pasta de domínio equivalente | comando de avaliação com saída versionável |
| I06/AC01 | `src/planta/ZoneCalibration.tsx` | `src/planta/ZoneCalibration.test.tsx` |

## 5. Mapa de impacto

### Frontend — contratos e inferência

- `src/api.ts`: timestamp/identidade das leituras.
- `src/fusion/fingerprint.ts`: distância estatística, votação, posição e confiança.
- `src/fusion/floorplan.ts`: modelos por estação, residual e rejeição.
- `src/fusion/floor-plot.ts`: conversão de resultado em view, sem esconder invalidade.
- Novos módulos puros em `src/fusion/`: seleção, movimento e geometria de área.

### Frontend — fluxo da Planta BLE

- `src/planta/useFingerprints.ts`: captura e vetor temporal.
- `src/planta/useFloorplanMap.ts`: fonte contínua, track e relações espaciais.
- `src/planta/ZoneCalibration.tsx`: validação canônica de estação.
- `src/planta/drawFloorplan.ts`: halo e estados sem falsa certeza.
- `src/planta/FloorplanCanvas.tsx`: contrato de desenho.
- `src/routes/PlantaBlePage.tsx`: composição e progressive disclosure.
- Testes homônimos ao lado de cada lógica pura; e2e da rota quando texto/fluxo mudar.

### Backend BLE

- `server/bt/bt-readings.js`: preservar/servir tempo real da medição.
- `server/bt/fingerprints.js`: persistir metadados úteis sem reescrever dado histórico.
- `server/bt/floorplan.js`: extensão aditiva para calibração por estação/áreas, se necessária.
- Testes de contrato correspondentes.

O contrato deve permanecer aditivo. Nenhuma gravação `jsonl` de campo será alterada ou removida.

## 6. Paralelização e propriedade de arquivo

| Frente | Propriedade exclusiva durante a onda | Dependência de entrada |
|---|---|---|
| Documentação | somente esta pasta de análise | diagnóstico consolidado |
| Fingerprint temporal | `src/api.ts`, `src/fusion/fingerprint*`, `src/planta/useFingerprints.ts` | contratos §2.1–2.2 |
| Geometria | `src/fusion/floorplan*`, `src/fusion/floor-plot*` | contrato §2.2 |
| Movimento/áreas | novos módulos puros e seus testes | contratos §2.3–2.4 |
| Integração/UI | hooks/canvas/rota, após ondas B–D | todas as saídas estabilizadas |
| Backend | `server/bt/*` nomeados, em onda própria | contrato HTTP acordado |

Após cada onda, o estado combinado é revisado de forma serial, procurando também helpers duplicados,
drift de tipo e uma fonte se sobrepondo à outra.

## 7. Decisões assumidas

1. Fingerprint é a fonte primária nesta instalação enquanto tiver cobertura e confiança; isso não é uma
   afirmação universal sobre BLE.
2. Multilateração permanece disponível como fallback/diagnóstico, mas fala somente quando seus gates
   passam.
3. Limite de velocidade, janela temporal, TTL e pisos de variância são constantes de domínio nomeadas e
   testadas; só viram configuração de UI se a medição mostrar necessidade operacional real.
4. A mesa é representada por polígono; retângulo é apenas a primeira forma de edição.
5. A classificação de zona continua útil mesmo quando a posição não é publicável.

## 8. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Quatro fingerprints não cobrem toda a planta | survey em malha + holdout independente; não prometer métrica antes |
| Fingerprint parecer bom por vazamento de treino | separar IDs/sessões/pontos de treino e teste no harness |
| Timestamps serem de recebimento, não medição | nomear ambos quando existirem; declarar resolução do instrumento |
| Filtro esconder erro em vez de corrigir fonte | medir candidato bruto e track separadamente; publicar rejected/jumps |
| Parâmetros geométricos “calibrados” só no centro | calibração multi-distância/multi-orientação e validação fora do ajuste |
| Cobertura cair ao aplicar gates honestos | mostrar ausência/incerteza; escolher trade-off por curva precisão×cobertura |
| UI voltar a afirmar certeza | estados visuais e testes de contrato textual/acessível |
| Edição concorrente em arquivos compartilhados | posse exclusiva por onda e integração serializada |

## 9. Validação

Ordem mínima, sempre executada no estado combinado:

```powershell
npm test -- --run src/fusion/fingerprint.test.ts src/fusion/floorplan.test.ts
npm test -- --run src/planta/ZoneCalibration.test.tsx src/planta/drawFloorplan.test.ts
npm run typecheck
npm run build
npm test
npx playwright test
```

O harness de acurácia de campo é adicional ao gate determinístico. O fixture barra regressão; o conjunto
independente completo decide se há qualidade suficiente para uso operacional.
