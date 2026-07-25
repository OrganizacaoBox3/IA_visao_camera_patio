// Gate de segurança do verify: `npm audit` (high+) com ALLOWLIST EXPIRÁVEL.
// Racional: o npm audit não tem mecanismo nativo de exceção, e o único "fix" que ele
// oferece às vezes é um DOWNGRADE que reintroduz CVEs piores (caso react-router 2026-07-22:
// o fix do CSRF de modo RSC era voltar a 7.11, reabrindo XSS + open redirect corrigidos na
// 7.18.1). Uma exceção aqui exige: (a) justificativa de NÃO-APLICABILIDADE ao nosso uso,
// (b) DATA DE VALIDADE curta — venceu, o gate volta a falhar e força re-avaliação (a
// esperança é o backport upstream chegar antes). Enfraquecer o gate inteiro (--omit=dev,
// baixar o nível) está PROIBIDO — a allowlist é pontual e auditável no git.
import { execSync } from "node:child_process";

const ALLOWLIST = [
  {
    id: "GHSA-qwww-vcr4-c8h2",
    pkg: "react-router",
    reason:
      "CSRF do modo RSC (React Server Components) — inaplicável: app é SPA Vite client-side, " +
      "sem SSR/server actions/RSC. O 'fix' do npm é downgrade p/ 7.11 (reabre GHSA-wrjc-x8rr-h8h6 " +
      "e outros 3 corrigidos na 7.18.1). Aguardando backport 7.x do upstream.",
    expires: "2026-08-15",
  },
];

let report;
try {
  report = JSON.parse(execSync("npm audit --json --audit-level=high", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
} catch (e) {
  // npm audit sai !=0 quando há vulnerabilidades — o JSON vem no stdout mesmo assim
  if (!e.stdout) {
    console.error("[audit-gate] npm audit falhou sem JSON:", e.message);
    process.exit(1);
  }
  report = JSON.parse(e.stdout);
}

const now = new Date();
const vulns = report.vulnerabilities ?? {};
const failures = [];
for (const [name, v] of Object.entries(vulns)) {
  if (v.severity !== "high" && v.severity !== "critical") continue;
  // advisories via `via` (objetos = advisories diretas; strings = cadeia transitiva)
  const advisories = (v.via || []).filter((x) => typeof x === "object");
  const chainOnly = advisories.length === 0; // vulnerável só por depender de outro pacote listado
  if (chainOnly) continue; // o pacote-raiz da cadeia é quem decide
  const unexcused = advisories.filter((a) => {
    const rule = ALLOWLIST.find((r) => a.url && a.url.includes(r.id));
    if (!rule) return true;
    if (now > new Date(rule.expires)) {
      console.error(`[audit-gate] exceção ${rule.id} EXPIROU em ${rule.expires} — re-avalie (${rule.pkg})`);
      return true;
    }
    console.warn(`[audit-gate] exceção ativa: ${rule.id} (${name}) até ${rule.expires} — ${rule.reason.slice(0, 100)}…`);
    return false;
  });
  if (unexcused.length) failures.push({ name, severity: v.severity, advisories: unexcused.map((a) => a.url) });
}

if (failures.length) {
  console.error("[audit-gate] VULNERABILIDADES high/critical sem exceção:");
  for (const f of failures) console.error(`  ${f.name} (${f.severity}): ${f.advisories.join(", ")}`);
  process.exit(1);
}
console.log(`[audit-gate] OK — sem high/critical fora da allowlist (${ALLOWLIST.length} exceção(ões) documentada(s))`);
