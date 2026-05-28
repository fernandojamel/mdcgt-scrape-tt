// calibrate.js
//
// Roda Playwright em modo "headed" (browser visível), loga no T&T e
// pausa pra você navegar até a página dos funcionários e identificar:
//   - URL da lista de funcionários
//   - Como cada funcionário expõe "Espelho Prévia" (link, botão, menu)
//   - Como o PDF é gerado (download direto ou abre nova aba)

import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

loadDotEnv();

const TT_EMAIL = process.env.TT_EMAIL;
const TT_PASSWORD = process.env.TT_PASSWORD;
if (!TT_EMAIL || !TT_PASSWORD) {
  console.error("Defina TT_EMAIL e TT_PASSWORD no .env");
  process.exit(1);
}

const LOGIN_URL = "https://admin.tiquetaque.app/";

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  console.log("[calibrate] abrindo login…");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  console.log("[calibrate] preenchendo credenciais…");
  await page.getByLabel(/e-?mail/i).fill(TT_EMAIL);
  await page.getByLabel(/senha/i).fill(TT_PASSWORD);
  await page.getByRole("button", { name: /entrar/i }).click();

  await page.waitForURL((url) => !url.toString().includes("/login"), {
    timeout: 30_000,
  }).catch(() => {
    console.log("[calibrate] não detectei redirect — segue mesmo assim");
  });

  console.log("[calibrate] logado. URL atual:", page.url());
  console.log("\n=== INSTRUÇÕES DE CALIBRAÇÃO ===");
  console.log("1. Navegue até a lista de funcionários (Gestão de Ponto).");
  console.log("2. Anote a URL exata da lista.");
  console.log("3. Clique no PRIMEIRO funcionário e ache 'Espelho Prévia'.");
  console.log("4. Anote como o PDF é gerado (botão? nova aba? URL?).");
  console.log("5. Use 'Pick locator' no Inspector pra pegar seletores.");
  console.log("6. Quando terminar, feche o browser pra encerrar o script.\n");

  await page.pause();

  await browser.close();
})().catch((err) => {
  console.error("[calibrate] erro:", err);
  process.exit(1);
});

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}
