# Tarefas — localização contínua na Planta BLE

> Derivado de [spec.md](./spec.md) e [plan.md](./plan.md).  
> `[S]` = sequencial · `[P]` = paralelizável quando houver propriedade exclusiva de arquivo.

## 0. Rastreabilidade e sensores

- [x] **T001 [S]** Registrar problema, baseline matemático, requisitos, GWT, impacto, riscos e métricas
  nesta tríade `spec/plan/tasks`.
- [x] **T002 [S]** Criar `resultado.md` no fechamento, ligando baseline, falhas vermelhas observadas,
  implementação, re-medição, metas e riscos residuais.
- [x] **T003 [S]** Criar e observar vermelho no fixture do fingerprint central que hoje colapsa à borda.
- [x] **T004 [P]** Criar e observar vermelho nos cenários de leitura repetida, pré-captura e
  dessincronizada.
- [x] **T005 [P]** Criar e observar vermelho no cenário de geometria impossível limitada à borda.
- [x] **T006 [P]** Escrever os contratos de movimento, TTL e distância ponto→polígono antes dos módulos.

## 1. Identidade e tempo da evidência

- [x] **T010 [P]** Revalidar a normalização case-insensitive de estação e seu teste em
  `ZoneCalibration` (alteração já iniciada antes desta tríade).
- [x] **T011 [P]** Estender `BtReading` com instante medido e identidade necessária, mantendo contrato
  aditivo.
- [x] **T012 [S]** Deduplicar captura por estação+tag+instante antes de qualquer estatística.
- [x] **T013 [S]** Rejeitar da captura leituras medidas antes do início.
- [x] **T014 [S]** Substituir contagem de polls por `nDistinct` e expor a janela/evidência efetiva.
- [x] **T015 [S]** Agregar tags representativas sem perder a separação por identidade e sem uma tag
  dominar pelo número de snapshots.
- [x] **T016 [S]** Formar vetor ao vivo com idade máxima e dispersão temporal máxima.
- [x] **T017 [S]** Fazer a histerese avançar por nova medição distinta, não por poll repetido.

## 2. Fingerprinting contínuo

- [x] **T020 [P]** Aplicar piso de variância e o desvio salvo na distância do fingerprint.
- [x] **T021 [S]** Remover singularidade de peso e limitar a influência de vizinho quase idêntico.
- [x] **T022 [S]** Balancear evidência por rótulo antes da margem/confiança.
- [x] **T023 [S]** Separar `label` de `pos`; permitir zona sem coordenada.
- [x] **T024 [S]** Emitir posição contínua, incerteza, cobertura, distância e motivo quando recusada.
- [x] **T025 [S]** Cobrir posição interna, baixa cobertura, rótulos repetidos e confiança insuficiente em
  `fingerprint.test.ts`.

## 3. Multilateração honesta

- [x] **T030 [P]** Aceitar parâmetros RSSI→distância por estação com fallback compatível explícito.
- [x] **T031 [S]** Propagar posição bruta, residual e estações usadas.
- [x] **T032 [S]** Definir qualidade por residual/geometria, não apenas por número de estações.
- [x] **T033 [S]** Rejeitar candidato incompatível antes de qualquer limitação ao retângulo.
- [x] **T034 [S]** Garantir que nenhuma posição publicada tenha origem exclusiva em clamp à borda.
- [x] **T035 [S]** Cobrir o fingerprint central e os quatro vetores do baseline em teste de regressão.

## 4. Seleção, movimento e incerteza

- [x] **T040 [P]** Criar seletor puro de fonte com fingerprint primário e multilateração gateada.
- [x] **T041 [P]** Criar filtro temporal com limite de velocidade dependente de `Δt`.
- [x] **T042 [S]** Implementar estados `moving/stopped/uncertain` com suavização própria.
- [x] **T043 [S]** Implementar manutenção breve da última posição, incerteza crescente e expiração por
  TTL.
- [x] **T044 [S]** Ignorar candidatos fora de ordem temporal.
- [x] **T045 [S]** Testar teleporte, parada, perda breve, expiração e timestamp regressivo.

## 5. Áreas de trabalho e distância

