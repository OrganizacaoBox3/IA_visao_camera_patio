# SPEC — Control-plane: o portal do integrador (multi-cliente)

> Status: **proposta aguardando aval do dono** · Data: 2026-07-13
> Decisão do dono: construir o portal que agrega múltiplos clientes (não instância isolada).
> Insumos: 2 auditorias read-only (o que o hub reusa · como SaaS/VMS fazem). Fontes no fim.
> Deriva de `spec-multitenancy.md` (o modelo Silo para o vídeo) — este spec detalha o outro lado: o
> control-plane, que é **Pool**.

## 0. A tese em uma linha

O **vídeo é Silo** (cada cliente roda seu hub no site — LGPD, nenhum frame sai da LAN). O
**control-plane é Pool** (um banco único, `tenant_id` + RLS): cadastro (integrador → cliente → site →
usuário) + metadados/alarmes **agregados** + o RBAC com escopo. **Ele NÃO processa vídeo.** O mercado
faz exatamente isso (Eagle Eye, Verkada) e a AWS SaaS Lens nomeia: *"the control plane services are
global to all tenants"* — a multi-tenância "de verdade" (o vídeo) vira isolamento físico.

## 1. A boa notícia: o hub já tem ~70% da fundação

A auditoria confirmou que o control-plane **segue o idioma da casa** e reusa muito:

| peça | estado no hub | no control-plane |
|---|---|---|
| **scrypt** (senha) | `users.js:30-43`, `node:crypto` puro | **reusa as-is** |
| **token HMAC** | `users.js:44-65`, payload `{id,papel,exp}` | reusa o ESQUEMA; **o payload ganha escopo** (§3) |
| **padrão de serviço** | `node:http` + `handle(req,res,ctx)` + `ctx` (`index.js:102`) | **blueprint** — mesmo shape |
| **store pg+fallback** | `recipients.js`/`settings.js` (cache + pg + JSON) | blueprint, MAS **sem fallback JSON** no store tenantizado (JSON não tem RLS — o furo pela porta dos fundos) |
| **forwarder** | `alerts.js`/Andon: POST fail-soft por evento | **esqueleto** do hub→plane; falta SITE_ID + auth + payload rico (§4) |

**O delta no hub é ADITIVO** (não quebra o single-tenant): SITE_ID (env), credencial de site, forwarder
apontado ao plane — todos "env ausente → inerte", a disciplina que a casa já usa (db/CAMERA_TOKEN/Andon).

## 2. O modelo de dados (Pool, um banco no control-plane)

```
partner     (id, nome, ...)                              -- o integrador/revenda
cliente     (id, partner_id → partner, nome, ...)        -- a conta final
site        (id, cliente_id → cliente, nome, site_key)   -- 1:1 com um hub silo
app_user    (id, email, senha_hash, ...)                 -- pessoa (scrypt)
membership  (user_id → app_user, scope_type, scope_id, role)  -- O ESCOPO
alarm_event (id, site_id → site, tipo, ts, meta_jsonb)   -- metadado agregado; tenant = site_id
```

- A **hierarquia é FK auto-referente** (`partner→cliente→site`) — não precisa de `tenant_id` redundante
  no cadastro. O `tenant_id` só existe nas tabelas de **dado agregado**, como `site_id`.
- **`membership` é tabela de junção** (não uma coluna `role` no usuário): permite o mesmo usuário ter
  papéis diferentes em escopos diferentes (o requisito clássico de B2B — admin de um cliente, operador
  de outro).
- **Nada de frame, nada de vídeo, nada de PII sensível além do cadastro.** LGPD por construção.

## 3. O RBAC com escopo (papel × escopo, herança para baixo)

Hoje: 3 papéis **planos e globais** (`usuario/engenheiro/superadmin`), zero escopo (`users.js:10`). O
`superadmin` se **bifurca**:

| papel | scope_type | enxerga |
|---|---|---|
| `platform-admin` | `platform` | tudo (é o dono do portal) |
| `partner-admin` | `partner` | todos os clientes/sites do seu integrador |
| `tenant-admin` | `cliente` | só o próprio cliente e seus sites |
| `site-operator` | `site` | só um site |

- **Herança para baixo** (padrão Verkada Command): um escopo mais alto vê os de baixo. Regra de
  autorização: *acesso concedido sse o recurso pedido está na subárvore do escopo do token.*
- **O token carrega o escopo** (custom claim, padrão Auth0). O HMAC que já existe ganha:
  `{ id, papel, scope_type, scope_id, exp }`.
- **Autorização em todo handler, 2 passos**: (1) resolver a que `site_id`/`cliente_id` o recurso
  pertence; (2) `canAccess(claims, resourceSiteId)` — um join ascendente `site→cliente→partner`
  comparado com o `(scope_type, scope_id)` do token. Uma função recursiva de árvore. Trivial.
- **ReBAC/Zanzibar é overkill — REFUTADO.** Nossa hierarquia é uma árvore estática de 4 níveis; um
  motor de tuplas de relação seria peso morto (YAGNI). Só reavaliar se surgir compartilhamento
  arbitrário fora da árvore de revenda (hoje não existe).

## 4. A fronteira hub ↔ control-plane

- **O hub se registra** com `SITE_ID` (env) + uma **credencial de site** (o hub se autentica no plane).
- **O forwarder** (evolução do `alerts.js`): o hub encaminha o **evento de `events.record`** (já
  LGPD-safe: `{id,ts,cameraId,cameraLabel,zona,tipo,priority,text,state}`, `events.js:40-54`) — NÃO o
  texto cru do Andon. Ponto de plugue: `alarm/pipeline.js:34-44`, onde o `ev` já está montado. Fail-soft
  (o plane cair não derruba o hub — a disciplina do `alerts.js`).
