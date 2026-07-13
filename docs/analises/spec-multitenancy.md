# SPEC — Tenantização: um site, uma instância (SILO), não um pool

> Status: **proposta aguardando aval do dono** · Data: 2026-07-13
> Pedido: *"tenantizar a aplicação — rotas e acessos diferentes pro cliente. Veja se será preciso
> tenant, sharding, e tudo mais."*
> Insumos: 3 auditorias read-only (plano de dados / isolamento / mercado+escala) + verificação direta.
> Decisão irmã: **ADR-010** (edge gateway — Edge Fino × Edge Grosso). Esta spec resolve a metade que faltava.

## 0. As três respostas, direto

1. **Precisa de tenant?** Sim — mas **no control-plane (a nuvem de gestão), não no hub do site.** O hub *é* o tenant; ele não precisa aprender o conceito.
2. **Precisa de sharding?** **Não. É overengineering, medido.** (§3)
3. **Um processo multi-tenant, ou uma instância por cliente?** **Uma instância por SITE (silo).** E não é preferência — **a física da carga já obriga.** (§2)

## 1. O estado de hoje, sem rodeio

`grep -riE "tenant|orgId|siteId|customer"` em `server/ src/ *.sql` → **ZERO ocorrências.** O sistema não é single-tenant por configuração; é single-tenant **por construção**: 23 tabelas sem coluna de cliente, 13 arquivos JSON globais, ~20 Maps de processo. A dimensão "cliente" não existe em camada nenhuma — nem no token, nem nas salas de socket, nem nas chaves.

## 2. Por que SILO, e por que a física decide sozinha

O gargalo do produto **não é o banco — é a inferência.** Medido contra o ADR-009:

| recurso | 10 clientes × 17 câmeras | escala |
|---|---|---|
| **CPU de inferência** (D-FINE, 0,2 core/câm) | **~34 cores** | linear, **sem teto** |
| banco (upserts de bucket) | fração de 1 core, ~2,3 GB/ano | trivial |

**Você não coloca 170 câmeras num processo — a carga já obriga a distribuir.** E a fronteira natural de distribuição (onde as câmeras estão, onde a LAN está, onde o uplink acaba) **é o SITE**. O silo não é escolha de arquitetura; é a forma que a física impôs.

E ele casa com a invariante que já temos: **nenhum frame sai da LAN** (ADR-002/LGPD). Vídeo cruzando a WAN para um pool na nuvem violaria isso e custaria 2-6 Mbps **por câmera** (contra ~0,3 Mbps de metadados para 10 câmeras).

**É o consenso do mercado, unânime:** Verkada (analytics no edge, vídeo on-device), Eagle Eye (exige o *Bridge/CMVR* on-prem no site), Rhombus (processa no edge, sobe só metadados). Ninguém joga stream de todo mundo num cloud multi-tenant.

### Silo × Pool — o custo REAL (não estético)

| eixo | **SILO (recomendado)** | Pool + RLS |
|---|---|---|
| código no hub | **~zero** — ele nem sabe que há outros clientes | 23 tabelas × `tenant_id` + RLS + política + índice composto + 8 JSONs que não têm dono |
| vazamento | **impossível por construção** — não há query que cruze | um `SET LOCAL` esquecido no pool `pg` = **dado do cliente errado, em silêncio** |
| LGPD | frame nunca sai da LAN — de graça | vídeo + dado de N clientes no mesmo lugar |
| banco | otimiza o recurso **abundante** (2,3 GB/ano) | idem — otimiza o não-gargalo |
| custo real | **operar N instâncias** (fleet mgmt — a única dor, e é conhecida) | um deploy só |

O único custo do silo é operar N hubs — dor **conhecida e resolvida** (é o que Verkada/Eagle Eye fazem). O custo do pool é um **vazamento silencioso e irreversível entre clientes**. Não é troca simétrica.

## 3. Sharding é ruído — a conta

Medido em `server/data-hist.json` (produção real, ~11 dias): **17 câmeras, 61 linhas de bucket/dia, ~24,6 KB/dia.** Os buckets são **UPSERT** (`on conflict do update`) — escrever 1.200×/hora na mesma linha cria **uma** linha, não 1.200.

Extrapolado a 10 clientes × 17 câmeras: **~11 M linhas/ano, ~2,3 GB/ano, ~430 upserts/s.** A fronteira onde sharding começa a valer é **10⁹ linhas / TB / dezenas de milhares de writes/s** — estamos **2-3 ordens de grandeza abaixo**. Um Postgres num notebook faz isso sem suar. **Sharding otimizaria o recurso que medimos ser abundante e ignoraria o escasso (CPU).** Regra 9 aplicada a sistemas.

## 4. 🔴 O que NÃO espera pela tenantização — vaza HOJE, em single-tenant

Estes são bugs **atuais**, agravados por multi-tenant mas já reais. Entram como **hotfix de segurança**, antes de qualquer onda:

