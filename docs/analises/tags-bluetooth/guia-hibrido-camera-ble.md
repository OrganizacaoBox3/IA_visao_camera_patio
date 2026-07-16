# Guia de implementação — rastreamento híbrido câmera+BLE (registro + parecer da casa)

> Data: 2026-07-15 · Origem: guia de implementação fornecido pelo dono (fonte externa; **verbatim na
> Parte 2**). A Parte 1 é o parecer da casa: o guia cruzado com o que o projeto JÁ mediu, construiu e
> refutou (ADRs 012–016, `PENDENCIAS.md`, `requisitos-localizacao-planta-2d.md`, laudos de campo).
> Relacionados: `requisitos-localizacao-planta-2d.md` (requisitos da trilha só-BLE),
> `spec-multi-antena-ble.md`, ADR-015 (portal de identificação).

---

# PARTE 1 — Parecer da casa

## 1. Veredito

O guia é **~80% convergente** com o que este projeto já construiu e mediu — em vários pontos ele
chega, por caminho independente, às MESMAS decisões da casa (câmera localiza / BLE identifica; pé da
caixa; homografia com restrições; BLE rebaixado a zona/presença; portal de entrada; confiança de
posição separada da de identidade; estados explícitos; piloto pequeno com gate). Isso é bom sinal:
duas análises independentes desenhando a mesma arquitetura.

O que ele **acrescenta de valioso**: o marcador visual no crachá (Estratégia B — novidade real),
o piloto de 100 m², números de projeto para o filtro de movimento, e a hipótese do advertising de
100–200 ms (a VERIFICAR — se a tag for configurável, muda a física do rádio inteira).

O que ele **contraria ou ignora do que já foi medido/decidido**: histórico de trajetórias × ADR-002
(LGPD), extrapolação em oclusão (lição do overshoot), e assume advertising configurável sem checar.

## 2. Convergências — o guia confirma o que a casa já fez

