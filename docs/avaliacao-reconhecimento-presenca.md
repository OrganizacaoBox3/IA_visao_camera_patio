# Avaliação — reconhecimento/contagem de pessoas e tempo de permanência

> Avaliação técnica + de viabilidade + de risco, em **2026-06-09**, antes de qualquer implementação.
> Pedido do usuário: (a) **reconhecimento + store de rosto** para contar quantas vezes uma pessoa passa por dia num local; (b) **tempo de permanência** dela; (c) **contagem de pessoas numa sala** em tela; analogia: o player de streaming que mostra os **atores em cena ao pausar**.
> Relacionado: [`PLANO-MVP.md`](./PLANO-MVP.md) (posicionamento e escopo).

---

## 1. A tensão central (ler primeiro)

O produto foi **posicionado** (documento da proposta) como **inteligência operacional por ÁREA, não vigilância individual**, com **privacy by design** e a mitigação explícita de **"evitar reconhecimento facial"** e **"sem identificação individual no MVP"**.

- **Contagem de pessoas / permanência ANÔNIMA** (por corpo, sem identidade) → **aderente** ao posicionamento. ✅
- **Reconhecimento facial + store + "quantas vezes a pessoa X passou"** → **identificação individual + biometria**. Sob a LGPD é **dado pessoal sensível** (art. 11), exige consentimento específico/base legal robusta, e **contradiz a tese de venda** (vira "vigilância de funcionário"). ⚠️

> Conclusão de posicionamento: dá para entregar **contagem e permanência** sem cruzar essa linha. O **reconhecimento facial** muda a natureza do produto e deve ser decisão consciente, separada e opt-in — não o default do MVP.

---

## 2. Viabilidade técnica (no navegador, stack atual)

| Capacidade | Como | Viabilidade in-browser | Biometria? |
|---|---|---|---|
| **Contagem de pessoas por sala/zona** | coco-ssd (já carregado): contar `person` por zona | **Alta** — já temos o modelo | ❌ não |
| **Permanência (dwell) ANÔNIMA** | tracker leve (centroid/IoU) com **IDs efêmeros** por sessão ("Pessoa 1"), cronometra presença | **Média-alta** — tracker simples resolve | ❌ não (ID some ao sair/reiniciar) |
| **"Atores em cena ao pausar"** | ao pausar, congela o frame e rotula cada pessoa detectada (ID efêmero + tempo em cena) | **Alta** (versão anônima) | ❌ não |
| **Reconhecimento facial + re-ID por dia** | embeddings de face (face-api.js / FaceNet-tfjs) + store (IndexedDB) + match por distância | **Baixa-média** | ✅ **sim (sensível)** |

### Caveat técnico decisivo
O caso de uso do produto é **pátio/expedição** — câmeras **abertas e distantes**. Nesse cenário os rostos ficam **minúsculos e de baixa resolução → reconhecimento facial praticamente não funciona**. Reconhecimento de face só rende em câmera **frontal e próxima** (catraca/porta/acesso) — que é **outro produto**.
**Detecção/contagem/permanência por CORPO funciona à distância** — ou seja, a abordagem anônima é **simultaneamente mais segura (LGPD) e mais viável (técnica)** para o pátio. A analogia do streaming pressupõe um "elenco conhecido" frontal — não é o ambiente industrial.

---

## 3. Os três níveis (decompostos por risco × aderência × valor)

**Nível 1 — Contagem por zona (anônimo).** Pessoas em cada sala/área agora + pico. Risco nulo, aderente, alto valor operacional ("quantas pessoas na expedição"). **Recomendado no MVP.**

**Nível 2 — Permanência anônima (dwell).** Tracker efêmero por sessão: "Pessoa 1 está há 4m na zona X". Sem rosto, sem identidade persistente, reseta a cada sessão. Mede *tempo de permanência* sem biometria. **Recomendado no MVP** (cobre o pedido de "tempo de permanência" de forma segura).

