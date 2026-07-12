# ADR-016 — Faxina de produto: a pesquisa sai do main (fica na tag)

Data: 2026-07-12 · Status: aceito · Origem: auditoria código-por-código do produto vivo, aprovada
pelo dono. Complementa os ADRs 012–015 (que registram o CONHECIMENTO do arco — este registra o
destino do CÓDIGO).

## Contexto

O arco de pesquisa BLE+visão (ADRs 012–015) deixou no main ≈7,4k linhas-fonte + ≈11k de teste. A
auditoria código-por-código mostrou que **só ~17% de `src/fusion` estava vivo no produto**; o resto
eram ilhas sem consumidor (`petri-conservation`, `zone-assignment`, `zone-crossing`, `visit-metrics`,
`event-metrics`, `anchor-policy`, `error-geometry`, `receiver-geometry`, `receiver-at-destino.test`,
`theta-discriminator`, `static-tracks-triage`, `residual-autocorr`, `label-memory`,
`regime-reliability`, `memory-metrics`, `persistence-*`, `floor-plan`, `floor-plan-gain`,
`evidence.ts`) mais o motor test-only de `src/localizacao` (`engine`, `fusion-engine`,
`guarded-engine`, `motion-engine`, `replay`, `scenarios`, `recording`, `simulate`, `metrics`). Os
testes desse código rodavam no CI **guardando afirmações científicas, não produto** — custo de
verify/CI e ruído de manutenção sem mover KPI (filtro Signal×Noise do CLAUDE.md §5).

## Decisão

1. **A pesquisa sai do main.** Tudo preservado na tag git **`research-fusion-arc-2026-07-12`** —
   deleção reversível por construção. O **conhecimento** não sai de lugar nenhum: vive nos laudos
   (`docs/cientifica/`), nos ADRs 012–015 e no registro científico
   `docs/analises/tags-bluetooth/PENDENCIAS.md`.
2. **O CI volta a testar produto.** Ficam os testes que guardam o motor VIVO: `associate`,
   `identity-metrics`, `replay-fusion`, `gates-recalibration`, `shuffle-baseline`, `world-spec`,
   `funnel-session`.
3. **A bancada `/replay` FICA** — ferramenta interna de diagnóstico, gated por `canConfigure`.
4. **Critério para pesquisa voltar ao main:** virar **feature com consumidor vivo** no produto.
   Até lá, experimento novo nasce na tag/branch de pesquisa, não no main.
5. Na mesma faxina (registro; detalhe no changelog): órfãos removidos (emit `bt-locations`,
   listener `set-capture`, `deleteBtTag`, `reading/cluster.ts`, `server/_zxing_roundtrip_test.cjs`);
   endpoints da estação BLE passam a exigir `BT_STATION_TOKEN` em produção; rota nova
   `GET /api/cameras/connected`; correções de UX (`setCameraCfg` propaga erro, Selects gated,
   latch de falha do OWL-ViT).

## Consequências

- Main menor e honesto: o que está no repositório é o que o produto usa; o CI mede regressão de
  produto, não hipótese científica.
- Referências a arquivos de pesquisa em docs/regras apontam para a tag (nota no CLAUDE.md §6).
- Reabrir o arco (tag ≥2Hz, ESP32-instrumento, caminhada anotada — decisões de hardware pendentes)
  parte da tag + PENDENCIAS.md, sem reescrever nada.
- Risco residual: alguém "ressuscitar" um módulo copiando da tag sem consumidor vivo — barrado pelo
  critério nº 4 acima.
