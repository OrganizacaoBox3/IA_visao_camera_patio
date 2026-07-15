# control-plane/web — o portal (SPA)

Portal **central** da frota multi-cliente. App **standalone** (Vite + React 19 + TS strict), com
**deploy separado do hub** — por isso vive aqui, em `control-plane/web/`, e **não** em `src/` (o hub
silo). Consome a API do control-plane (Fase 2): `POST /api/login`, `GET /api/overview`,
`GET /api/sites/:id/alarms`. Sem vídeo (Fase 3 fora de escopo).

## Estrutura

```
control-plane/web/
  package.json        deps próprias (React + Vite; NÃO mexe no package.json raiz do projeto)
  vite.config.ts      dev server :4200 + proxy /api -> control-plane (CP_PROXY, default :4100)
  tsconfig.json       TS strict (espelha o tsconfig do hub)
  index.html
  src/
    main.tsx          bootstrap React
    App.tsx           sessão + roteamento por estado (login | frota | site)
    api.ts            cliente HTTP: base VITE_CP_API, token (memória+sessionStorage), 401 -> login
    types.ts          o contrato de API (Overview, Site, Alarm, Scope…)
    ui.tsx            átomos locais: Button/Input/Badge/Field + estados (Loading/Error/Empty)
    styles.css        tokens + going-gray (cor SEMPRE com texto) — NÃO é o src/ui do hub
    format.ts         formatação de tempo/câmera-zona (puro)
    format.test.ts    teste leve (vitest) do formatador
    screens/
      Login.tsx       e-mail+senha -> POST /api/login
      Fleet.tsx       GET /api/overview -> árvore partner>cliente>site (online/offline + alarmes 24h)
      SiteView.tsx    GET /api/sites/:id/alarms -> lista + "carregar mais"
```

Cada tela cobre os três estados: **carregando**, **erro** e **vazio** (estado vazio honesto).

## Rodar em DEV

Precisa do **control-plane no ar** (a API) + o **vite** (a SPA). Dois terminais:

```bash
# 1) a API (control-plane) — porta padrão 4100
cd control-plane
CP_DATABASE_URL="postgres://cp_app:cp_app_pw@localhost:55432/control_plane" npm start
#   (sem Postgres o serviço sobe e responde /health, mas overview/alarms precisam de banco;
#    use o docker-compose do control-plane + npm run seed para ter dados de login.)

# 2) o portal (esta pasta) — porta 4200, faz proxy de /api -> :4100
cd control-plane/web
npm install
npm run dev
# abre http://localhost:4200
```

O proxy do vite manda `/api/*` para `CP_PROXY` (default `http://localhost:4100`). Para apontar a
outra porta/host: `CP_PROXY=http://localhost:5000 npm run dev`.

Alternativa ao proxy: definir `VITE_CP_API` com a URL absoluta da API (ex.
`VITE_CP_API=http://localhost:4100 npm run dev`). O control-plane já manda CORS `*`.

## Build (produção)

```bash
cd control-plane/web
npm run build      # tsc --noEmit && vite build -> dist/
npm run preview    # serve o dist/ localmente para conferir
```

Configure a API de produção com `VITE_CP_API` no build (`VITE_CP_API=https://portal.exemplo/… npm run build`),
ou deixe vazio para **same-origin** (a SPA e a API na mesma origem).

## Próximos passos (declarados, fora desta leva)

- **Servir o `dist/` pelo próprio `control-plane/index.js`** (um static handler simples) para deploy
  de uma origem só — hoje o build é servido à parte (ou via `vite preview`). Não integrado ainda de
  propósito: o foco desta leva é a SPA funcionando contra a API.
- **Compartilhar o design-system** (`src/ui` do hub) via monorepo — hoje os átomos são locais e
  mínimos de propósito (os dois apps têm deploy separado).
- **Fase 3**: vídeo por túnel (ADR-010).
