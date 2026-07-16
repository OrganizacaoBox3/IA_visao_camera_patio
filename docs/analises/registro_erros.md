 Você está certo: encaixar a tag artificialmente na mesa seria incorreto. Retiro essa proposta anterior. O marcador deve continuar sendo uma
  estimativa independente; a mesa deve ser apenas uma referência para calcular proximidade.

  ## Causa comprovada das laterais

  O problema não está nas dimensões 3 × 5 m nem no desenho do triângulo. O fluxo atual praticamente força matematicamente os resultados para fora da
  planta:

  1. A tela recebe o último RSSI de cada celular.
  2. Converte cada RSSI em metros com um único modelo global não calibrado: rssi0=-45, n=2.2, em /C:/Users/crist/grendene_cd_inovacao/
     visao_computacional_mvp/src/fusion/floorplan.ts:68.

  3. Faz a multilateração com essas distâncias.
  4. A coordenada quase sempre fica centenas de metros fora da área.
  5. O código corta X e Y para os limites [0,3] × [0,5], em /C:/Users/crist/grendene_cd_inovacao/visao_computacional_mvp/src/fusion/floorplan.ts:264.
  6. A suavização é aplicada somente depois desse corte.

  Com as leituras reais observadas:

   Tag     Coordenada calculada antes do corte    Exibida
  ━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━
   CE3C                       (-1459,7; 112,0)     (0; 5)
  ──────  ─────────────────────────────────────  ─────────
   CE5C                       (-160,9; -763,8)     (0; 0)
  ──────  ─────────────────────────────────────  ─────────
   CE89                       (-267,7; -797,2)     (0; 0)
  ──────  ─────────────────────────────────────  ─────────
   CE8B                       (-198,7; -709,3)     (0; 0)

  Até a própria assinatura média capturada no centro produz:

  - Distâncias inferidas: 31,7 m, 36,2 m e 100 m.
  - Posição bruta: (51,7; -881,3).
  - Posição exibida após o corte: (3; 0).
  - Resíduo da solução: aproximadamente 829 m.

  Portanto, “sempre nas laterais” é um comportamento determinístico do algoritmo atual, não falta de sinal ocasional.

  A razão matemática é que a multilateração trabalha com diferenças de distâncias ao quadrado. Numa base de apenas 3 m, diferenças pequenas de RSSI
  viram diferenças enormes:

  - Perto de −80 dBm, o modelo atual estima cerca de 40 m.
  - Apenas 1 dB já altera a distância em aproximadamente 11%.
  - Isso gera uma diferença de quadrados cerca de 40 vezes maior do que o intervalo capaz de produzir uma coordenada interna.

  Além disso, todo RSSI menor ou igual a aproximadamente −89 dBm vira exatamente 100 m pelo teto de /C:/Users/crist/grendene_cd_inovacao/
  visao_computacional_mvp/src/fusion/floor-plot.ts:147, apagando ainda mais informação.

  ## A tela comunica uma confiança que não existe

  O selo fix="ok" significa somente “três celulares ouviram a tag”. Ele não verifica:

  - Se as distâncias cabem na planta.
  - Se a solução é fisicamente plausível.
  - Se o resíduo é aceitável.
  - Se as leituras foram feitasO 1.399 m. Mesmo assim o canvas desen sólido tratado como coordenada firme.

  A suavização EMA de 35% em [useFloorplanMap.ts](/C:/Users.

  Os testes atuais também não detectam isso: eles fabricam RSSI invertendo exatamente o mesmo modelo utilizado pelofloor_comput_mvp/src/fusion/
  f.ts:9). Isso prova que a álgebra funciona quando o mundo obede perfeitamente não o modelo representa.

  Já melhor — e ela não força a mesa

  O fingerprint já calcula Classification.pos por WKNN: uma média contínua ponderada entre os três pontos de calibração mais semelhantes, em /C:/
  Users/crist/grendene_cd_inovacao/visao_computacional_mvp/src/fusion/fingerprint.ts:151.

  Aplicando exatamente esse cálculo aos dados atuais:

   Tag     X,Y contínuo pelo WKNN    Distância ao centro da mesa
  ━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CE3C              (1,68; 2,82)                         0,37 m
  ──────  ────────────────────────  ─────────────────────────────
   CE5C              (1,56; 2,49)                         0,06 m
  ──────  ────────────────────────  ─────────────────────────────
   CE89              (1,52; 2,24)                         0,26 m
  ──────  ────────────────────────  ─────────────────────────────
   CE8B              (1,62; 2,45)                         0,13 m

  Essas coordenadas não foram encaixadas na mesa. Elas resultam da interpolação ponderada entre fingerprints. Porém, a página ignora
  Classification.pos: usa o fingerprint somente para o nome/estado da zona e continua desenhando a multilateração defeituosa.

  Esses centímetros também não podem ser apresentados como acurácia comprovada: a mesa foi usada no treinamento e ainda não temos pontos
  independentes de teste.

  ## Problemas que precisam ser corrigidos antes de confiar no WKNN

  A auditoria encontrou problemas adicionais no caminho das amostras:

  - As “84 leituras” não representam necessariamente 84 medições físicas distintas. A captura consulta snapshots repetidamente, enquanto o hub
    conserva a mesma leitura por até 15 segundos em /C:/Users/crist/grendene_cd_inovacao/visao_computacional_mvp/server/bt/bt-readings.js:24.

  - A captura descarta measuredAt, podendo contar várias vezes a mesma medição ou incluir sinal do local anterior.
  - Todas as tags são misturadas num único pool por estação em /C:/Users/crist/grendene_cd_inovacao/visao_computacional_mvp/src/planta/
    useFingerprints.ts:77.

  - A classificação pode combinar uma antena medida agora com outra medida há vários segundos.
  - O desvio-padrão salvo no fingerprint não participa da distância.
  - A histerese conta polls, não anúncios BLE distintos.
  - Com somente quatro pontos de calibração, não há cobertura suficiente para provar fidelidade no restante da área.

  ## Funcionamento correto a perseguir

  A arquitetura coerente com o objetivo é:

  1. best.label responde “qual ambiente parece mais provável”.
  2. Classification.pos responde “qual X,Y contínuo foi inferido”.
  3. A zona não modifica nem força o X,Y.
  4. A mesa deve ser uma geometria independente — idealmente retângulo/polígono, não apenas um ponto.
  5. A distância até a mesa deve ser a menor distância entre o X,Y estimado e essa geometria.
  6. O resultado deve trazer incerteza e preservar a última posição válida quando as evidências forem ruins.

  A multilateração pode continuar como fonte secundária, mas somente depois de:

  - Calibração de distância individual por celular.
  - Sincronização temporal das leituras.
  - Rejeição por resíduo.
  - Modelo de incerteza.
  - Validação em campo.

  A fonte primária mais promissora, considerando o código e os dados atuais, é o WKNN contínuo sobre um survey mais denso, com multilateração
  calibrada como fallback. Depois vem um filtro de movimento com velocidade humana máxima, estado parado, hold e halo de incerteza.

  Para dizer “a pessoa está trabalhando”, o BLE sozinho só oferece evidência de proximidade e permanência. Podemos estimar “a 0,8 m da mesa há 12
  minutos”; não comprovar atividade física sem outro sensor.

  ## Próximo gate antes da implementação

  - Marcar pontos internos conhecidos, incluindo centro, lados e distâncias diferentes da mesa.
  - Usar alguns pontos como calibração e outros exclusivamente como teste.
  - Repetir com todas as tags, orientações e em sessões diferentes.
  - Comparar multilateração atual, WKNN atual e WKNN com deduplicação/sincronização.
  - Medir erro mediano, p90, distância até a mesa, jitter parado, saltos impossíveis e percentual de resultados cortados nas bordas.

  Somente esse resultado deve decidir o algoritmo que vira padrão.

  ## Correção de caixa

  Corrigi apenas o falso alerta TC22 versus tc22, sem alterar o posicionamento. A comparação agora normaliza os dois identificadores em /C:/Users/
  crist/grendene_cd_inovacao/visao_computacional_mvp/src/planta/ZoneCalibration.tsx:47.

  Validação:

  - Teste focado: 7/7 passando.
  - TypeScript: tsc --noEmit passando.
  - IDs realmente diferentes continuam gerando o alerta.
## 2026-07-15 — reaproveitamento do editor de áreas na Planta BLE

- **Sintoma:** a primeira tentativa criou `WorkAreaEditor` com centro/largura/comprimento, duplicando
  a ferramenta poligonal já estabilizada na câmera.
- **Causa:** o seam existente ainda misturava motor gestual com `FrameSource/getContentRect`; a
  implementação local contornou o acoplamento em vez de extraí-lo.
- **Correção:** motor movido para `src/spatial/usePolygonEditor.ts`; câmera e planta ficaram com
  adaptadores finos para seus sistemas de coordenadas. O formulário duplicado e seus testes foram
  removidos.
- **Sensor:** os 41 testes do editor da câmera continuaram verdes; o E2E mobile criou e persistiu uma
  área no mapa.
- **Falhas durante o fechamento:** o teste legado do servidor precisou passar a esperar o polígono de
  quatro pontos e o `catch` do adaptador precisou preservar o tipo `SaveResult`. Ambos foram corrigidos
  antes da suíte completa.
- **Infraestrutura:** o Playwright concluiu o cenário em 5,8 s, mas o wrapper voltou a exceder o timeout
  no teardown; não havia processo ouvindo em 4100/5180 após a execução.
