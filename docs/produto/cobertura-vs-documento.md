# Cobertura da POC × documento da proposta (revisão linha a linha)

> Revisão em **2026-06-09**: releitura minuciosa do `document_pdf.pdf` confrontada com o que a POC entrega hoje.
> Objetivo: caçar necessidades **explícitas** ou **subliminares** de interesse do cliente que tenham passado.
> Legenda: ✅ coberto · ◐ parcial · ✗ não coberto · ⏸ adiado a pedido do usuário.

---

## 1. Mapa de necessidades × status

| # | Necessidade no documento (pág.) | Status | Observação |
|---|---|---|---|
| 1 | Identificar áreas paradas / sem movimento, em tempo real (1,2,4) | ✅ | Estado por zona + alerta de tempo parado real |
| 2 | Ocupação por área (vazia/ocupada) (4,5) | ✅ | coco-ssd (person/truck/car…) por zona |
| 3 | **"…ou com BAIXA MOVIMENTAÇÃO / gargalo"** (1,2,3,4) | ✗ | Só temos ATIVA/OCIOSA/VAZIA/ALERTA. **Falta o estado intermediário "LENTA/gargalo"** (movimento presente, porém abaixo do normal) — citado explicitamente em "detecção de ocupação" e em "gargalo" |
| 4 | Contagem/movimentação por área (1) | ✅ | Movimento (diff) + contagem de pessoas anônima |
| 5 | Regra de tempo parado (4,5) | ✅ | Idle timer + limite |
| 6 | **Limite definido PELA LIDERANÇA, por área (4,5)** | ◐ | Hoje o limite vem do `config.ts` (global demo/prod). **Falta editar o limite por zona na própria interface** ("a liderança define limites") |
| 7 | Painel com status por área (2,3,4,5) | ✅ | Grade de câmeras + cards por zona |
| 8 | **Histórico por turno (4)** | ✗ | Sem conceito de turno e sem persistência |
| 9 | **Relatório operacional: resumo DIÁRIO e SEMANAL, áreas mais paradas, HORÁRIOS CRÍTICOS, oportunidades (4,5,6)** | ✗ | Só há resumo **ao vivo da sessão**. Falta persistência, agregação por dia/semana/turno, "horários críticos" e ranking de ociosidade. **É o maior buraco** — e é o material do *case*/ROI |
| 10 | "Áreas com maior ociosidade" (ranking) (6) | ◐ | Mostramos a "pior agora", não um ranking acumulado |
| 11 | Alerta no **WhatsApp** / canal externo (1,2,4,5,6) | ⏸ | Adiado por você ("sem notificação por enquanto"). Banner estilo WhatsApp existe, sem envio real |
| 12 | Formato do alerta ("…sem movimentação há X. Verificar fluxo.") (4) | ✅ | Replicado literalmente |
| 13 | **Usar câmera IP existente** / instalar simples (5,6) | ◐ | Hoje só **webcam do navegador** via `/camera`. **Falta ingestão de câmera IP (RTSP)** — e a tese central é "a fábrica JÁ tem câmeras". Para demo, vídeo/webcam serve; para piloto real, é necessário |
| 14 | Processamento edge/local/nuvem (5,6) | ◐ | Escolhemos **central no navegador** (POC). Latência/local de processamento é pergunta aberta da viabilidade |
| 15 | Histórico de alertas no dashboard (5) | ◐ | Timeline da sessão (não persistida) |
| 16 | **Leitura operacional por área, TURNO, FLUXO e ATIVIDADE (2)** | ◐ | Só **área**. Faltam as dimensões **turno**, **fluxo** (tendência de movimento) e **atividade** |
| 17 | Reduzir falso positivo (sombra, iluminação, **empilhadeiras**, chuva, poeira) (6) | ◐ | Mitigado por suavização+confirmação+ocupação. **Risco real:** empilhadeira parada numa área (sem classe própria) pode gerar falso "parada"; não validado em condições industriais |
| 18 | Privacy by design / sem reconhecimento facial / armazenar só indicadores (7) | ✅/◐ | Sem rosto, local, IDs efêmeros ✅. "Armazenar só indicadores" se aplica quando houver histórico (ainda não há) |
| 19 | **Acesso restrito ao painel (7)** | ✗ | Mitigação LGPD explícita. Removemos auth. ≠ multi-tenant: um login simples protegeria o painel |
| 20 | Evitar excesso de alertas / regras por área (7) | ◐ | Há cooldown; **faltam regras configuráveis por área** na UI |
| 21 | Setup: mapeamento de áreas (8) | ✅ | Editor de zonas (desenhar/nomear) |
| 22 | Indicadores p/ ROI do piloto; comparar antes/depois (5,6,11) | ✗ | Sem export/relatório nem comparativo antes/depois |
| 23 | Multi-câmera / por unidade (8) | ✅ | Central de câmeras (hub socket) — **fizemos além do MVP mínimo** |
| 24 | Evolução: heatmap, comparativo por turno, gargalos, ERP/MES (6) | ✗ (ok) | Declarado como evolução pós-MVP |

