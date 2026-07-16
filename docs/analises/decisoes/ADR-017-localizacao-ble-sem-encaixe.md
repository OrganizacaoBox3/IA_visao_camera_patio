# ADR-017 — Localização BLE contínua sem encaixe em zona

Data: 2026-07-15  
Status: aceita

## Contexto

A Planta BLE convertia RSSI em distâncias com um modelo global. Na planta 3 × 5 m, distâncias de
dezenas de metros produziam soluções externas; o clamp ao retângulo transformava o erro em pontos
aparentemente firmes nos cantos. O fingerprint reconhecia corretamente a zona e calculava uma
posição WKNN interna, mas a página usava apenas a multilateração para X,Y.

Zona provável, coordenada estimada e área física respondem perguntas diferentes. Usar a zona ou a
mesa para corrigir a coordenada criaria uma imagem visual convincente, porém circular.

## Decisão

- O fingerprint WKNN é a fonte primária de X,Y quando confiança e evidência temporal qualificam.
- A multilateração é fallback e diagnóstico; exige modelo por estação, solução interna e residual
  aceitável. Solução inválida retorna `pos=null` e preserva a posição bruta apenas no diagnóstico.
- É proibido publicar posição obtida exclusivamente por clamp ao limite da planta.
- Zona, track contínuo e geometria da área de trabalho permanecem contratos independentes.
- Reconhecimento de zona não encaixa nem desloca a tag para a área.
- Distância à área é derivada depois da posição e acompanha a faixa causada pela incerteza.
- Acurácia métrica só pode ser alegada após avaliação com pontos de teste independentes do survey.

## Consequências

### Positivas

- O colapso determinístico para bordas deixa de ser apresentado como localização.
- O mapa pode exibir posições internas contínuas sem falsificar que a tag está no centro da mesa.
- Cada mecanismo pode ser medido isoladamente, inclusive cobertura e rejeição.

### Custos e riscos

- Em baixa evidência, o sistema cala X,Y ou mantém brevemente um ponto incerto; haverá menos
  cobertura aparente.
- O halo atual é diagnóstico e precisa de ground truth para calibração estatística.
- BLE sustenta proximidade/permanência, não prova que uma pessoa esteja trabalhando.

## Evidência e rastreabilidade

Ver [spec](../planta-ble-localizacao-continua/spec.md),
[plano](../planta-ble-localizacao-continua/plan.md),
[tarefas](../planta-ble-localizacao-continua/tasks.md) e
[resultado](../planta-ble-localizacao-continua/resultado.md).