| Guia | Equivalente já existente/medido |
|---|---|
| §1/§24 "câmera localiza, BLE identifica" | Reformulação fundadora do arco (`00-avaliacao-e-plano.md`, 2026-07-08) |
| §2.1 BLE puro não sustenta 1–3 m em 2.500 m² | Medido 2× (arco da câmera + campo jul/15) — `requisitos-localizacao-planta-2d.md` §4-B |
| §7.2 pé da caixa (bottom-center), nunca o tronco | `frame.ts:61` (produção) |
| §7.3–7.4 homografia por pontos no chão + restrições | Calibração por retângulo de dimensão conhecida + grade de conferência (`10-calibracao-melhoria.md`, implementado) |
| §9.1 zona de entrada controlada | ADR-015: **portal de identificação** (câmera no corredor + receptor no fim — 100% de precisão medida no destino vs 55,6% baseline) |
| §9.3 facial rejeitado | Mesma decisão desde o dia 1 (a tag É a alternativa deliberada ao facial) |
| §11.1 dedup/janela/EMA nas leituras | `measuredAt` + Regra 8 já em produção (83% do que o hub recebe é cópia — deduplicado na entrada). Ressalva da casa que o guia não tem: **nunca interpolar RSSI** (inventa pontos, infla n, enviesa r) |
| §11.2 trilateração só complementar | Já rebaixada: multilateração é "estimativa de demo" declarada; zona/fingerprint é o sinal confiável |
| §11.3 fingerprinting no piloto | Rota B validada em campo (15/15 em rodadas cegas, margens 30–40 dB) — `fingerprint.ts` |
| §12 confiança de posição ≠ confiança de identidade | ADR-013: taxonomia QUEM×ONDE — é literalmente a arquitetura do motor |
| §12 associação probabilística com score por par | `associate.ts` (score por par, guarda top-2, abstenção honesta) |
| §13.2 gate de velocidade | G1 de `requisitos-localizacao-planta-2d.md` §5 (proposto, não construído) |
| §14 pessoa parada = caso principal | Laudo 2026-07-13: 41,9% dos episódios são pessoa parada — o ponto cego do método por correlação; o guia resolve pela MESMA via que o ADR-015 (identidade ancorada em momentos informativos + mantida pelo tracker) |
| §16 planta navegável | `floor-polygon.ts` pronto e testado, sem consumidor |
| §17 estados explícitos | R11 dos requisitos (o guia expande para 7 estados — adotar a lista dele) |
| §18 metas com percentis | Regra 10/corolário Wilson da casa (sempre com n e IC) |
| §22 risco 5 "aparência de precisão falsa" | Invariante da casa: rótulo errado é pior que nenhum; selos de confiança já na UI |
| §19 fases com gate | Método da casa; o aparato de medição (bancada `/replay`, protocolo de campo #4, harness) já está pronto para as Fases 7–8 |

## 3. Novidades valiosas (o que o guia acrescenta)

1. **Marcador visual no crachá (Estratégia B) — a recomendação central do guia, e é NOVA no arco.**
   Nunca foi considerada nos docs do projeto (consideramos correlação RSSI, ReID visual e facial).
   Análise da casa: é a **âncora de identidade mais barata e determinística** disponível — encaixa
   exatamente no desenho ADR-015 (âncora por entrada + manutenção por tracker/labelMemory + BLE como
   redundância), substituindo/reforçando a âncora por rádio no portal. **Atalho de implementação
   real: o projeto JÁ tem leitor ZXing no cliente (modo Leitura)** — um QR grande no crachá, lido num
   portal, implementa a Estratégia B sem biblioteca nova (ArUco/AprilTag seriam lib nova; QR não).
   Ressalva de física que o guia declara e a casa confirma: o marcador só é legível PERTO da câmera
   (um QR de ~5 cm precisa de ~20 px — em vista ampla de 10×10 m só decodifica no primeiro terço) →
   funciona como **PORTAL**, não como identificação contínua. A manutenção da identidade entre
   âncoras continua sendo o problema do tracker (ttlMs/labelMemory/ReID) — o marcador não o dissolve.
2. **Piloto de 100 m² (10×10 m) com câmera cobrindo tudo.** Redimensiona o alvo: o risco físico
   declarado no §4-B dos requisitos (3 receptores em 2.500 m²) praticamente desaparece no piloto —
   e as metas §18.1 do guia (mediana ≤2 m, p95 ≤4 m parado) **são atingíveis com câmera calibrada**
   (a homografia dá erro decimétrico perto e degrada longe — 100 m² fica dentro da zona boa).
3. **Números de projeto para o filtro de movimento** (G1 dos requisitos, que estava sem constantes):
   v_max 2 m/s (a casa mediu caminhada operacional em 1,1–1,2 m/s — usar 2 m/s como teto,
   configurável), candidata a parada ~1 s, confirmação 3–5 s, latência alvo ≤2 s. Adotar.
4. **Advertising de 100–200 ms (§4.1) — a hipótese mais consequente do guia, e está NÃO VERIFICADA.**
   A DX-CP27 real foi MEDIDA anunciando a ~2,2–2,5 s (mediana, n=30.267 intervalos). O guia assume
   que se configura 100–200 ms. **Se a tag for reconfigurável** (muitos iBeacons são, via app do
   fabricante), a lei `n_eff ≤ T/Δt_tag` muda de escala: Δt 2,5 s → 0,2 s = **12× mais medições
   distintas**; o "corredor de ~20 m" vira ~2 m; a "aproximação morta por contagem" ressuscita.
   Seria o maior ganho grátis disponível no arco inteiro — o projeto discutia COMPRAR tags de 1–2 Hz
   sem saber se as atuais são configuráveis. Custos a pesar: bateria (nota da casa: 1 Hz ≈ 1–2 anos
   de CR2032; 100 ms é agressivo — meses) e o app da estação hoje guarda só a ÚLTIMA leitura por MAC
   por POST de 500 ms (com advertising rápido, descartaria a maioria — precisa acumular por batch).

## 4. Conflitos e decisões pendentes (onde o guia bate na doutrina)

1. **Histórico/trajetórias armazenadas (§21, §23 "histórico básico") × ADR-002.** Hoje NENHUMA
   trajetória é persistida (local-first/LGPD: só metadados/indicadores; gravação de pesquisa é
   opt-in e gitignored). "Histórico básico" e "proteção das trajetórias armazenadas" exigem decisão
   consciente do dono + ADR novo (finalidade, retenção, acesso — o próprio guia lista os requisitos
   LGPD). Não implementar por arrasto.
2. **"Posição BLE aproximada" como evidência do score (§12).** A casa refutou RSSI→distância métrica
   para DECISÃO (ADR-014 regra nº 6; v4 revertida). A forma válida da evidência é **ZONA por
   fingerprint** (discreta, validada), não distância em metros. E ao somar evidências vale a Regra
   13: dado independente ≠ erro independente — medir `agreementOnFailure` antes de confiar na soma.
3. **Previsão de trajetória em oclusão (§15.1 "manter a última velocidade").** Lição medida da casa
   (motor v2 da pesquisa): extrapolação causa overshoot e perdeu o torneio — manter posição com
   incerteza crescendo é mais honesto que extrapolar. Adotar a versão conservadora do §15.2 (última
   posição + estado incerto + zona BLE), pulando a extrapolação ativa.
4. **iBeacon/Major-Minor (§4.1).** O app atual identifica por MAC (estável nas CP27 — medido). Se as
   tags forem reconfiguradas para iBeacon, o app precisa parsear o payload. Detalhe de implementação,
   não bloqueio.

## 5. O gap técnico que o guia expõe (o achado mais importante do parecer)

**Não existe hoje um referencial global câmera→planta.** A homografia da câmera produz metros no
referencial LOCAL do retângulo calibrado (origem no canto do retângulo); a planta (`/planta-ble`)
tem seu próprio referencial (origem no canto do galpão). São dois mundos independentes — **a pessoa
vista pela câmera não tem coordenada NA PLANTA hoje**. O guia assume esse elo como dado (Fase 1:
"definir origem X/Y" única; §6.4 "área visível por cada câmera" na planta).

O que falta é barato mas estrutural: cadastrar os pontos de calibração da câmera **em coordenadas da
planta** (ou, equivalente, um offset+rotação por câmera: `T_câmera→planta`). É pré-requisito de:
pessoa-da-câmera-na-planta (o produto final do guia), área de cobertura da câmera desenhada na
planta, e multi-câmera (§20). Entra como pendência P-G2 abaixo.

## 6. Fases do guia × estado do main (2026-07-15)

| Fase do guia | Estado no main |
|---|---|
| F0 validação de equipamentos | 🟡 Grande parte feita: tags medidas (spike jul/08: RSSI, ruído; advertising ~2,2–2,5 s), 3 celulares validados em campo (jul/15: rssi0 real ~−66/−70, concordantes), RTSP suportado. Falta: verificar configurabilidade do advertising (P-G1) e formalizar o "relatório dos sensores" |
| F1 referencial da planta | 🟡 Planta com dimensões+antenas ✅; calibração px→m ✅; **falta o referencial global (P-G2)** e cadastro de obstáculos (modelo existe só como primitivo, `floor-polygon.ts`) |
| F2 rastreamento visual | 🟡 Detector (D-FINE no hub) + tracker + posição no piso ✅; **falta**: velocidade/direção expostas, detecção de parada, estados, e a trajetória aparecer NA PLANTA (depende de P-G2) |
| F3 pipeline BLE | ✅ Em grande parte: ingest+dedup+token, fingerprint/zona, saúde por estação (chip + aba Estações). Falta o "painel de qualidade" consolidado |
| F4 associação inicial | 🟡 Motor por correlação existe (`associate.ts` — mecanismo DIFERENTE do proposto e complementar); **zona de entrada/portal não existe; marcador visual não existe** (ZXing disponível) |
| F5 fusão e recuperação | 🟡 `labelMemory` (manutenção do vínculo) ✅; recuperação pós-oclusão por ReID ✗ (ADR-015 desenhado, não construído); restrições da planta ✗; modo degradado parcial (M6 da spec multi-antena) |
| F6 estabilização | 🔴 O filtro de movimento (G1 dos requisitos) não existe |
| F7 testes multi-pessoa | 🔴 Não iniciada — mas o aparato (bancada `/replay`, cenários sintéticos com cruzamento/bloco/multidão, protocolo de campo #4) está pronto para executá-la |
| F8 avaliação | 🔴 Não iniciada; os 4 desfechos do guia (X/Y · só-áreas-visíveis · só-zonas · reprovado) são uma régua boa e ficam adotados |

## 7. Pendências novas registradas (deste parecer)

- **P-G1 — Verificar a configurabilidade do advertising da DX-CP27** (app do fabricante/datasheet).
  Decide a economia do rádio inteira (ver §3.4). Se configurável: escolher intervalo pesando bateria
  (100–200 ms é agressivo; 500 ms–1 s pode ser o equilíbrio) e adaptar o app da estação para
  acumular leituras por batch (hoje guarda só a última por MAC).
- **P-G2 — Referencial global câmera→planta** (`T_câmera→planta` por câmera, ou calibração já em
  coordenadas da planta). Pré-requisito do produto final do guia e do multi-câmera.
- **P-G3 — Marcador visual no crachá (decisão do dono).** Recomendação da casa: SIM, via QR no
  portal (reusa ZXing; ArUco/AprilTag exigiriam lib nova — só se o QR reprovar em campo).
- **P-G4 — Histórico/trajetória × LGPD**: decisão explícita + ADR antes de persistir qualquer
  trajetória (hoje o ADR-002 proíbe por padrão).
- **P-G5 — Filtro de movimento (G1 dos requisitos)** ganha as constantes do guia: v_max 2 m/s
  (teto, configurável), parada candidata ~1 s / confirmada 3–5 s, latência alvo ≤2 s.
- **P-G6 — Estados**: adotar a máquina de 7 estados do §17 (supera os 3 estados do R11).

---

# PARTE 2 — O guia, verbatim

## 1. Objetivo do projeto

Desenvolver um sistema capaz de localizar pessoas em uma planta 2D de fábrica, representando cada indivíduo por coordenadas X e Y em metros.

Cada pessoa utilizará um beacon Bluetooth DX-CP27 preso ao crachá. Celulares Android fixos receberão os sinais BLE. Uma câmera será utilizada como principal fonte de localização espacial.

O sistema deverá responder a duas perguntas:

* **Onde está a pessoa?**
* **Quem é essa pessoa?**

A divisão recomendada é:

* **Câmera:** determina onde existe uma pessoa e acompanha sua trajetória.
* **BLE:** informa quais beacons estão presentes e auxilia na identificação.
* **Motor de fusão:** associa cada trajetória visual ao beacon correspondente.
* **Mapa 2D:** apresenta a pessoa identificada na planta da fábrica.

## 2. Conclusão de viabilidade

### 2.1 Somente BLE

Com três celulares fixos e os beacons DX-CP27, é possível construir uma prova de conceito de localização aproximada.

Entretanto, somente o RSSI Bluetooth não sustenta com segurança uma promessa de precisão contínua entre 1 e 3 metros em uma fábrica de 50 × 50 metros contendo paredes, máquinas e estruturas metálicas.

O BLE puro é mais adequado para:

* identificar presença;
* determinar proximidade;
* localizar por zona ou setor;
* fornecer uma posição aproximada;
* manter uma última região conhecida.

### 2.2 Câmera e BLE

A inclusão da câmera melhora significativamente a viabilidade.

A câmera consegue observar diretamente:

* posição da pessoa;
* direção;
* velocidade;
* trajetória;
* momento em que a pessoa para;
* continuidade do movimento.

O BLE deixa de ser responsável por calcular com precisão o X/Y e passa a fornecer principalmente:

* identidade do crachá;
* confirmação de presença;
* região aproximada;
* apoio durante oclusões;
* auxílio na recuperação de identidades visuais perdidas.

A arquitetura híbrida é a abordagem recomendada.

## 3. Escopo físico

### 3.1 Área total

* Área total aproximada: **50 m × 50 m** (2.500 m²).
* Ambiente industrial com: paredes; máquinas; estruturas metálicas; circulação de pessoas; pontos cegos; interferência e reflexão de sinais Bluetooth.

### 3.2 Área piloto

A implementação não deverá começar cobrindo os 2.500 m².

O piloto deverá utilizar uma área de até aproximadamente **100 m²**, preferencialmente próxima de **10 m × 10 m**, completamente ou majoritariamente visível por uma câmera.

A expansão para a fábrica inteira será uma etapa posterior, condicionada aos resultados do piloto.

## 4. Hardware disponível

### 4.1 Beacons

* 10 beacons Bluetooth DX-CP27; um por pessoa; preso ao crachá; funcionamento como transmissor; identificador exclusivo por unidade.

Configuração inicial sugerida:

* protocolo iBeacon;
* apenas um pacote de advertising ativo;
* intervalo entre anúncios de aproximadamente 100 a 200 ms;
* potência de transmissão consistente entre as unidades;
* identificação única por Major/Minor ou equivalente;
* calibração individual básica de cada beacon.

### 4.2 Celulares Android

* De um a três celulares disponíveis. Para cálculo BLE 2D, utilizar os três simultaneamente.
* Cada celular deverá: permanecer fixo; possuir posição X/Y conhecida; permanecer conectado à energia; permanecer conectado ao Wi-Fi; executar scan BLE continuamente; ter otimização de bateria desativada; informar seu estado operacional ao servidor.

Um ou dois celulares poderão ser usados em testes ou modo degradado, mas não deverão ser considerados suficientes para determinar uma posição X/Y BLE confiável.

### 4.3 Câmera

A câmera deverá ser tratada como o sensor principal de posição.

Características desejáveis: instalação fixa; posição elevada; visão ampla da área piloto; resolução suficiente para detectar pessoas nas extremidades; taxa de quadros estável; baixa distorção; acesso ao stream de vídeo; boa iluminação; posição que não seja alterada após a calibração.

A câmera poderá ser: câmera IP; câmera USB; câmera industrial; câmera de segurança com acesso RTSP.

Uma única câmera poderá ser suficiente no piloto caso enxergue toda a área. Para a fábrica inteira, provavelmente serão necessárias várias câmeras.

## 5. Arquitetura recomendada

```text
Beacon DX-CP27 no crachá
           │
           │ advertising BLE
           ▼
3 celulares Android fixos
           │
           │ beacon_id, RSSI, timestamp, anchor_id
           ▼
Serviço de processamento BLE
           │
           │ posição/região aproximada
           │
           ├─────────────────────────────┐
           │                             │
           ▼                             ▼
Motor de fusão                    Stream da câmera
           ▲                             │
           │                             ▼
           │                     Detecção de pessoas
           │                             │
           │                             ▼
           └──────────────────── Rastreamento visual
                                         │
                                         ▼
                              Coordenada X/Y no piso
                                         │
                                         ▼
                          Pessoa identificada na planta
```

## 6. Responsabilidade de cada componente

### 6.1 Câmera

Detectar pessoas; criar trajetória visual por pessoa; calcular posição X/Y; estimar velocidade e direção; identificar se está parada; impedir saltos visuais; acompanhar enquanto visível; detectar entrada e saída da área.

A câmera não necessariamente saberá o nome ou ID real da pessoa. Ela produzirá IDs temporários (`track_visual_01`, `track_visual_02`, ...).

### 6.2 BLE

Detectar quais crachás estão presentes; informar intensidade do sinal por celular; ajudar a determinar a região aproximada de cada beacon; apoiar a associação beacon↔trajetória visual; auxiliar quando a câmera perder temporariamente a pessoa; confirmar se um crachá continua presente.

O BLE não deverá ser tratado como fonte principal de X/Y preciso quando a câmera estiver disponível.

### 6.3 Motor de fusão

Associar `track_visual_07 = beacon_03`, considerando: proximidade entre posição visual e posição BLE aproximada; direção do movimento; velocidade; momento de início/parada do movimento; histórico anterior da associação; entrada e saída por zonas; distância possível entre leituras; restrições físicas da planta; nível de confiança.

### 6.4 Frontend

Planta baixa em escala; coordenadas X/Y em metros; posição dos celulares; área visível por cada câmera; marcador de cada pessoa; identidade vinculada ao beacon; estado da pessoa; trajetória recente; nível de confiança; última atualização; áreas inválidas e obstáculos.

## 7. Como a câmera calcula o X/Y

### 7.1 Detecção de pessoas

Cada quadro processado por um detector de pessoas, retornando caixas delimitadoras (`x1, y1, x2, y2`, confiança).

### 7.2 Posição no piso

Usar preferencialmente o ponto central inferior da caixa (aproximadamente os pés): `x_pixel` = centro horizontal, `y_pixel` = limite inferior. O centro do tronco não deverá ser usado (erros de perspectiva).

### 7.3 Conversão de pixels para metros

Calibração por pontos conhecidos no chão (ex.: A=(0,0), B=(10,0), C=(10,10), D=(0,10)), relacionados aos pixels correspondentes. Transformação geométrica pixel→metros; para superfície aproximadamente plana, homografia.

### 7.4 Restrições

A homografia pressupõe: câmera fixa; piso aproximadamente plano; pontos de calibração medidos corretamente; lente sem distorção excessiva; região de interesse dentro da área calibrada. Se a câmera for movimentada, recalibrar.

## 8. Rastreamento visual

Manter identidade visual entre quadros considerando: posição anterior; velocidade; direção; aparência visual; sobreposição entre caixas; tempo transcorrido; possíveis oclusões.

Saída por track: `track_visual_id, x, y, velocidade, direção, estado, timestamp, confiança`.

A câmera deverá ser a fonte principal para garantir: continuidade; ausência de teletransporte; trajetória humana plausível; estabilidade quando parada.

## 9. Estratégias para descobrir "quem"

### 9.1 Estratégia A — Câmera e BLE sem alterações no crachá

Associação combinando: posição visual; posição BLE aproximada; proximidade do celular receptor; correlação do movimento; histórico; entrada controlada; manutenção da associação. Tecnicamente possível, mas é a parte mais complexa do projeto.

Condição ideal: zona de entrada com associação individual (pessoa entra → câmera cria trajetória → sistema detecta qual beacon apareceu/subiu forte → vincula → mantém).

Dificuldades: várias pessoas entrando juntas; lado a lado; várias paradas; sinais BLE semelhantes; câmera perdendo duas pessoas num cruzamento; crachá entregue a outra pessoa.

### 9.2 Estratégia B — Marcador visual no crachá (recomendada)

Adicionar marcador impresso (ArUco, AprilTag, QR Code ou número visual exclusivo) representando o mesmo identificador do beacon (marcador 03 = beacon 03 = pessoa 03).

Quando visível: a câmera identifica diretamente; associa marcador→tracker→beacon; mantém o vínculo depois que o marcador some.

Vantagens: baixo custo; sem biometria; reduz ambiguidades; permite entradas simultâneas; diminui o peso do RSSI; simplifica o motor de fusão.

Limitações: marcador coberto; crachá virado; resolução insuficiente; a câmera precisa enxergar o marcador em algum momento.

### 9.3 Estratégia C — Reconhecimento facial (não recomendada para a v1)

Rosto visível; capacetes/EPIs; pessoas de costas; baixa resolução; iluminação variável; maior processamento; falsos positivos; dados biométricos sensíveis; risco jurídico/privacidade.

## 10. Decisão recomendada

**Com o hardware estritamente disponível**: câmera fornece X/Y; BLE fornece identidade provável; associação inicial em zona controlada; associação mantida enquanto houver confiança.

**Para maior qualidade**: câmera fornece X/Y; marcador visual fornece identidade inicial; BLE confirma presença e auxilia em oclusões; tracker mantém identidade. A impressão de um marcador no crachá não exige alteração eletrônica e reduz significativamente o risco.

## 11. Processamento BLE

Leituras por celular: `anchor_id, beacon_id, rssi, timestamp`. Coordenadas do celular cadastradas no servidor: `anchor_id, anchor_x, anchor_y, altura, modelo_do_aparelho`.

### 11.1 Tratamento das leituras

Remoção de duplicatas; sincronização temporal; janela deslizante; mediana; média móvel ou EMA; detecção de perda de sinal; normalização por celular; calibração por beacon e receptor.

### 11.2 Uso recomendado do BLE

Produzir principalmente: presença; sinal por celular; receptor mais próximo; zona provável; posição aproximada; confiança; tendência de deslocamento. Trilateração como informação complementar, não única fonte de verdade.

### 11.3 Fingerprinting

Mapa de assinaturas RSSI em pontos conhecidos (`X, Y, RSSI A/B/C, orientação da pessoa`); na operação, comparar o vetor atual aos registrados. Mais indicado para a área piloto do que para toda a fábrica (esforço de calibração cresce com a área).

## 12. Motor de associação BLE e câmera

Para cada instante: trajetórias visuais V1..Vn × beacons B1..Bn → `score(Vi, Bj)` considerando: distância entre posição visual e posição BLE; correspondência de movimento; associação anterior; direção; tempo; presença na mesma zona; receptor predominante; possibilidade física; confiança do tracker; qualidade dos sinais.

Associação probabilística (ex.: `track_visual_07, beacon_03, confiança_identidade = 92%, confiança_posição = 97%`). Manter separadas a confiança de localização e a de identidade — o sistema pode saber exatamente onde existe uma pessoa e ainda estar incerto sobre quem ela é.

## 13. Continuidade do movimento

### 13.1 Com a câmera vendo a pessoa

Continuidade direto do tracker visual; nova posição compatível com posição anterior, intervalo, velocidade, direção, caminho permitido.

### 13.2 Limite de velocidade

Valor inicial: **2 m/s para caminhada** (configurável). Leitura implicando velocidade muito superior: rejeitar, baixar confiança, aguardar confirmação, ou tratar como nova associação.

### 13.3 Interpolação

Interpolação para suavização visual, mas não para esconder grandes erros. Movimento suave não significa posição correta. Distinguir: precisão; estabilidade; continuidade; latência.

## 14. Pessoa parada

Detectar por: baixa velocidade visual; pequenas variações de posição; estabilidade por vários quadros; duração mínima. Regra inicial: candidata a parada após ~1 s de baixa velocidade; confirmada após ~3–5 s de estabilidade.

Quando parada: reduzir sensibilidade a oscilações; janela temporal maior; consolidar posição; evitar movimentação do marcador; aumentar confiança progressivamente; rejeitar mudanças BLE isoladas. A posição não deve ser completamente congelada — deslocamento real é reconhecido após evidência suficiente.

## 15. Oclusões e perda da câmera

### 15.1 Oclusão curta

Manter última velocidade; prever trajetória por alguns segundos; considerar caminhos possíveis; consultar presença BLE; aumentar gradualmente a incerteza.

### 15.2 Oclusão longa

Após limite configurável: parar de apresentar coordenada precisa; exibir última posição conhecida; estado "localização incerta"; usar zona BLE provável; aguardar reaparecimento.

### 15.3 Reaparecimento

Considerar: aparência; local de reaparecimento; tempo ausente; trajetória prevista; sinal BLE; zonas possíveis; identidade anterior. Não associar apenas por proximidade instantânea.

## 16. Restrições da planta

Modelo navegável com: paredes; máquinas; corredores; portas; áreas bloqueadas; áreas permitidas; zonas operacionais. O sistema não deverá: posicionar pessoas dentro de máquinas/paredes; permitir travessia impossível; mover pessoa entre ambientes sem passar por abertura. Restrições eliminam hipóteses inválidas.

## 17. Estados de uma pessoa

```text
LOCALIZADA_PARADA
LOCALIZADA_EM_MOVIMENTO
PARCIALMENTE_OCULTA
LOCALIZACAO_INCERTA
SOMENTE_BLE
SEM_SINAL
FORA_DA_AREA
```

O frontend deverá comunicar esses estados visualmente.

## 18. Critérios de qualidade

### 18.1 Pessoa parada

Metas do piloto: erro mediano ≤ 2 m; p95 ≤ 4 m; oscilação reduzida após confirmação de parada; marcador estável na maior parte do tempo; sem trocas frequentes de identidade. Com câmera calibrada, expectativa melhor que só-BLE.

### 18.2 Pessoa em movimento

Atualização próxima do tempo real; latência ≤ 2 s; sem teletransporte; velocidade compatível com humano; trajetória respeitando a planta; recuperação após oclusões curtas.

### 18.3 Identidade

Avaliar separadamente: % de associações corretas; trocas indevidas; tempo para associação inicial; tempo de recuperação pós-oclusão; desempenho com pessoas próximas; desempenho com entradas simultâneas.

### 18.4 Operação

3 celulares simultâneos; 10 beacons detectados; teste contínuo ≥ 4 h; monitoramento de perda de celular; reconexão automática; identificação de câmera indisponível; modo degradado.

## 19. Fases de implementação

- **Fase 0 — Validação dos equipamentos**: leitura dos 10 beacons; intervalo de advertising; RSSI por celular; diferenças entre modelos; acesso ao stream; resolução/campo de visão. Saída: relatório dos sensores; limitações; definição da área piloto.
- **Fase 1 — Referencial da planta**: origem X/Y; medir área; cadastrar obstáculos; posição dos celulares; posição da câmera; pontos de calibração; calibrar pixels→metros. Saída: mapa 2D operacional; transformação validada; erro de projeção conhecido.
- **Fase 2 — Rastreamento visual**: detectar pessoas; manter tracks; posição no piso; velocidade; detectar parada; trajetória na planta. Saída: pessoas anônimas rastreadas em X/Y; movimento contínuo; estabilidade básica.
- **Fase 3 — Pipeline BLE**: leituras dos 3 celulares; filtrar RSSI; presença; zona; posição aproximada; saúde dos receptores. Saída: localização BLE independente; painel de qualidade.
- **Fase 4 — Associação inicial**: trajetória↔beacon; zona de entrada; manter vínculo; confiança; ambiguidades. Saída: pessoas identificadas no mapa.
- **Fase 5 — Fusão e recuperação**: combinar posição visual e BLE; recuperar identidade pós-oclusão; impedir trocas; restrições da planta; modo degradado. Saída: rastreamento híbrido completo.
- **Fase 6 — Estabilização**: eliminar saltos; ajustar filtros; estabilizar paradas; medir latência; configurar limites; reduzir falsos movimentos. Saída: comportamento adequado para demonstração.
- **Fase 7 — Testes com múltiplas pessoas**: parada; caminhando; duas se cruzando; lado a lado; várias entrando; oclusão por máquina; pessoa de costas; 10 beacons ativos; perda de um celular; perda da câmera; reaparecimento.
- **Fase 8 — Avaliação do piloto**: Aprovado para X/Y · Aprovado somente para áreas visíveis · Aprovado somente para zonas · Reprovado.

## 20. Estratégia de expansão

Aprovação em 100 m² não garante 2.500 m². Expansão depende de: quantidade de câmeras; pontos cegos; sobreposição; corredores; altura das máquinas; iluminação; processamento; Wi-Fi; pessoas simultâneas.

Multi-câmera exigirá: calibração individual; coordenadas globais compartilhadas; associação entre tracks de câmeras diferentes; zonas de sobreposição; transição de identidade; sincronização temporal. O BLE poderá ajudar na passagem entre câmeras e na recuperação de identidade.

## 21. Privacidade e LGPD

Finalidade documentada; controle de acesso; política de retenção; quem pode visualizar; registro de consultas; IDs pseudonimizados quando possível; proteção das trajetórias armazenadas; informação aos participantes do piloto; tratamento específico caso imagens sejam gravadas. Evitar reconhecimento facial reduz a complexidade.

## 22. Riscos principais

1. **Associação incorreta pessoa↔beacon** — zona de entrada; marcador visual; persistência; confiança; múltiplas evidências; não aceitar troca instantânea.
2. **Oclusões visuais** — instalação elevada; posicionamento; múltiplas câmeras; BLE como apoio; previsão de trajetória; restrições da planta.
3. **Campo de visão insuficiente** — teste antes do desenvolvimento; maior resolução; reposicionamento; reduzir área piloto; câmeras adicionais.
4. **RSSI inconsistente** — calibração; fingerprinting; filtros; fonte auxiliar apenas; aparelhos semelhantes; instalação fixa.
5. **Aparência de precisão falsa** — indicador de confiança; raio de incerteza; modo "somente zona"; última posição conhecida; distinção identidade × posição.
6. **Expectativa de cobertura integral** — precisão da câmera existe só onde há visão adequada; sucesso no piloto não é promessa automática para a fábrica.

## 23. Entrega recomendada do MVP

Mapa 2D calibrado em metros; uma câmera integrada; três celulares receptores; dez beacons cadastrados; detecção e rastreamento visual; associação tracker↔beacon; posição X/Y; estado parado/em movimento; trajetória contínua; bloqueio de saltos; restrições da planta; confiança de posição; confiança de identidade; última posição conhecida; modo degradado por BLE; histórico básico; painel de saúde dos sensores.

## 24. Direcionamento final

> **Visão computacional para localização, BLE para identidade e redundância, e um motor probabilístico para unir as duas fontes.**

A câmera deve ser a fonte de verdade do X/Y enquanto a pessoa estiver visível. O BLE deve atuar como: identificador; confirmação de presença; apoio à associação; recuperação após oclusões; localização aproximada fora da câmera.

Para reduzir a complexidade, recomenda-se adicionar um marcador visual impresso ao crachá — associação inicial pelo marcador, redundância e continuidade pelo BLE.

Começar por uma área piloto de até 100 m². Somente após medir precisão, estabilidade, identidade, oclusões e operação simultânea será possível dimensionar a expansão para os 2.500 m².
