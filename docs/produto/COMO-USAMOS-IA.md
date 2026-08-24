# Como a IA foi usada neste projeto

> Registro descritivo, não normativo. Descreve o que foi feito, com que ferramenta, e como cada
> coisa foi verificada. Projeto `visao_computacional_mvp` — visão computacional industrial.
> Estado em 19/08/2026.

---

## 1. Números do repositório

| Item | Quantidade |
|---|---|
| Commits | 542 |
| Testes automatizados | 1.598 (136 arquivos) |
| Sensores de acurácia de modelo | 17 scripts |
| Registros de decisão arquitetural (ADR) | 16 |
| Documentos técnicos | 171 |
| Automações de CI/CD | 5 workflows |
| Invariantes declaradas (não violáveis) | 9 |

---

## 2. Onde a IA entrou

| Frente | O que a IA produziu | Artefato verificável |
|---|---|---|
| **Código de aplicação** | Front-end React/TypeScript e servidor Node.js: motor de análise de vídeo, contagem por zona, política de alarme, autenticação, RBAC, relatórios | `src/`, `server/` |
| **Testes** | Testes unitários e de contrato, incluindo testes que travam invariantes de privacidade | 136 arquivos `*.test.*` |
| **Sensores de ML** | Bancada que mede acurácia de reconhecimento contra imagens com anotação de referência | `eval/` |
| **Planejamento** | Especificações com critério de aceite, planos por ondas, inventários de pendência | `docs/analises/` |
| **Arquitetura** | Redação dos ADRs (Contexto → Decisão → Consequências) | `docs/analises/decisoes/` |
| **Infra / DevOps** | CI, deploy de homologação, diagnóstico remoto, `systemd`, `nginx`, ingestão de vídeo | `.github/workflows/`, `deploy/` |
| **Operação** | Ferramentas de diagnóstico de servidor e de fonte de vídeo | `scripts/` |
| **Pesquisa** | Comparação medida entre motores de reconhecimento (custo/quadro, recall, falso positivo) | `docs/analises/comparativo-*` |
| **Documentação** | Manuais de operação, runbooks de deploy, este documento | `docs/produto/` |

---

## 3. Divisão de decisão

| Decisão | Quem decidiu | Como fica registrado |
|---|---|---|
| Escopo, prioridade, direção do produto | Pessoa | Commit + doc de plano |
| Trade-off arquitetural | Pessoa, assessorada por medição | ADR com data e autoria |
| Implementação (como codar) | IA | Diff revisado |
| Aprovar o que entra | Pessoa | Revisão de diff |
| Publicar em produção | Pessoa (acionamento manual) | Log do workflow |
| Reverter em falha | Pessoa | Instrução impressa, execução manual |

Regra registrada no guia do projeto: *"recomendação automatizada é hipótese, não ordem — re-verifique contra o runtime antes de executar."*

---

## 4. Verificação antes de cada entrega

| Camada | O que checa | Onde roda |
|---|---|---|
| `verify` | Análise estática, tipos, build, testes, auditoria de dependências | Máquina local (pre-push) |
| CI | O mesmo `verify` + testes de interface + sensores de acurácia | Servidor de integração |
| Sensores `eval/` | Se o **reconhecimento** piorou | CI |
| Auditoria de pacote | Se segredo ou dado de operação entrou no que vai subir | Dentro do deploy |

Pontos observados na prática:

- Vermelho não entra. O portão roda em duas camadas independentes.
- Mudança que melhora o código e piora o reconhecimento é barrada por número, não por opinião.
- Exceção de vulnerabilidade sem correção disponível recebe **prazo de validade**. Vencida, o portão volta a reprovar.
- Enviar código ao repositório não publica nada. Deploy exige acionamento manual.
- Em falha de deploy, a versão anterior fica preservada e as instruções de reversão são impressas. A máquina não desfaz sozinha.
- As automações que tocam o servidor têm escopo restrito: não removem diretório fora da própria área, não reiniciam serviço de terceiro, não apagam estado de operação.
- Ferramentas de diagnóstico redigem usuário e senha antes de imprimir endereço. Verificado por teste.

---

## 5. Dado sensível

| Classe | Exemplos | Destino |
|---|---|---|
| Interno | Código não sensível | Ferramenta em tier comercial, sem treino |
| Confidencial | Lógica de negócio proprietária | Tier comercial, sem treino |
| **Restrito** | **Segredos, credenciais, `.env`, PII/LGPD, dado de cliente** | **Não vai para IA** |

