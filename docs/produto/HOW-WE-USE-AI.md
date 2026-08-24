# How AI was used in this project

> Describes what was done, with which tool, and how each thing was verified.
> Project `visao_computacional_mvp` — industrial computer vision.
> State as of 2026-08-19. Portuguese version: [`COMO-USAMOS-IA.md`](COMO-USAMOS-IA.md).

---

## 1. Repository figures

| Item | Count |
|---|---|
| Commits | 542 |
| Automated tests | 1,598 (136 files) |
| Model-accuracy sensors | 17 scripts |
| Architecture Decision Records (ADR) | 16 |
| Technical documents | 171 |
| CI/CD automations | 5 workflows |
| Declared invariants (non-violable) | 9 |

---

## 2. Where AI was used

| Area | What the AI produced | Verifiable artifact |
|---|---|---|
| **Application code** | React/TypeScript front end and Node.js server: video analysis engine, per-zone counting, alarm policy, authentication, RBAC, reporting | `src/`, `server/` |
| **Tests** | Unit and contract tests, including tests that lock privacy invariants | 136 `*.test.*` files |
| **ML sensors** | Bench that measures recognition accuracy against reference-annotated images | `eval/` |
| **Planning** | Specs with acceptance criteria, wave-based plans, open-item inventories | `docs/analises/` |
| **Architecture** | Drafting of the ADRs (Context → Decision → Consequences) | `docs/analises/decisoes/` |
| **Infra / DevOps** | CI, staging deploy, remote diagnostics, `systemd`, `nginx`, video ingestion | `.github/workflows/`, `deploy/` |
| **Operations** | Server and video-source diagnostic tooling | `scripts/` |
| **Research** | Measured comparison between recognition engines (cost per frame, recall, false positives) | `docs/analises/comparativo-*` |
| **Documentation** | Operating manuals, deploy runbooks, this document | `docs/produto/` |

---

## 3. Division of decision-making

| Decision | Who decided | How it is recorded |
|---|---|---|
| Scope, priority, product direction | Architect | Commit + plan document |
| Architectural trade-off | Architect, advised by measurement | ADR with date and authorship |
| Implementation (how to code it) | AI | Reviewed diff |
| Approving what gets in | Architect | Diff review |
| Publishing to production | Architect (manual trigger) | Workflow log |
| Rolling back on failure | Architect | Printed instructions, manual execution |

Rule recorded in the project guide: *"an automated recommendation is a hypothesis, not an order — re-verify against the runtime before acting."*

---

## 4. Verification before every delivery

| Layer | What it checks | Where it runs |
|---|---|---|
| `verify` | Static analysis, types, build, tests, dependency audit | Local machine (pre-push) |
| CI | The same `verify` + interface tests + accuracy sensors | Integration server |
| `eval/` sensors | Whether **recognition** got worse | CI |
| Package audit | Whether a secret or operational data got into what ships | Inside the deploy |

Points observed in practice:

- Red does not get in. The gate runs in two independent layers.
- A change that improves the code and degrades recognition is blocked by a number, not by an opinion.
- An exception for a vulnerability with no available fix is granted with an **expiry date**. Once expired, the gate fails again.
- Pushing code to the repository publishes nothing. Deploy requires a manual trigger.
- On deploy failure, the previous version is preserved and rollback instructions are printed. The machine does not undo anything on its own.
- Automations that touch the server have restricted scope: they do not remove directories outside their own working area, do not restart third-party services, and do not delete operational state.
- Diagnostic tooling redacts username and password before printing any address. Verified by test.

---

## 5. Sensitive data

| Class | Examples | Destination |
|---|---|---|
| Internal | Non-sensitive code | Commercial-tier tool, no training |
| Confidential | Proprietary business logic | Commercial tier, no training |
| **Restricted** | **Secrets, credentials, `.env`, PII, customer data** | **Does not go to AI** |

- Free tiers of AI tooling train on the code submitted to them. For non-public code, the project uses commercial tiers with a contractual no-training commitment.
- There is a formal per-tool assessment with a verdict. One tool is barred for proprietary code (jurisdiction and telemetry).
- Credential files are kept out of the assistant's working directory and out of version control.
- Publishing secrets live in the CI platform's vault, scoped to the environment, with the server host key pinned.

---

## 6. Privacy in the product

- No image frame is persisted — neither in the relay nor in the analysis engine.
- Only indicators and metadata are stored.
- People are not identified: generic label, ephemeral identifier that disappears when they leave the scene.
- An automated test fails the build if a number reappears over a person's image.

---

## 7. Decisions that stayed with the architect

Open today by nature (product, ethics, budget) — not by technical limitation:

| # | Decision | Tension |
|---|---|---|
| 1 | Recognizing individual conduct (PPE) | Collides with the non-identification promise made in 6 documents |
| 2 | Storing visual evidence of a violation | Would require revoking the no-image-persistence rule |
| 3 | Approving the cost of manual annotation | Spend just to *find out* whether the accuracy is good enough |
| 4 | Numbers over the image | Two screens break the written rule; either the rule changes or they do |
| 5 | Red tile in a silenced zone | "The image is sovereign" vs. alarm fatigue |
| 6 | Box counting: occupancy or flow | "How many passed" may be physically unresolvable at the current cadence |

---

## 8. AI errors and how they surfaced

Seven real cases. All caught before causing harm.

| # | What the AI did | How it was caught | Outcome |
|---|---|---|---|
| 1 | Proposed raising the analysis resolution, citing a gain inherited from another context | Measurement on the evaluation set | Real gain 2.1 pp, cost +91% CPU, false positives on empty scenes 0 → 4. **Reverted** |
| 2 | Evaluated switching to a lighter model | Acceptance criteria written **before** measuring | Failed 2 of 3 criteria. **Discarded** |
| 3 | Wrote a manual deploy procedure | Architect's question: *"isn't there CI/CD in the repo?"* | Automated deploy already existed, and was safer. **Document rewritten** |
| 4 | Created a demo profile that disables alarm protections | Architect's question about the release package | The file would have shipped to production. **Locked out in two layers** |
| 5 | Claimed the system "did not measure" video frame age | The implementation itself | The measurement already existed in transit. **Claim corrected in the document** |
| 6 | Came one step from announcing "root cause found" for server failures | Measurement | Failures stopped after a restart; nothing in the release touched that path. **Published as "cause not established"** |
| 7 | Parallelized 4 work streams with automated agents | Architect's supervision | All 4 failed on infrastructure. Repository state checked (no partial writes). **Redone sequentially** |

Pattern across the seven cases:

- 3 were caught by **measurement**.
- 2 were caught by an **architect's question**.
- 1 by the **implementation itself** contradicting the earlier claim.
- 1 by **supervision** of execution.

---

## 9. Traceability

- Every commit states the intent and the reason.
- AI participation is marked in the history (`Co-Authored-By`) — authorship stays auditable afterwards.
- Every close-out declares the **residual**: what was not covered.
- Measurement and inference appear separately in the documents. A measured number and an estimated number are never presented as equivalent.
- Proportions are reported with sample size and confidence interval. The isolated point estimate is not published on its own.

---

## 10. Limits of what is known today

| Item | State |
|---|---|
| Perceived latency | **Not measured** in the field. Requires a stopwatch on a real scene |
| Accuracy in crowded scenes | **Not validated**. All measurements come from scenes with few people |
| Staging environment security | 2 open items (database password and auth secret rotation) |
| Alert thresholds in use | Some are **chosen** values, not calibrated against field data. Marked as such in the code |