- [x] **T050 [P]** Criar geometria pura de ponto-em-polígono e distância ponto→segmento/polígono.
- [x] **T051 [S]** Definir área de trabalho independente de zona e antena.
- [x] **T052 [S]** Persistir áreas por extensão aditiva do floorplan, com teste de contrato.
- [x] **T053 [S]** Calcular `0 m` dentro e menor distância à borda fora, sem alterar `x,y`.
- [x] **T054 [S]** Propagar a incerteza posicional junto da distância.
- [x] **T055 [S]** Cobrir área central, borda, fora, polígono inválido e planta redimensionada em teste.

## 6. Integração da Planta BLE

- [x] **T060 [S]** Integrar candidato selecionado e filtro de movimento via `useContinuousFloorplan`.
- [x] **T061 [S]** Remover da view a suposição de que `nStations ≥ 3` implica posição firme.
- [x] **T062 [S]** Preservar classificação de zona como informação separada do track.
- [x] **T063 [S]** Integrar áreas e distância sem encaixe forçado.
- [x] **T064 [S]** Garantir que ausência de posição válida não crie coordenada padrão/canto.
- [x] **T065 [S]** Testar a composição com fontes válidas, rejeitadas, mantidas e expiradas.

## 7. UI e progressive disclosure

- [x] **T070 [S]** Desenhar halo de incerteza em escala métrica.
- [x] **T071 [S]** Diferenciar ponto observado, mantido e incerto sem usar saturação decorativa.
- [x] **T072 [S]** Exibir fonte, idade e cobertura em diagnóstico sob demanda.
- [x] **T073 [S]** Exibir zona provável e distância à área em campos distintos.
- [x] **T074 [S]** Remover linguagem de certeza quando os gates não passam.
- [x] **T075 [S]** Preservar nomes acessíveis e atualizar testes da rota no mesmo diff.
- [x] **T076 [S]** Remover o editor retangular duplicado e extrair o motor poligonal maduro da
  câmera para um seam espacial compartilhado, preservando seus testes de paridade.
- [x] **T077 [S]** Evoluir áreas físicas para polígonos métricos, migrando retângulos legados para
  quatro vértices sem alterar a posição das tags.
- [x] **T078 [S]** Separar a configuração em `Planta | Áreas | Calibração BLE` e desenhar/editar
  áreas no próprio mapa por arraste ou pontos.
- [x] **T079 [S]** Retirar amostras de treino do mapa operacional e mover fonte, movimento e halo
  para o diagnóstico sob demanda.

## 8. Avaliação de acurácia

- [x] **T080 [S]** Definir protocolo físico com pontos de treino e teste independentes, incluindo centro,
  interior fora da mesa, bordas e trajeto.
- [x] **T081 [S]** Versionar somente fixture anonimizada/permitida; nunca editar gravação de campo original.
- [x] **T082 [P]** Calcular erro `p50/p90` por mecanismo e ponto.
- [x] **T083 [P]** Calcular jitter parado e saltos por velocidade/deslocamento.
- [x] **T084 [P]** Calcular cobertura, rejeição e clamp com `n` e Wilson 95%.
- [x] **T085 [S]** Comparar fingerprint, multilateração e seletor sem agregado mascarar mecanismo falho.
- [ ] **T086 [S]** Registrar curva precisão×cobertura e decidir os gates operacionais pela métrica-que-mata.

## 9. Gates e fechamento

- [x] **T090 [S]** Rodar testes focais de fingerprint, floorplan, movimento, áreas e Planta BLE.
- [x] **T091 [S]** Rodar `npm run typecheck` e corrigir somente regressões desta mudança.
- [x] **T092 [S]** Rodar `npm run build`.
- [x] **T093 [S]** Rodar `npm test` completo.
- [x] **T094 [S]** Rodar Playwright no fluxo real de `/planta-ble`.
- [x] **T095 [S]** Revisar o diff combinado e deduplicar helpers concorrentes.
- [x] **T096 [S]** Preencher `resultado.md` com comandos, saídas, re-medição e risco residual.

## Definition of Done

- [x] Os critérios AC01–AC11 têm sensor automatizado onde determinístico.
- [x] Zona, posição e área de trabalho são contratos separados.
- [x] Nenhum clamp à borda é apresentado como posição válida.
- [x] `nEff ≤ nDistinct` é assert verificável.
- [x] O fluxo real da rota funciona e os gates do projeto estão verdes.
- [x] A avaliação ground truth informa o que foi e o que não foi comprovado.
- [x] O risco residual do canal BLE e a natureza inferencial da distância estão visíveis e documentados.
