# Runbook — demonstração ao vivo em feira (SICK SEC110)

> Cenário: stand de feira de fornecedores da SICK, **uma câmera SEC110 apontada para o corredor**,
> público real passando, câmera **aberta em tela cheia** na TV. Decisões do dono em 2026-08-16.
> Perfil de execução: `scripts/feira.sh`. Este documento é o **porquê** e o **checklist**;
> o script é o **como**.

---

## 1. O achado que motivou este runbook

A cena herói escolhida é **presença em área restrita**. O caminho existe e é testado — mas os
defaults de `server/alarm/config.js` são de **CD, não de balcão**:

| Guarda | Default | Efeito num stand |
|---|---|---|
| `ALARM_FLAP_THRESHOLD` = 5 / `ALARM_FLAP_WINDOW_MS` = 10 min | anti-flapping ISA-18 | do **6º disparo em 10 min**, cooldown de **5 minutos**: o alarme para de acender |
| `ALARM_DEDUP_MS` | 60 s | dois visitantes em menos de 1 min → o segundo não vê nada |
| `presencaAlertMs` | 10 s de presença **contínua** | ninguém fica parado 10 s numa feira |

O modo de falha é o pior possível: **silencioso**. Nenhum erro, nenhum aviso na tela — o alarme
simplesmente deixa de existir. Demonstrando a cada ~2 minutos, ele morreria por volta da 5ª ou 6ª
demonstração do dia, provavelmente na frente de quem importa.

Nada disso é bug: num CD, alarme que repete sem parar é fadiga de alarme (ADR-004). É **contexto
errado**. Por isso o perfil vive num script separado e grita na subida que desligou guardas.

## 2. O que o perfil muda (e o que não muda)

`bash scripts/feira.sh --print` imprime o ambiente sem subir nada. Resumo:

- **Alarme:** anti-flap OFF · dedup 5 s · flood 50 (o resumo de rajada não sequestra a tela).
- **Motor:** tier `s` pinado (sem autoscale trocando de modelo no meio da feira), base **3 fps**,
  foco **8 fps** (o teto do próprio motor).
- **Input:** **640** nos dois caminhos.
- **macOS:** sobe sob `caffeinate -dimsu` — sem isso o Mac dorme no meio do dia.

> Cadência e input saíram de **medição**, não de estimativa — ver
> `docs/analises/comparativo-mvp-maos-2026-08-16.md`. Dois números que mudam o desenho:
> o D-FINE-S custa **68,6 ms/quadro** nesta máquina (teto de ~14,6 fps para uma câmera, não
> os 1-2 fps do default), e o input **896 foi refutado** — compra 2,1pp de recall por +91% de
> CPU e leva o falso positivo em cena vazia de **0 para 4**, que num balcão é o pior defeito
> possível.

Mudanças **commitadas** (valem fora da feira também, decisão do dono):

- `src/config.ts` — `overlay.syncDelayMs: 2000 → 0`. Residual declarado no próprio arquivo: o
  **mosaico** (1 fps, sem foco) volta a depender de dead-reckoning com janela de até ~1 s.
- `src/zones.ts` — preset de **2 s** no dwell da zona restrita. O servidor já aceitava
  (`camcfg.js` clampa em `[0, 86_400_000]`, sem allowlist); só faltava a opção na UI.

## 3. Checklist de montagem

### 3.1 Físico (o que impede a demo de existir)

- [ ] **Fonte 12–24 VDC + cabo M12 4 pinos.** A SEC110 **não é PoE** — energia e Ethernet são
      conectores M12 separados. Consumo típico 2 W, então qualquer fonte pequena serve.
- [ ] **Cabo Ethernet M12 D-coded → RJ45** (não é patch cord comum).
- [ ] **Switch/roteador próprio.** Não depender do Wi-Fi do evento.
- [ ] **Altura e ângulo:** alvo de 2,5–3 m, diagonal ao corredor. FOV 82°×52°, alcance útil até
      10 m. Quanto mais alto, menos uma pessoa tapa a outra — e oclusão é o inimigo nº 1 aqui.
- [ ] **HDMI para a TV testado na máquina que vai ao stand**, não em outra.

### 3.2 Rede

- [ ] A SEC110 sai de fábrica em **192.168.136.100**. Ou o notebook entra nessa sub-rede, ou a
      câmera muda de IP na web UI. Decidir **antes**, não no stand.
- [ ] Web UI da câmera: usuários **`main`** (manutenção) e **`servicelevel`**.
- [ ] **Ativar o stream RTSP** na web UI (não vem ligado). Porta 554, path configuráveis.
- [ ] Perfil de stream: **1080p30**. Não usar os 5 MP — o motor reduz para 896 de qualquer forma
      e a resolução cheia só queima CPU no transcode.