- **Vídeo sob demanda**: túnel por site (WireGuard/Tailscale, PoC do ADR-010) — o plane NÃO recebe
  stream contínuo; abre o vídeo do site quando o operador pede. O frame nunca vive no plane.

## 5. O FURO MORTAL DO RLS — e as 4 camadas que o matam

O bug clássico e silencioso: `SET app.tenant = …` (session-scoped) + connection pool → a conexão volta
ao pool **carregando o tenant anterior**, e o próximo request lê o dado do cliente errado. *Não quebra
teste* (só aparece sob concorrência), *e vai para produção.* O `db.js` da casa é `pg.Pool` (max 5) — o
cenário exato. Conserto em **4 camadas, todas necessárias**:

1. **Transaction-scoped, nunca session**: `set_config('app.current_tenant', $1, true)` (o `true` = local
   à transação), dentro de uma transação. Reverte no COMMIT/ROLLBACK — não vaza. **Fail-CLOSED por
   construção**: esquecer o set → a transação vê ZERO linhas (não as do vizinho). Alinha com a lição nº
   30 (guard fail-closed).
2. **`FORCE ROW LEVEL SECURITY`** na tabela — senão o dono da tabela ignora a RLS por padrão.
3. **Usuário de conexão não-privilegiado** — não-dono, sem `BYPASSRLS` (superuser fura tudo).
4. **Se um dia entrar PgBouncer**: só **transaction pooling** (session pooling é incompatível com GUC).

**Gate de teste (a priori):** um teste de concorrência que abre 2 transações de tenants diferentes no
mesmo pool e prova que nenhuma vê a linha da outra. Sem esse teste, RLS não entra (é o "contrato sem
teste = regressão silenciosa nº 1", e aqui a regressão é vazamento entre clientes).

## 6. A stack: `node:http` + `pg` + RLS nativo (sem framework, sem IdP externo)

O RBAC hierárquico de 4 níveis é uma árvore — `canAccess()` é ~1 função recursiva. **Não justifica**
framework nem IdP gerenciado (Auth0/Cognito) nem motor ReBAC (OPA/SpiceDB). Fica no padrão da casa
(CLAUDE.md §4 "sem dependência supérflua"). O único componente novo é o control-plane ser um **processo
separado** do hub, nascendo com as 6 tabelas, RLS `FORCE`, usuário `pg` sem `BYPASSRLS`, e o middleware
transaction-scoped. (Reavaliar IdP só se um cliente exigir SSO corporativo.)

## 7. As fases (cada uma validável; o primeiro tijolo sai logo)

**Fase 0 — a fundação de segurança (backend puro, testável, SEM UI):**
- O schema (6 tabelas) + RLS `FORCE` + o usuário `pg` sem `BYPASSRLS`.
- O middleware transaction-scoped (`set_config(...,true)` por request) + **o teste de concorrência** que
  prova o isolamento (o gate do §5). **Nada avança sem ele verde.**
- `canAccess(claims, recurso)` puro + testado (a árvore de escopo).
- O token HMAC ganha o escopo (`signToken`/`verifyToken` do plane).

**Fase 1 — o cadastro (o primeiro tijolo VISÍVEL):**
- CRUD de partner/cliente/site/user/membership, cada endpoint atrás do `canAccess`. Um site nasce com
  uma `site_key` (a credencial do hub).
- **O hub se registra**: SITE_ID + credencial + o forwarder de eventos apontado ao plane (aditivo no
  hub). Prova a arquitetura ponta a ponta: um hub silo aparece no portal.

**Fase 2 — a agregação e a UI:**
- O plane recebe e guarda os `alarm_event` dos hubs (por site). O portal (SPA, o idioma React da casa)
  mostra a frota: partners → clientes → sites → alarmes, cada um sob o escopo do usuário logado.

**Fase 3 — o vídeo sob demanda:**
- O túnel por site (ADR-010) para abrir o vídeo de um site a partir do portal, quando pedido. O frame
  nunca persiste no plane.

## 8. O que NÃO fazer
- ❌ `tenant_id` nas tabelas do HUB (o hub É o tenant — Silo; a coluna é cerimônia).
- ❌ Fallback JSON no store tenantizado do plane (JSON não tem RLS — o furo pela porta dos fundos).
- ❌ ReBAC/IdP externo/framework (overkill medido para uma árvore de 4 níveis).
- ❌ Streaming de vídeo para o plane (mata a LGPD e a banda — o vídeo é Silo).

## 9. Risco residual declarado
- **É arquitetura para escala que ainda não existe** (1 cliente hoje). Mitigação: fases pequenas, a
  Fase 0 é pura segurança (útil e não-especulativa), e o hub segue single-tenant intacto o tempo todo.
- **Lacunas de mercado honestas**: o schema interno de Eagle Eye/Genetec não é público — o modelo de
  dados aqui é inferência de arquitetura (validada pela AWS SaaS Lens + Verkada), não medição.
- **O 1º cliente ainda não está validado** (caminhada #4, motor no hub #68). Construir o plane em
  paralelo é OK (é backend separado), mas a prioridade de negócio é sua.

## Fontes
AWS SaaS Lens (control plane vs application plane; IAM) · AWS Database Blog (RLS multi-tenant) ·
ricofritzsche (SET vs SET LOCAL) · PgBouncer transaction pooling · Auth0 (B2B org RBAC, custom claims) ·
Verkada Command (roles/herança) · Eagle Eye (reseller portal) · authzed/Aserto (ReBAC é overkill).
