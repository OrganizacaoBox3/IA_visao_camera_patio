# Síntese — Benchmark de Interfaces e Recomendações de Design

Consolida os 5 benchmarks (NASA/mission control, VMS/video-analytics, ultrassom/imagem
médica, SCADA/HMI/Andon, percepção AI/CV moderna) em recomendações priorizadas para o
nosso sistema de visão computacional do CD. **Princípio:** padrões que aparecem em
múltiplos domínios independentes são as apostas mais seguras.

Fontes: `01-nasa-mission-control.md`, `02-vms-video-analytics.md`,
`03-ultrassom-imagem-medica.md`, `04-industrial-scada-hmi-andon.md`,
`05-percepcao-ai-cv-moderna.md`.

## Padrões convergentes (citados por ≥2 domínios = prioridade alta)

| Padrão | Domínios que recomendam | Aplicação no nosso sistema |
|--------|--------------------------|----------------------------|
| **Disciplina de cor / "going gray"** — base cinza neutra, cor só para anormalidade | NASA, Indústria | Estados de zona (ATIVA=neutro, LENTA/OCIOSA=amarelo, ALERTA=vermelho); central deixa de ser "árvore de natal" |
| **Gestão de alarme: dedup + supressão de inundação + acknowledge + priorização** | NASA, VMS, Indústria | Andon/WhatsApp — antídoto ao alerta falso em massa; 3 níveis; feed caiu = 1 alerta de causa-raiz |
| **Hierarquia overview→foco→evento, mural sempre visível** | NASA, VMS | Central (grade glanceable) → câmera em foco com painel lateral → evento/clip |
| **Imagem soberana: geometria sobre o vídeo, números no painel lateral; dark theme** | Ultrassom, CV | Tela de câmera ao vivo e overlays; ergonomia de jornada longa |
| **Modo = preset completo** (thresholds+zonas+overlays+métricas de uma vez) | Ultrassom, (VMS views) | Trocar entre atividade/fadiga/leitura/objetos recarrega tudo |
| **Congelar + cine-loop / replay de evento / vídeo↔relatório bidirecional** | Ultrassom, VMS, CV | Revisão e auditoria de eventos — separa MVP de produto maduro |
| **Camadas com toggles + slider global de confiança** | CV, (Ultrassom) | Ligar/desligar boxes, máscara, heatmap, zonas; filtrar por confiança ao vivo |
| **Config de regra com preview de impacto antes de ativar** | VMS (Verkada), Indústria (Cognex) | Slider de sensibilidade mostrando "alertas/dia estimados" pelo histórico |
| **Alerta auto-contido e acionável** (snapshot+zona+hora) numa fila | VMS, Indústria | Cada alerta WhatsApp/Andon já chega com contexto + ack |
| **RBAC: Setup vs Live, operador vs engenheiro** | Indústria, VMS | Edição de thresholds fora da tela operacional |
| **Views salvas por setor + auto-surface das câmeras mais ativas** | VMS | Escala para dezenas de câmeras sem vigilância passiva |

## Roadmap priorizado (impacto × esforço)

### Onda A — Quick wins de alto impacto (baixo/médio esforço)
1. **"Going gray" nos estados de zona** — revisar paleta da central e dos cards de zona: cinza por padrão, amarelo/vermelho só para anormalidade, significado consistente. *(UI/CSS; baixo)*
2. **Dedup + supressão de inundação de alertas** — agrupar detecções por frame/zona/janela; "feed caiu → 1 alerta", não N "VAZIA". Liga direto no `server/dispatch.js`/`alerts.js`. *(backend; médio)* — complementa o demo-10s já desligado.
3. **Slider de sensibilidade com "alertas/dia estimados"** — usar o histórico (`report/store`) para prever volume antes de ativar regra. *(front+dados; médio)*
4. **Slider global de confiança + toggles de camadas** (boxes / máscara / zonas / heatmap) na tela de câmera. *(front; médio)*
5. **Dark theme na tela de câmera ao vivo** + mover números para painel lateral, deixando só geometria sobre o vídeo. *(UI; médio)*

### Onda B — Diferenciais de produto maduro (médio/alto)
6. **Congelar + cine-loop** — buffer dos últimos N segundos; freeze abre scrubber de quadros para revisar/medir/salvar o momento do evento. *(front; alto)*
7. **Fila de alarmes acionável com acknowledge** — painel de eventos com snapshot+zona+hora, estados (novo/reconhecido/encaminhado), ligado ao WhatsApp. *(front+backend; alto)*
8. **Vídeo↔relatório bidirecional** — clicar num pico do relatório pula pro clipe/frame; event cards com thumbnail recortado. *(front; alto)*
9. **Modo como preset completo** — formalizar troca de modo recarregando thresholds/zonas/overlays/métricas. *(refactor front; médio)*
10. **Overview→foco→evento** com mural sempre visível e telemetria lateral (valor + sparkline + faixa-alvo, nunca número cru). *(front; médio)*

### Onda C — Escala e governança
11. **Views salvas por setor + auto-surface** das câmeras mais ativas. *(front+backend; alto)*
12. **RBAC Setup×Live** — edição de thresholds restrita a perfil engenheiro, fora da tela operacional. *(front+backend; médio)* — já há papéis (superadmin) para apoiar.
13. **Tripwires/linhas de contagem com direção (entrada/saída)** nas docas + **heatmap de ocupação/dwell** sobre a planta. *(front+algoritmo; alto)*
14. **Filosofia de alarme formal (ISA-18.2/EEMUA 191)** — metas de taxa, ≤5% crítico, shelving com expiração, racionalização. *(processo+backend; médio)*

## Princípios de design transversais (north star)
- **Cor é informação, não decoração** — going gray; reserve saturação para o que exige ação.
- **A imagem é soberana** — UI nas bordas; sobre o vídeo só geometria; números num painel.
- **Nunca número cru** — sempre valor + tendência (sparkline) + faixa-alvo.
- **Alarme bom é alarme acionável** — se não exige ação, não é alarme; dedup e suprima inundação.
- **Glanceable primeiro** — overview legível à distância; detalhe sob demanda.
- **Setup ≠ operação** — configurar regras é tarefa de engenheiro, separada da tela do operador.

## Próximo passo sugerido
Transformar a **Onda A** em frentes de implementação (mesmo modelo de ondas/propriedade de
arquivo do `plano-desenvolvimento.md`). As maiores alavancas de "parecer produto maduro" com
menor esforço são **#1 (going gray)** e **#2 (dedup de alarme)**.
