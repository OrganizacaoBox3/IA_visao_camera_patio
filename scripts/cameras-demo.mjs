// cameras-demo.mjs — gera URLs de câmeras REAIS prontas para colar na UI "+ Câmera IP".
//
// Uso:
//   node scripts/cameras-demo.mjs                      # resolve o catálogo embutido
//   node scripts/cameras-demo.mjs "<url-youtube-live>" # resolve QUALQUER live do YouTube
//
// As URLs do YouTube são resolvidas para HLS na hora (elas EXPIRAM ~6h — é só rodar de novo
// para renovar). As URLs "diretas" são sempre-online. Copie a URL impressa e cole em
// Central → "+ Câmera IP" (transporte TCP). Requer: node; yt-dlp e ffmpeg (auto-detectados
// mesmo fora do PATH — instale com `winget install yt-dlp.yt-dlp` e `winget install Gyan.FFmpeg`).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ── Catálogo (cena qualquer — o objetivo é validar acesso a câmera real via rede) ──
// WhatsUpCams (HLS público, sem token). Se alguma der 404, o slug pode ter migrado de CDN:
// teste o mesmo slug em cdn-001…cdn-008.whatsupcams.com. Verificadas em 2026-07-02.
const DIRECT = [
  {
    label: "Nova Gorica (SI) — Bevkov trg (praça central, pedestres)",
    url: "https://cdn-006.whatsupcams.com/hls/si_ngbevkovtrg.m3u8",
  },
  {
    label: "Gorizia (IT) — Piazza Vittoria (praça, pedestres/ciclistas/carros)",
    url: "https://cdn-008.whatsupcams.com/hls/it_gorizia06.m3u8",
  },
  {
    label: "Pula (HR) — rua do centro (pedestres)",
    url: "https://cdn-004.whatsupcams.com/hls/hr_pula01.m3u8",
  },
  {
    label: "Mošćenička Draga (HR) — centro à beira-mar (pedestres)",
    url: "https://cdn-007.whatsupcams.com/hls/hr_mdraga04.m3u8",
  },
  {
    label: "Bled (SI) — lago, panorâmica (movimento ao longe)",
    url: "https://cdn-001.whatsupcams.com/hls/si_bled1.m3u8",
  },
  {
    label: "Mux BBB (teste de pipeline, sempre-online, cena sintética)",
    url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
  },
];
// YouTube lives (câmeras reais 24/7, pedestres). Nem todas estarão no ar sempre — o script pula
// as offline. IDs rotacionam quando o canal reinicia a live; URLs de canal com /live são um
// ponteiro estável para "a live atual" do canal. Lista revisada em 2026-07-02.
const YOUTUBE = [
  { label: "Times Square, NYC — Crossroads (pedestres, EarthCam)", id: "z-jYdOIKcTQ" },
  { label: "Dublin — Temple Bar (pedestres, EarthCam)", id: "3nyPER2kzqk" },
  { label: "Shibuya Scramble Crossing, Tóquio (ANN)", id: "8H3nRCFVR6Y" },
  { label: "Shibuya Scramble Crossing, Tóquio (alternativa)", id: "dfVK7ld38Ys" },
  {
    label: "Shinjuku Kabukicho, Tóquio (ponteiro /live do canal)",
    id: "https://www.youtube.com/channel/UChKERpE7Um0Uq1btm_a9g5A/live",
  },
  { label: "Porto de Santos (contêineres/navios)", id: "tMYtrEBNVAU" },
];

// ── Resolução de binários independente do PATH (winget/choco/scoop no Windows) ──
function resolveBin(name, matchers) {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return name;
  } catch {
    /* não está no PATH */
  }
  if (process.platform === "win32") {
    const roots = [];
    const local = process.env.LOCALAPPDATA;
    if (local) roots.push(path.join(local, "Microsoft", "WinGet", "Packages"));
    for (const root of roots) {
      let dirs;
      try {
        dirs = fs.readdirSync(root);
      } catch {
        continue;
      }
      for (const d of dirs) {
        if (!matchers.pkg.test(d)) continue;
        const found = findExe(path.join(root, d), matchers.exe, 4);
        if (found) return found;
      }
    }
    const extra = [
      "C:\\ProgramData\\chocolatey\\bin\\" + matchers.bin,
      process.env.USERPROFILE && path.join(process.env.USERPROFILE, "scoop", "shims", matchers.bin),
    ].filter(Boolean);
    for (const c of extra) if (fs.existsSync(c)) return c;
  }
  return null;
}
function findExe(dir, exeRe, depth) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && exeRe.test(e.name)) return p;
    if (e.isDirectory()) {
      const r = findExe(p, exeRe, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

const YTDLP = resolveBin("yt-dlp", { pkg: /^yt-dlp/i, exe: /^yt-dlp\.exe$/i, bin: "yt-dlp.exe" });
const FFPROBE = resolveBin("ffprobe", {
  pkg: /^Gyan\.FFmpeg/i,
  exe: /^ffprobe\.exe$/i,
  bin: "ffprobe.exe",
});

function resolveYoutube(id) {
  if (!YTDLP) return null;
  const url = /^https?:/i.test(id) ? id : `https://www.youtube.com/watch?v=${id}`;
  try {
    const out = execFileSync(
      YTDLP,
      ["-q", "--no-warnings", "-f", "b[protocol*=m3u8]/best", "-g", url],
      { encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}
function probe(url) {
  if (!FFPROBE) return "";
  try {
    const out = execFileSync(
      FFPROBE,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        url,
      ],
      { encoding: "utf8", timeout: 25000 },
    );
    const [w, h] = out.trim().split(/\r?\n/)[0].split(",");
    return w && h ? `${w}x${h}` : "";
  } catch {
    return "";
  }
}

// ── Execução ──
const args = process.argv.slice(2);
console.log('\nCâmeras — cole a URL na Central → "+ Câmera IP" (transporte TCP).\n');
if (!YTDLP) console.log("⚠️  yt-dlp não encontrado — instale com: winget install yt-dlp.yt-dlp\n");

if (args.length) {
  console.log("AO VIVO (do argumento):");
  for (const a of args) {
    const u = resolveYoutube(a);
    if (u) console.log(`  [${probe(u) || "?"}] ${a}\n    ${u}\n`);
    else console.log(`  [offline/indisponível] ${a}\n`);
  }
} else {
  console.log("DIRETO (sempre-online):");
  for (const c of DIRECT) console.log(`  [${probe(c.url) || "OK"}] ${c.label}\n    ${c.url}\n`);
  console.log("AO VIVO (YouTube → HLS, EXPIRA ~6h — rode de novo para renovar):");
  for (const c of YOUTUBE) {
    const u = resolveYoutube(c.id);
    if (u) console.log(`  [${probe(u) || "OK"}] ${c.label}\n    ${u}\n`);
    else console.log(`  [offline agora] ${c.label} (id ${c.id})\n`);
  }
}
console.log("Dica: passe seu próprio link — node scripts/cameras-demo.mjs <url-youtube-live>\n");
