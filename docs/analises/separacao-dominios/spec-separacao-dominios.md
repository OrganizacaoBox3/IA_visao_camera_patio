# SPEC — Separação de domínios: visão computacional × BLE (dois repositórios)

> Data: 2026-07-16 · Origem: decisão do dono ("misturamos os dois em diversos pontos; quero voltar
> atrás dessa interação por enquanto"). Fonte da verdade desta mudança.
> Anexos: `inventario.md` (classificação dos ~490 arquivos, por evidência) e `lista-de-corte.md`
> (call-sites verificados, arquivo:linha — a cirurgia exata dos dois lados).
> Checkpoint de segurança: commit `6a2f1ca` no main; duplicata íntegra em
> `C:\Users\crist\grendene_cd_inovacao\mvp_trilateracao_BLE` (clone com histórico + runtime + gravações).

## 1. Veredito de viabilidade

**VIÁVEL, com esforço baixo-médio e risco controlado.** Três fatos medidos sustentam:

1. **Os domínios já são quase separados por construção.** A doutrina da casa (contratos aditivos,
   pastas por domínio) fez o acoplamento se concentrar em POUCOS pontos: a ponte inteira
   câmera↔BLE passa por **um tipo** (`BtReading` no api.ts), **um evento de socket**
   (`bt-readings`) e **uma prop** (`getReadings` injetada do DashboardPage). Cortados os três, o
   resto "cai por gravidade" (lista-de-corte.md, Parte A).
2. **Inventário completo (por evidência, não por nome)**: 214 arquivos só-visão · 71 só-BLE ·
   72 de FUSÃO (existem apenas para ligar os dois — saem da visão; ficam dormentes no histórico) ·
   88 de base compartilhada · 41 mistos (ficam nos dois lados com trechos a cortar — todos com
   linha marcada).
3. **O motor de análise não sabe que o BLE existe** (um único gancho: o gravador de sessão em
   `analysis/pipeline.js:39,163`) e **o servidor BLE não sabe que a câmera existe**. A cirurgia é
   de apresentação e wiring, não de arquitetura.

## 2. Resultado esperado (o "depois")

| | `visao_computacional_mvp` (este repo) | `mvp_trilateracao_BLE` (novo) |
|---|---|---|
| Produto | Câmeras: detecção/rastreio 24/7, alarmes, WhatsApp, relatórios, zonas/linhas, calibração de DISTÂNCIA (homografia fica — medir é da câmera) | Planta 2D: tags/estações/fingerprint/zonas/mesas/presença+tempo, mapa AirTag, app Android da estação |
| Sai | TODO o BLE e TODA a fusão: 5 rotas/telas, menu, `src/fusion`+`src/planta`+`src/spatial`+`src/routes/ble`, `server/bt`+rotas bt, passos BLE da calibração, anéis/vista 2D/aba "Por quê", evento `bt-readings`, tabelas `bt_*` do schema | TODA a câmera: motor `server/analysis`, rtsp/go2rtc/shed/camcfg/alarmes/WhatsApp(?), `src/camera`+dashboard+report, rotas de câmera, relé de frames, tabelas de indicadores |
| Fica dos dois | Base: auth/usuários/RBAC, persistência pg+json, http/socket core, UI kit Radix/tokens, turnos, control-plane (registro/heartbeat), e2e/CI infra | Idem |
| Rótulo na pessoa | Sempre o genérico "Pessoa" (`personLabel(undefined,…)` — o gate anti-número FICA) | — |
| Home | Central de câmeras | Mapa de tags |
| Porta default | 4000 | **4001** (para coexistirem na mesma máquina) |
| Identidade | — | Renomear no package.json + título; `tc22-scanner/` mora aqui |

O CÓDIGO DE FUSÃO não se perde: está no commit `6a2f1ca` de AMBOS os históricos + tag de
preservação a criar no corte (`pre-separacao-2026-07-16`, mesmo rito do ADR-016). Reativar a
interação no futuro = reverter um PR, não reescrever.

## 3. Plano de execução (cada onda com gate verde antes da próxima)

**Onda 0 — preparo (feito):** commit `6a2f1ca` ✓ · clone com histórico ✓ · runtime copiado
(users.json, configs BLE, gravações de campo — invariante append-only agora tem DOIS lares) ✓ ·
`npm install` da duplicata ✓ · inventário + lista de corte ✓.

**Onda 1 — repo BLE (`mvp_trilateracao_BLE`), ~0,5–1 dia.** Seguir `lista-de-corte.md` Parte B:
- Resgatar 3 arquivos BLE que moram em pasta de câmera ANTES de deletar `src/camera`:
  `useBleReadings.ts` (consumido pela planta), `TagPicker.tsx`, `takenTags.ts` → `src/ble/`.
- Remover front de câmera em bloco + rotas/menu; remover `server/analysis`, rtsp/go2rtc/relé/
  camcfg/alarmes; podar schema (mantém `bt_*`, users, shifts); podar deps (onnxruntime, sharp,
  baileys…); porta 4001; renomear.
- Decisão em aberto (barata): manter ou não WhatsApp/notificações na app BLE — default: remover
  (volta quando houver alerta de zona).
- Gate: `npm run verify` verde + e2e (a11y `/`, `/tags-ble`, `/planta-ble`) + subir e ver a Planta
  ao vivo com as estações reais.

**Onda 2 — repo visão (este), ~0,5–1 dia.** Seguir `lista-de-corte.md` Parte A (cirurgia com
linha marcada): tag de preservação → cortes de front (main/AppShell/api/socket/workspace/tile/
calibração) → deleções em bloco (`src/fusion`, `src/planta`, `src/spatial`, `src/routes/ble`,
telas) → server (`server/bt`, rotas bt, wiring, schema sem DROP) → e2e ajustado.
- **ADR curto obrigatório no mesmo PR** (contratos de socket do CLAUDE.md §3 mudam: `bt-readings`
  deixa de existir na visão; `analysis-tracks`/`frame` etc. deixam de existir na BLE) + atualizar
  CLAUDE.md §1/§3 dos DOIS repos (a app BLE ganha um CLAUDE.md enxuto próprio).
- As gravações de campo saem do runtime da visão APÓS confirmação de que a cópia na app BLE está
  íntegra (nunca `rm` antes de conferir hash/contagem — incidente de 2026-07-10).
- Gate: `verify` verde + `npx playwright test` + subir e operar a Central sem nenhum vestígio BLE.

**Onda 3 — pós-corte, ~0,5 dia:** README/CLAUDE.md de cada repo, memória do assistente atualizada,
homolog (se/quando o BLE for a deploy, definir banco próprio — as tabelas `bt_*` existentes no
Postgres compartilhado não são dropadas), e um smoke de campo com as 3 estações apontando para a
app BLE.

## 4. Riscos declarados

1. **Manutenção dupla dali em diante** (o custo real da decisão): base copiada = correções de
   auth/UI/persistência precisam ser aplicadas 2×. Mitigação: mudanças de base viram commits
   pequenos e cherry-pickáveis (mesma história git!) — e o horizonte declarado é "por enquanto".
2. **Drift de contrato do app Android**: o `tc22-scanner` passa a morar no repo BLE; a visão não
   deve mais tocá-lo.
3. **Banco compartilhado**: se as duas apps apontarem para o MESMO Postgres, `users`/`shifts`
   colidem (mesmas tabelas). Default do plano: BLE roda em JSON-fallback (como hoje) ou banco
   próprio; nunca o mesmo DB nas duas.
4. **Remoção de evento de contrato** (`bt-readings` na visão): coberto por ADR; nenhum consumidor
   externo conhecido além do próprio front.
5. **e2e/home**: a home da visão muda (era o mapa BLE) — specs reapontadas na própria onda.

## 5. Fora de escopo (desta mudança)

Refactor da base em pacote compartilhado/monorepo (só se a dupla manutenção doer de verdade);
qualquer feature nova; deploy do repo BLE em homolog; mexer no control-plane.
