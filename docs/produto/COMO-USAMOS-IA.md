# Como usamos IA neste projeto

> Documento de transparência para quem patrocina, audita ou avalia o trabalho.
> Descreve **onde** a IA entra, **o que ela não decide**, e **quais mecanismos** impedem que uma
> sugestão automatizada chegue a produção sem passar por verificação e por uma pessoa.
>
> Projeto: `visao_computacional_mvp` — inteligência operacional por câmeras (visão computacional
> industrial). Atualizado em 19/08/2026.

---

## 1. O arranjo de trabalho

O projeto usa assistentes de IA de programação como **instrumento de execução**. A cadeia é sempre
a mesma, e a ordem importa:

```
   pessoa define o problema  →  IA propõe e executa  →  MÁQUINA verifica  →  pessoa decide
        (arquitetura)              (produção)            (gate/sensores)      (o que entra)
```

O que isso significa na prática, por papel:

| Camada | Quem produz | Quem verifica | Quem decide |
|---|---|---|---|
| Direção do produto, escopo, prioridade | pessoa | — | pessoa |
| Arquitetura e trade-offs | pessoa (assessorada) | medição | pessoa |
| Código, testes, scripts, documentação | IA | gate automatizado + revisão | pessoa |
| Infra, CI/CD, automações | IA | gate + execução em ambiente real | pessoa |
| Medição e diagnóstico | IA | o próprio número | pessoa |
| Ação irreversível (publicar, deployar, apagar) | — | gate obrigatório | **só pessoa** |

Há uma regra escrita que governa tudo isso, e ela vale mesmo quando a sugestão automatizada
parece boa: **"recomendação automatizada é hipótese, não ordem — re-verifique contra o runtime
antes de executar."**

---

## 2. Onde a IA foi usada — inventário

### 2.1 Código de aplicação
Implementação de features, correções e refatorações no front-end (React/TypeScript) e no servidor
(Node.js): motor de análise de vídeo, contagem por zona, política de alarme, autenticação e
controle de acesso por papel, relatórios, integrações.

### 2.2 Testes e sensores de qualidade
**136 arquivos de teste, 1.598 testes** na última execução. Além dos testes tradicionais, o
projeto tem **17 scripts de avaliação** (`eval/`) que medem a *acurácia do modelo de visão* contra
um conjunto de imagens com anotação de referência — eles reprovam a entrega se o reconhecimento
piorar, algo que teste de software comum não detecta.

### 2.3 Planejamento e especificação
Especificações com critérios de aceite, planos por ondas, inventários de pendência e checklists de
campo. **171 documentos** em `docs/`.

### 2.4 Decisões de arquitetura
**16 ADRs** (*Architecture Decision Records*) — cada um no formato Contexto → Decisão →
Consequências. O registro é produzido pela IA; a decisão é da pessoa, e o documento diz
explicitamente quando é o caso ("decisão do dono", com data).

### 2.5 Infraestrutura e DevOps
- **5 workflows** de automação: integração contínua, deploy de homologação, diagnóstico
  read-only do servidor e automações do plano de controle.
- Configuração de serviço (`systemd`), servidor web (`nginx`), ingestão de vídeo, sidecar de
  streaming.
- Runbooks de deploy passo a passo, com pré-voo, validação e rollback.

### 2.6 Operação e diagnóstico
Ferramentas de diagnóstico que a IA construiu e que hoje respondem perguntas que antes exigiam
acesso manual ao servidor — por exemplo: *"qual versão está rodando lá?"* e *"o vídeo da câmera
está chegando em dia, ou está atrasando?"*.

### 2.7 Pesquisa e medição comparativa
Comparação de motores de reconhecimento com números próprios (custo por quadro, taxa de acerto,
falsos positivos), em vez de adotar a recomendação de fornecedor.

### 2.8 Documentação
Manuais de operação, guias de instalação de câmera, este documento.

---

## 3. Os freios — mecanismos, não intenções

Cada item abaixo é código ou configuração em vigor, não política aspiracional.

**O portão de qualidade.** Antes de qualquer entrega roda `verify`: análise estática, checagem de
tipos, build, testes e auditoria de segurança de dependências. **Vermelho não entra.** O portão
roda em duas camadas independentes: na máquina de quem desenvolve (antes de publicar) e no
servidor de integração.

**Sensores de acurácia no portão.** Mudança que melhore o código mas piore o reconhecimento é
barrada por medição, não por opinião.