---

## 2. O que deixamos passar (prioritizado por interesse do cliente)

**🔴 Alto — central para o pitch/case e citado repetidamente:**
1. **Histórico + relatório (por turno, dia, semana) + horários críticos + ranking de ociosidade + export.** O documento martela isso em 4 páginas (3, 5, 6, 8) e diz que "o valor está nos indicadores, alertas e HISTÓRICO". Hoje só temos sessão ao vivo. **Sem isso não há ROI/comparativo antes-depois** — que é o entregável do piloto. *(É o maior gap.)*
2. **Estado "baixa movimentação / gargalo"** (intermediário entre ativa e parada). Listado explicitamente na "detecção de ocupação" e na dor ("gargalo"). Hoje binarizamos. Detectar *lentidão* (movimento abaixo do normal) é o que pega **gargalo**, não só parada total.

**🟠 Médio — necessidade explícita, viабilidade/produto:**
3. **Limite/regras configuráveis pela liderança, por área, na própria UI** (hoje é arquivo de config).
4. **Ingestão de câmera IP (RTSP)** — a tese é "usar as câmeras que a fábrica já tem". Para demo, webcam/vídeo basta; para piloto, é requisito.
5. **Acesso restrito ao painel (login)** — mitigação LGPD explícita (≠ multi-tenant que você adiou).
6. **Dimensões turno / fluxo / atividade** além de área (leitura operacional multi-dimensão).

**🟡 Menor / conhecido:**
7. **WhatsApp / canal de alerta** — explícito, mas **adiado por você**; manter no radar (o banner já imita o formato).
8. **Robustez a falso positivo industrial validada** (empilhadeira parada, sombra, chuva, poeira) — temos mitigação, falta validar/documentar e tratar "equipamento parado conta como atividade?".
9. **Persistir apenas indicadores (não imagens)** — princípio a respeitar quando houver histórico.

---

## 3. Recomendação

Se o objetivo é uma **demonstração técnica exemplar de resultados** (o que vira *case*), o item **#1 (histórico + relatório com horários críticos e áreas mais paradas, exportável)** é o de maior retorno — é exatamente o "resultado mensurável" que o documento pede e que transforma a POC em material de validação/ROI. Em seguida, **#2 (estado de baixa movimentação/gargalo)** aproxima a leitura do que a liderança realmente quer ("onde está o gargalo"), e **#3 (limites por área na UI)** entrega o "a liderança define limites".

Os itens **#4 (RTSP)** e **#5 (acesso restrito)** são mais de **piloto real** que de demo, mas valem ser citados na narrativa de viabilidade (são perguntas que o próprio documento levanta para a Box3).

---

## 4. Além do pedido (já entregue a mais)
Central multi-câmera (hub socket), **contagem de pessoas + permanência anônima** e **"pausar para inspecionar"** — não estavam no MVP mínimo do documento e reforçam a narrativa (sem ferir o "sem identificação individual").