| # | vazamento | evidência | conserto |
|---|---|---|---|
| **S1** | **go2rtc servido SEM AUTENTICAÇÃO.** `/go2rtc/*` é interceptado e proxiado **antes** do `requireAuth`. Quem alcança a porta faz `GET /go2rtc/api/streams` (lista as câmeras) e `/api/frame.jpeg?src=<id>` (o frame, sem login). É **imagem** — o pior sob LGPD. **Verificado**: `server/index.js:93` chama `proxyRequest` direto; o hub respondeu ao path sem exigir sessão. Em produção (go2rtc no ar) isso é `200`, não `503`. | `server/index.js:93,143` · `go2rtc.js:129-134` (sem `username/password`, `origin:"*"`) | gate de auth no proxy + checar que `src` pertence ao escopo + go2rtc com `api: username/password` e bind local |
| **S2** | **frame de TODA câmera para TODO dashboard.** `socket.join("dash-legacy")` incondicional; o emit de frame vai para essa sala. Até o dashboard mandar `watch`, ele recebe o frame de todas. | `sockets/dashboard.js:19` · `sockets/camera.js:31` | ver §5 (salas por escopo) |
| **S3** | **`watch({ids})` confia 100% no cliente** — nenhuma verificação de propriedade. Um autenticado pede os ids de outro e recebe os frames. | `sockets/dashboard.js:36-46` | o servidor filtra `ids` contra as câmeras do escopo do socket |
| **S4** | **o nó de câmera DECLARA o próprio id** com um `CAMERA_TOKEN` **global único** — dá para sobrescrever/sequestrar o id de outra câmera. Já é bug em single-tenant. | `sockets/camera.js:13` · `index.js:169-177` | token de enrolamento **por câmera**, id atrelado ao token |

## 5. O mapa do trabalho (em ondas, a venda destrava na Onda 1)

### Onda 0 — Hotfix de segurança (independe de multi-tenancy; faz-se JÁ)
S1–S4 do §4. São bugs reais hoje. **Não dependem de nada do resto desta spec.**

### Onda 1 — Identidade do site (o mínimo que destrava vender para o 2º cliente)
1. **`SITE_ID`** no hub (env). Ele **não particiona nada localmente** — é o rótulo com que o hub se apresenta ao control-plane. Custo: ~1 arquivo.
2. **Credencial por site**: `CAMERA_TOKEN` e `BT_STATION_TOKEN` deixam de ser segredos globais únicos (o ADR-010 já os marcou como fracos para multi-cliente).
3. **Forwarder de metadados** hub → control-plane: estende o padrão do `ALERT_WEBHOOK_URL` que já existe. **Só metadados** (~0,3 Mbps/10 câmeras). Frame nunca vai.

### Onda 2 — Control-plane (é AQUI que o `tenant_id` mora — e só aqui)
4. Serviço **novo e pequeno**: `partners / clientes / sites / users`. Multi-tenant de verdade — mas o dado é **cadastro + alarme agregado**, não vídeo. Schema pequeno, nasce com `tenant_id` + RLS: aqui é **barato e correto**.
5. **RBAC com ESCOPO** — a mudança estrutural. Hoje há 3 papéis **planos e globais** (`usuario/engenheiro/superadmin`, `canConfigure`) e **zero escopo**: o token carrega só `{id, papel, exp}`. Falta não é *mais papel* — é `papel × escopo`. Um admin precisa responder "admin **de quê**". A hierarquia do mercado (Eagle Eye): `PARTNER (integrador) → CLIENTE → SITE → operador`. O `superadmin` de hoje se bifurca em **`platform-admin`** (cross-tenant) e **`tenant-admin`** (só o próprio cliente).
6. Túnel por site (WireGuard/Tailscale — PoC já validado no ADR-010) para vídeo **sob demanda**, não contínuo.

### Onda 3 — Frota (a dor real do silo — orce ISTO, não o banco)
7. Deploy, atualização e health de N hubs. É onde mora o trabalho de verdade do modelo silo.

## 6. O que NÃO fazer (registrado para não voltar como tentação)
- ❌ **Sharding** — 2-3 ordens de grandeza longe de precisar (§3).
- ❌ **`tenant_id` nas 23 tabelas do hub** — o hub *é* o tenant. A coluna é cerimônia: não aumenta capacidade, não reduz carga, não move KPI (filtro Signal×Noise do CLAUDE.md).
- ❌ **RLS no Postgres do hub** — protege contra um cruzamento que, no silo, não pode acontecer. (E o fallback JSON não tem RLS nenhuma: o furo entraria pela porta dos fundos.)

## 7. Risco residual declarado
- **Nº de usuários por cliente não foi medido** (`users.json` é runtime, não legível). Se for "centenas por cliente", a Onda 2 fica mais pesada — mas **o veredito não muda** (usuário é cadastro, não vídeo).
- **Exposição real do S1 em produção depende do nginx do homolog** — a config versionada (`deploy/nginx-visao.conf`) não tem `location /go2rtc/`, mas o hub em `:8091` acessado direto está aberto, e se o nginx do homolog foi editado à mão para o WebRTC funcionar, está exposto na WAN. **Ação: `curl https://<host>/go2rtc/api/streams` sem token, no homolog real.**