**Nove invariantes escritas** que nenhuma mudança pode violar — entre elas: nenhuma imagem é
gravada no servidor (só indicadores); segredos nunca são versionados; contratos entre módulos são
aditivos, nunca quebrados.

**Auditoria de segurança com prazo de validade.** Quando uma vulnerabilidade de biblioteca não tem
correção disponível, a exceção é registrada **com data de vencimento curta**. Vencida, o portão
volta a reprovar e força reavaliação — o que impede que um risco aceito temporariamente se torne
permanente por esquecimento.

**Trava no pacote de publicação.** O empacotamento verifica o conteúdo real do que vai subir e
**aborta** se encontrar segredo, dado de operação ou arquivo que não deveria ir a produção.

**Publicação nunca é automática.** Enviar código ao repositório **não** publica nada. O deploy
exige acionamento manual por uma pessoa, e o portão de qualidade roda *dentro* do deploy: se
reprovar, o servidor não é tocado.

**Reversão nunca é automática.** Em falha, o sistema preserva a versão anterior e **imprime as
instruções** de reversão para uma pessoa executar — a máquina não decide desfazer sozinha.

**Menor raio de explosão.** As automações que tocam o servidor têm escopo restrito por contrato:
não removem diretórios fora da própria área de trabalho, não reiniciam serviços de terceiros, não
apagam estado de operação.

**Credencial nunca aparece em log.** As ferramentas de diagnóstico redigem usuário e senha antes de
imprimir qualquer endereço — verificado por teste.

---

## 4. Segurança da informação e dados

### 4.1 O que pode e o que não pode ir para uma IA
A casa opera com classificação de dados. A fronteira é rígida:

| Classe | Exemplos | Regra |
|---|---|---|
| Interno | código não sensível | só ferramenta em **tier comercial, sem treino** |
| Confidencial | lógica de negócio proprietária | tier comercial + sem treino |
| **Restrito / Regulado** | **segredos, credenciais, `.env`, dados pessoais (LGPD), dado de cliente** | **nunca vai para IA. Proibido.** |

### 4.2 Tier contratual, não tier gratuito
Ferramentas de IA em tier consumidor/gratuito **treinam com o código enviado** por padrão. Para
código não público, o projeto exige **tier comercial com compromisso contratual de não-treino**.
Há levantamento formal das ferramentas usadas pela equipe, com veredito por ferramenta — inclusive
uma **vetada** para código proprietário, por jurisdição e telemetria.

### 4.3 Segredos fora do alcance do agente
Arquivos de credencial não ficam no diretório de trabalho do assistente, e não são versionados.
Os segredos de publicação vivem no cofre da plataforma de CI, escopados ao ambiente, com a chave
do servidor fixada (sem aceitar host desconhecido).

### 4.4 Privacidade do produto (LGPD desde o desenho)
O produto processa vídeo, e isso foi desenhado com restrição na origem: **nenhum quadro de imagem
é persistido** — nem no relé, nem no motor de análise. Apenas indicadores e metadados são
gravados. Pessoas não são identificadas: recebem rótulo genérico e identificador efêmero que
desaparece ao sair de cena. Há teste automatizado que **quebra a entrega** se um número voltar a
aparecer sobre a imagem de uma pessoa.

---

## 5. Onde a pessoa é obrigatória

**Toda ação irreversível.** Publicar no repositório, deployar, apagar dado, disparar mensagem
externa: exige portão verde **ou** aprovação humana explícita.

**Quanto mais crítico, mais curta a coleira.** O grau de autonomia dado à IA é ajustado ao risco:
produção, dados de cliente, segurança e privacidade são as áreas de menor autonomia.

**Decisões que a IA não toma.** O projeto mantém uma lista aberta de decisões que aguardam
definição humana — não por falta de capacidade técnica de propor, mas porque a escolha é de
produto, de ética ou de orçamento. Exemplos em aberto hoje:

- se o produto deve reconhecer conduta individual (equipamento de proteção) — o que colide com a
  promessa de não identificação individual que seis documentos fazem;
- se vale gravar evidência visual de uma violação — o que exigiria revogar a regra de não
  persistir imagem;
- se autorizar um custo de anotação manual para *descobrir* se a acurácia serve;
- onde um número pode ou não aparecer sobre a imagem;
- como equilibrar "a imagem é soberana" contra fadiga de alarme.