- Tier gratuito de ferramenta de IA treina com o código enviado. Para código não público, o projeto usa tier comercial com compromisso contratual de não-treino.
- Há levantamento formal por ferramenta, com veredito. Uma delas está vetada para código proprietário (jurisdição e telemetria).
- Arquivos de credencial ficam fora do diretório de trabalho do assistente e fora do versionamento.
- Segredos de publicação vivem no cofre da plataforma de CI, escopados ao ambiente, com a chave do servidor fixada.

---

## 6. Privacidade no produto

- Nenhum quadro de imagem é persistido — nem no relé, nem no motor de análise.
- Só indicadores e metadados são gravados.
- Pessoas não são identificadas: rótulo genérico, identificador efêmero que desaparece ao sair de cena.
- Teste automatizado quebra a entrega se um número voltar a aparecer sobre a imagem de uma pessoa.

---

## 7. Decisões que permaneceram com a pessoa

Abertas hoje, por natureza (produto, ética, orçamento) — não por limite técnico:

| # | Decisão | Tensão |
|---|---|---|
| 1 | Reconhecer conduta individual (EPI) | Colide com a promessa de não identificação que 6 documentos fazem |
| 2 | Gravar evidência visual de violação | Exigiria revogar a regra de não persistir imagem |
| 3 | Autorizar custo de anotação manual | Gasto só para *descobrir* se a acurácia serve |
| 4 | Número sobre a imagem | Duas telas violam a regra escrita; ou a regra muda, ou elas mudam |
| 5 | Tile vermelho em zona silenciada | "Imagem é soberana" × fadiga de alarme |
| 6 | Contagem de caixas: ocupação ou fluxo | "Quantas passaram" pode ser fisicamente irresolvível na cadência atual |

---

## 8. Erros da IA e como apareceram

Sete casos reais. Todos detectados antes de causar dano.

| # | O que a IA fez | Como foi pego | Resultado |
|---|---|---|---|
| 1 | Propôs aumentar resolução de análise citando ganho herdado de outro contexto | Medição no conjunto de avaliação | Ganho real 2,1 pp, custo +91% CPU, falso positivo em cena vazia de 0 → 4. **Revertido** |
| 2 | Avaliou trocar por modelo mais leve | Critério de aceite escrito **antes** de medir | Reprovou em 2 de 3 critérios. **Descartado** |
| 3 | Escreveu procedimento manual de deploy | Pergunta humana: *"não tem CI/CD no git?"* | Já existia deploy automatizado, mais seguro. **Documento reescrito** |
| 4 | Criou perfil de demonstração que desliga proteções de alarme | Pergunta humana sobre o pacote de publicação | O arquivo iria para produção. **Travado em duas camadas** |
| 5 | Afirmou que o sistema "não media" a idade do quadro de vídeo | A própria implementação | A medição já existia em trânsito. **Afirmação corrigida no documento** |
| 6 | Esteve a um passo de anunciar "causa raiz encontrada" para falhas no servidor | Medição | Falhas cessaram por reinício; nada na entrega tocava aquele caminho. **Publicado como "causa não estabelecida"** |
| 7 | Paralelizou 4 frentes com agentes automatizados | Supervisão humana | As 4 falharam por infraestrutura. Estado do repositório conferido (sem escrita parcial). **Refeito em sequência** |

Padrão observado nos 7 casos:

- 3 foram pegos por **medição**.
- 2 foram pegos por **pergunta humana**.
- 1 pela **própria implementação** contradizendo a afirmação anterior.
- 1 por **supervisão** de execução.

---

## 9. Rastreabilidade

- Cada commit declara a intenção e o motivo.
- Participação de IA marcada no histórico (`Co-Authored-By`) — autoria auditável depois.
- Todo fechamento declara o **residual**: o que não ficou coberto.
- Medição e inferência aparecem separadas nos documentos. Número medido e número estimado não são apresentados como equivalentes.
- Proporções saem com tamanho de amostra e intervalo de confiança. Não se publica o ponto isolado.

---

## 10. Limites do que se sabe hoje

| Item | Estado |
|---|---|
| Latência percebida | **Não medida** em campo. Exige cronômetro em cena real |
| Acurácia em cena de multidão | **Não validada**. Toda medição vem de cenas com poucas pessoas |
| Segurança do ambiente de homologação | 2 pendências abertas (rotação de senha de banco e de segredo de autenticação) |
| Limites de alerta em uso | Parte são valores **escolhidos**, não calibrados com dado de campo. Marcados como tal no código |