- [ ] Validar fora do app antes: `node scripts/validate-streams.mjs` ou um `ffmpeg -frames:v 1`.

### 3.3 Software (na máquina do stand)

- [ ] `ffmpeg -version` responde · `bin/go2rtc` existe · `server/models/dfine_s_obj2coco.onnx` existe.
- [ ] Terminal 1: `bash scripts/feira.sh` → confere o banner do perfil.
- [ ] Terminal 2: `npm run build && npm run preview` (o hub **não** serve o front — em produção
      isso é do nginx; no stand o `preview` é mais estável que o dev server).
- [ ] Cadastrar a câmera em **/cameras** (superadmin) com a URL RTSP.
- [ ] Protetor de tela e suspensão desligados; brilho no máximo; notificações do SO silenciadas.

### 3.4 Configuração da cena

- [ ] **Zona restrita** desenhada sobre a área demarcada no chão, com dwell em **2 s**.
- [ ] **Linha de contagem** atravessando o corredor (a câmera com tripwire já sobe a cadência).
- [ ] Rótulos das zonas com nomes **distintos** — `camcfg.js` rejeita homônimos na mesma câmera,
      e o relatório fica ambíguo se passar.

## 4. Roteiro de ~40 segundos

1. **"Essa câmera não sabe quem você é, e nunca vai saber."** (abre pela privacidade — é o
   diferencial e desarma a objeção antes dela nascer)
2. Aponta a marcação seguindo o visitante na TV. **Sem crachá, sem app, sem sensor no corpo.**
3. **"Pisa aqui."** → zona acende, som, tile vermelho. 2 s, não 10.
4. Mostra o contador de travessias subindo no painel. **"Isso vira KPI sozinho, 24 horas, sem
   ninguém olhando a tela."**
5. Fecha no motor: **"roda no servidor, não no navegador — se eu fechar essa tela agora, o número
   continua."** (fecha a aba, reabre, o número está lá — é a prova mais barata e mais forte)

## 5. Plano B

- **Câmera/rede cai:** loop RTSP local com MediaMTX sobre a gravação do galpão
  (`docs/analises/plano-teste-camera-real.md` §Tier 2, já validado). Trocar de câmera na UI.
- **WhatsApp não conecta:** o visual e o som seguem de pé. Mencionar sem depender.
- **Máquina engasga:** `ANALYSIS_INPUT=640` na frente do comando derruba o custo na hora.

## 6. Residual declarado

- **`npm run verify` está VERMELHO no `audit`** por motivo alheio à feira (§7). Lint, typecheck,
  build e teste passam (1566 testes).
- **Multidão não foi ensaiada.** Todo o número de acurácia do projeto vem de cena de CD com 1-3
  pessoas. Corredor de feira com oclusão densa é população diferente — o ensaio do dia 3 é o que
  transforma isso de aposta em medição. Até lá, **não prometa contagem exata para ninguém**.
- **O atraso real não foi medido**, só raciocinado. `syncDelayMs = 0` com foco a ~2-2,5 fps reais
  dá janela de extrapolação de ~400 ms na conta — cronômetro filmado é o que confirma.
- **`objectScoreThreshold = 0.1`** segue não-commitado em `src/config.ts` (experimento aberto do
  dono, resultado nunca reportado). Modo Objetos está **fora** da demo; se alguém abrir esse modo
  no stand, o comportamento é desconhecido.
- **WhatsApp não tem nenhum teste automatizado** (`whatsapp.js`/`dispatch.js`/`alerts.js`).

## 7. Estado do gate (2026-08-16)

`npm run audit` falha com 4 vulnerabilidades high, **nenhuma introduzida por este trabalho**:

- `react-router` — a exceção da allowlist **expirou em 2026-08-15** (por design: o gate força
  re-avaliação em vez de esquecer).
- `brace-expansion`, `nanoid`, `socket.io-parser` — sem exceção.

Há também **`node_modules` fora de sincronia com o `package.json`**: `brace-expansion@5.0.6`
instalado contra um override de `^5.0.8`, e `react-router@7.17.0` contra `^7.18.1` — os dois
marcados `invalid` pelo `npm ls`. E `react-router-dom` está declarado **duas vezes** no
`package.json` (linha 51 em devDependencies como `^7.18.1`, linha 83 em dependencies como
`^7.17.0`). Ou seja: o que roda localmente hoje **não é o que o `package.json` descreve**.

**Recomendação: não mexer em dependência antes da feira.** Mexer no `package-lock.json` a menos
de uma semana de um evento troca um risco teórico (LAN isolada, sem exposição) por um risco real
(build quebrado na véspera). Congelar agora, resolver depois — com o `verify` verde como critério
de fechamento, não antes.