**Revisão de diff.** Nenhuma mudança entra sem leitura humana do que mudou. Cada commit registra
o *porquê*, e a participação de IA fica marcada no próprio histórico (`Co-Authored-By`), o que
torna a autoria auditável depois.

---

## 6. O que acontece quando a IA erra

Esta seção existe porque é onde o arranjo se prova. Todos os casos abaixo são reais, deste
projeto, e todos foram detectados **antes** de causar dano.

**Uma sugestão baseada em raciocínio, derrubada por medição.** A IA propôs aumentar a resolução de
análise, citando ganho de recall herdado de outro contexto. Medido no conjunto de avaliação: o
ganho era de 2,1 pontos, custava 91% mais processamento **e** elevava falsos positivos em cena
vazia de zero para quatro. A proposta foi revertida e a curva medida ficou registrada no código.

**Um critério escrito antes de medir, que reprovou a opção preferida.** Ao avaliar um modelo mais
leve, os critérios de aceite foram escritos **antes** da medição. O modelo reprovou em dois de
três, por margem larga. O critério prévio é o que impede escolher olhando o resultado desejado.

**Uma recomendação feita sem verificar o que já existia.** A IA escreveu um procedimento manual de
deploy sem antes checar que o projeto **já tinha deploy automatizado** — mais seguro que o
procedimento proposto. Quem detectou foi uma pergunta humana: *"não tem CI/CD no git?"*. O
documento foi reescrito para apontar a automação existente como caminho principal.

**Um arquivo que iria indevidamente para produção.** A IA criou um perfil de configuração para uma
demonstração ao vivo, que desliga propositalmente proteções de alarme. Esse arquivo entraria no
pacote de publicação, porque a lista de exclusões era anterior a ele. Detectado a partir de outra
pergunta humana; corrigido em duas camadas (exclusão **e** trava que reprova a publicação se o
arquivo reaparecer).

**Uma afirmação forte demais, corrigida pela própria implementação.** A IA afirmou que o sistema
"não media" a idade do quadro de vídeo. Ao implementar, descobriu-se que a medição já existia em
trânsito — o que faltava era retê-la e exibi-la. A afirmação original foi corrigida no documento,
com registro do erro.

**Uma atribuição de causa que a medição não sustentou.** Diante de falhas repetidas no servidor, a
IA estava a um passo de anunciar "causa raiz encontrada". A medição mostrou que as falhas cessaram
por um reinício, e que **nada** na entrega tocava aquele caminho. A conclusão publicada foi
"causa não estabelecida" — não a versão mais favorável.

**Automação que falhou, e o trabalho seguiu.** Uma tentativa de paralelizar quatro frentes de
implementação com agentes automatizados falhou nas quatro por problema de infraestrutura. Como
havia supervisão, a falha foi detectada de imediato, o estado do repositório foi verificado
(nenhuma escrita parcial) e o trabalho foi refeito em sequência.

---

## 7. Rastreabilidade

- **542 commits**, cada um declarando a intenção e o motivo da mudança.
- **16 ADRs** para decisões não óbvias, com consequências assumidas.
- **Residual declarado**: todo fechamento diz o que **não** ficou coberto. Isso não é modéstia —
  é o que impede a próxima etapa de assumir cobertura que não existe.
- Separação explícita entre **medição** e **inferência** nos documentos técnicos: número medido e
  número estimado nunca são apresentados como equivalentes.
- Proporções são publicadas com intervalo de confiança e tamanho de amostra. Não se publica o
  ponto isolado.

---

## 8. O que este documento não afirma

Coerente com o item anterior, o que **não** está demonstrado hoje:

- **Latência percebida não foi medida** em campo. Houve mudanças que a reduzem por construção,
  mas o número exige cronômetro em cena real, com a câmera definitiva instalada.
- **O reconhecimento não foi validado em cena de multidão.** Toda a acurácia medida vem de cenas
  com poucas pessoas.
- **Duas pendências de segurança operacional seguem abertas** no ambiente de homologação
  (rotação de senha de banco e de segredo de autenticação), já identificadas em auditoria interna
  e registradas como prioridade.
- Parte dos limites de alerta em uso são **valores escolhidos**, ainda não calibrados com dado de
  campo — e estão marcados como tal no código.

---

## 9. Resumo em uma linha

A IA acelera a produção de código, teste, infraestrutura e documentação; **portões automatizados
verificam**; e uma pessoa decide o que entra, o que vai a produção e o que o produto deve ser —
com o registro de cada decisão, e do que ainda não se sabe, preservado no repositório.
