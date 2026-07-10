# ADR-002 — LGPD: imagens efêmeras no cliente, persistir só metadados

## Contexto
O benchmark de interfaces (ultrassom, VMS, AI/CV) recomendou cine-loop, replay de
clipe e "event cards com thumbnail". Porém a doc do próprio projeto
(`docs/produto/pendencias.md`) define a postura LGPD: a central grava **só indicadores, sem
imagens**.

## Decisão
- **Cine-loop**: buffer de quadros é 100% em memória no navegador do operador,
  efêmero (FIFO + `.close()`), **nunca enviado/persistido no servidor**.
- **Export de clipe/snapshot**: sempre **download local** iniciado pelo operador,
  nunca automático, nunca para o servidor.
- **Eventos de alarme**: persistem **apenas metadados** (id, ts, câmera, zona, tipo,
  prioridade, estado) — sem imagem/frame.
- A ligação "vídeo↔relatório" foi implementada como **relatório↔eventos** (metadados/
  timeline), não como replay de vídeo armazenado.

## Consequências
- (+) Conformidade com a postura LGPD existente; sem novo risco de dado pessoal.
- (−) Não há replay de clipe a partir do histórico (só revisão ao vivo no cliente).
- Reabrir replay de vídeo armazenado é decisão de produto/jurídica separada — exigiria
  novo ADR.