**Nível 3 — Reconhecimento facial + re-ID por dia (biométrico).** "A mesma pessoa passou 7× hoje". Exige base de embeddings de rosto armazenada = **dado sensível**. Contraria o posicionamento, baixa acurácia no pátio, alto risco jurídico/cultural. **Fora do MVP operacional**; se desejado, só como **módulo separado, opt-in, OFF por padrão, local-only, claramente rotulado** e para cenário de **câmera de acesso** (não pátio).

---

## 4. Recomendação

**Entregar Níveis 1 e 2 no MVP** (contagem + permanência anônima + "inspecionar ao pausar"), que:
- atendem *contagem de pessoas* e *tempo de permanência* **sem biometria**;
- honram a analogia do player de forma anônima (pausar → quem está em cena + há quanto tempo, como "Pessoa 1/2/3");
- reforçam a narrativa "inteligência operacional, não vigilância" — viram um **diferencial de demo**, não um passivo.

**Tratar o Nível 3 (reconhecimento facial) como trilha à parte**, fora do pitch operacional. Se o usuário quiser um **demo técnico de capacidade** (mostrar que "sabemos fazer"), fazer num **modo isolado, opt-in, com aviso de biometria/LGPD, dados só locais, com botão de apagar tudo** — e deixar explícito que o ambiente ideal é acesso/porta, não pátio.

---

## 5. Plano de implementação — o que entra no MVP (Níveis 1+2)

Tudo no mesmo padrão da POC (in-browser, config-driven, anônimo):

1. **Contagem por zona:** somar `person` (coco-ssd) por zona; exibir nº atual + pico da sessão no card da zona e no overlay. *(pequeno — o detector já roda)*
2. **Tracker anônimo (dwell):** matcher por centróide/IoU entre frames → IDs efêmeros; cronômetro de presença por track; expira ao sair (timeout). Sem rosto, sem persistência. *(médio)*
3. **"Inspecionar ao pausar":** botão Pausar → congela frame → desenha cada pessoa com ID efêmero + tempo em cena + zona. *(pequeno, em cima do tracker)*
4. **Indicadores:** "pessoas agora" (total e por zona), "permanência média", "pico de ocupação", no painel e no resumo de sessão.
5. **Config:** `peopleScoreThreshold`, `trackMaxDistance`, `trackTimeoutMs`, `dwellMinMs`. Tudo calibrável.
6. **Privacidade explícita:** manter o badge "sem identificação individual"; IDs são "Pessoa N" efêmeros (deixar isso claro na UI).

> Esforço: ~1–2 dias somados ao MVP atual. Não altera o posicionamento; soma valor.

---

## 6. Se (e só se) for fazer o Nível 3 (biométrico) — requisitos mínimos

Decisão de produto/jurídica, não só técnica. Pré-condições inegociáveis:
- **Base legal + consentimento** específico (LGPD art. 11), aviso aos colaboradores, finalidade declarada.
- **Modo opt-in, OFF por padrão**, isolado do fluxo operacional; rótulo visível de "biometria".
- **Armazenamento local** (IndexedDB), **só embeddings** (não imagens), **retenção curta**, **botão apagar tudo**, acesso restrito.
- **Cenário correto:** câmera frontal/próxima (acesso), não pátio.
- **Expectativa de acurácia realista** (in-browser, distância/iluminação industrial → alta taxa de erro). Técnica: face-api.js (descritor 128-d) ou embeddings tfjs + match por distância (cosine/euclidiana) com limiar.

---

## 7. Decisão pedida ao usuário
- **(A) MVP com Níveis 1+2 (anônimo)** — recomendado: contagem + permanência + pausar-para-inspecionar, sem biometria. Sigo implementando.
- **(B) Também um módulo Nível 3 (reconhecimento facial)** — separado, opt-in, com os requisitos da §6, ciente do risco de posicionamento e da baixa acurácia no pátio.
