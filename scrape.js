// scrape.js
//
// Pipeline diário (rodado por EasyPanel Cron Job):
//   1. Login no admin.tiquetaque.app (email/senha).
//   2. Vai pra lista "Espelho de Ponto" do ciclo aberto.
//   3. Pra cada funcionário, clica em "Ver espelho" → "+ Ações" →
//      "Salvar prévia em PDF" e baixa o PDF.
//   4. POST do PDF em
//      ${SUPABASE_URL}/functions/v1/auto-import-ponto-pdf
//
// A Edge Function se encarrega de parse + upsert idempotente no banco.

import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

loadDotEnv();

const TT_EMAIL = req("TT_EMAIL");
const TT_PASSWORD = req("TT_PASSWORD");
const SUPABASE_URL = req("SUPABASE_URL").replace(/\/$/, "");
const SUPABASE_KEY = req("SUPABASE_ANON_KEY");
const HEADLESS = (process.env.HEADLESS ?? "true").toLowerCase() !== "false";
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || "./downloads");

const LOGIN_URL = "https://admin.tiquetaque.app/";
const LISTING_URL =
  "https://admin.tiquetaque.app/time-closures?partial=true&period=current&periodFilter=true";

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Modo loop: container fica vivo, scrape roda a cada INTERVAL_HOURS.
// Default 6h (= 4x/dia). Setar INTERVAL_HOURS=0 desativa o loop e roda
// uma única vez (útil pra teste local com `npm run scrape`).
const INTERVAL_HOURS = Number(process.env.INTERVAL_HOURS ?? "6");

async function runOnce() {
  const startedAt = new Date();
  console.log(`[scrape] start ${startedAt.toISOString()} headless=${HEADLESS}`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();

  try {
    await login(page);

    // Vai pra lista e aplica filtros: todos empregadores marcados,
    // inativos excluídos (toggle off — já é o default).
    await goToListingComFiltros(page);
    const total = await page.getByRole("link", { name: /ver espelho/i }).count();
    console.log(`[scrape] ${total} funcionários na lista`);

    let ok = 0, fail = 0;
    for (let i = 0; i < total; i++) {
      // Sempre volta pra lista no início da iteração (estado limpo + filtros).
      await goToListingComFiltros(page);
      const linkLocator = page.getByRole("link", { name: /ver espelho/i }).nth(i);
      // Captura o nome do funcionário da mesma linha (primeira td).
      const nome = await linkLocator
        .locator("xpath=ancestor::tr//td[1]")
        .innerText()
        .then((s) => s.trim())
        .catch(() => `funcionario_${i}`);

      try {
        const pdfPath = await downloadEspelhoPrevia(page, linkLocator, nome);
        await uploadToSupabase(pdfPath, nome);
        ok++;
      } catch (e) {
        fail++;
        console.error(`[scrape] FALHA ${nome}:`, e.message);
      }
    }
    console.log(`[scrape] done: ok=${ok} fail=${fail} de ${total}`);
  } finally {
    await browser.close();
  }
}

(async () => {
  if (INTERVAL_HOURS <= 0) {
    // One-shot (teste local).
    await runOnce();
    return;
  }
  // Loop: roda, dorme INTERVAL_HOURS, repete.
  // Falhas pontuais são logadas mas não derrubam o loop.
  while (true) {
    try {
      await runOnce();
    } catch (err) {
      console.error("[scrape] erro no run:", err);
    }
    const sleepMs = INTERVAL_HOURS * 60 * 60 * 1000;
    const wakeAt = new Date(Date.now() + sleepMs).toISOString();
    console.log(`[scrape] sleeping ${INTERVAL_HOURS}h até ${wakeAt}…`);
    await new Promise((r) => setTimeout(r, sleepMs));
  }
})().catch((err) => {
  console.error("[scrape] erro fatal:", err);
  process.exit(1);
});

// ===================== Steps =====================

/// Navega pra lista e garante filtros: empregadores TODOS marcados,
/// inativos NÃO incluídos. Como o T&T pode preservar o estado entre
/// navegações, fazemos isso em toda iteração pra ser idempotente.
async function goToListingComFiltros(page) {
  await page.goto(LISTING_URL, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: /ver espelho/i }).first()
    .waitFor({ timeout: 30_000 });

  // Abre dropdown Empregador e marca "Selecionar todos" se não estiver.
  try {
    await page.getByRole("button", { name: /^empregador$/i }).click({ timeout: 5000 });
    const selectAll = page.getByText(/selecionar todos/i).first();
    await selectAll.waitFor({ state: "visible", timeout: 5000 });
    // Clica só se ainda não estiver marcado (clique alterna). Como não
    // dá pra inspecionar o checkbox interno facilmente, sempre clicamos
    // 2x se necessário pra ficar marcado — mas isso pode desmarcar.
    // Estratégia: marcar 1x; se a contagem da tabela diminuir, é sinal
    // que desmarcou — desfaz clicando 1x mais.
    const totalAntes = await page.getByRole("link", { name: /ver espelho/i }).count();
    await selectAll.click();
    // Fecha dropdown clicando no botão de novo ou pressionando Escape.
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(800);
    const totalDepois = await page.getByRole("link", { name: /ver espelho/i }).count();
    if (totalDepois < totalAntes) {
      // Click desmarcou — clica de novo pra marcar.
      await page.getByRole("button", { name: /^empregador$/i }).click({ timeout: 5000 });
      await selectAll.waitFor({ state: "visible", timeout: 5000 });
      await selectAll.click();
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(800);
    }
  } catch {
    // se não tiver dropdown ou já estiver tudo certo, segue.
  }

  // Garante que a tabela carregou após filtros.
  await page.getByRole("link", { name: /ver espelho/i }).first()
    .waitFor({ timeout: 15_000 });
}

async function login(page) {
  console.log("[scrape] login…");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.getByLabel(/e-?mail/i).fill(TT_EMAIL);
  await page.getByLabel(/senha/i).fill(TT_PASSWORD);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL((url) => !url.toString().includes("/login"), {
    timeout: 30_000,
  });
  // Pode aparecer um modal de boas-vindas/onboarding — fecha se existir.
  await page.locator('[aria-label="Fechar"], button:has-text("×")')
    .first()
    .click({ timeout: 2000 })
    .catch(() => {});
  console.log("[scrape] logado");
}

async function downloadEspelhoPrevia(page, linkLocator, nome) {
  console.log(`[scrape] → ${nome}`);
  await linkLocator.click();
  // Espera a tela de detalhe carregar (procura pelo botão Ações).
  await page.getByRole("button", { name: /a[çc][õo]es/i })
    .waitFor({ timeout: 20_000 });

  // Abre menu Ações e espera o item do menu aparecer.
  await page.getByRole("button", { name: /a[çc][õo]es/i }).click();
  const menuItem = page.getByText(/salvar pr[eé]via em pdf/i);
  await menuItem.waitFor({ state: "visible", timeout: 10_000 });
  await menuItem.click();

  // Abre um modal "Prévia do espelho de ponto" com botão Confirmar.
  // O download só dispara após clicar em Confirmar.
  const confirmButton = page.getByRole("button", { name: /^confirmar$/i });
  await confirmButton.waitFor({ state: "visible", timeout: 10_000 });

  // Captura: download OU popup (nova aba). Listeners antes do click.
  const ctx = page.context();
  const downloadPromise = page.waitForEvent("download", { timeout: 45_000 })
    .then((d) => ({ kind: "download", data: d }))
    .catch(() => null);
  const popupPromise = ctx.waitForEvent("page", { timeout: 45_000 })
    .then((p) => ({ kind: "popup", data: p }))
    .catch(() => null);

  await confirmButton.click();

  // Resolve com o PRIMEIRO evento que disparar (não null).
  const realEvent = await new Promise((resolve) => {
    downloadPromise.then((v) => v && resolve(v));
    popupPromise.then((v) => v && resolve(v));
    Promise.all([downloadPromise, popupPromise]).then(() => resolve(null));
  });

  if (!realEvent) {
    const shot = path.join(DOWNLOAD_DIR, `_FALHA_${nome.replace(/[^a-zA-Z0-9]/g, "_")}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    throw new Error(`nem download nem popup dispararam (screenshot: ${shot})`);
  }

  const safeName = nome.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const filename = `${safeName}_${Date.now()}.pdf`;
  const dest = path.join(DOWNLOAD_DIR, filename);

  if (realEvent.kind === "download") {
    await realEvent.data.saveAs(dest);
    return dest;
  }
  {
    const popup = realEvent.data;
    // PDF abriu em nova aba — pega o URL e baixa via fetch.
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    const pdfUrl = popup.url();
    console.log(`[scrape]   PDF em popup: ${pdfUrl}`);
    // Usa a sessão (cookies) do contexto pra baixar o PDF.
    const response = await ctx.request.get(pdfUrl);
    if (!response.ok()) {
      throw new Error(`Falha ao baixar PDF do popup: HTTP ${response.status()}`);
    }
    const buf = await response.body();
    fs.writeFileSync(dest, buf);
    await popup.close().catch(() => {});
    return dest;
  }
}

async function uploadToSupabase(pdfPath, funcionarioNome) {
  const bytes = fs.readFileSync(pdfPath);
  const url = `${SUPABASE_URL}/functions/v1/auto-import-ponto-pdf`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "apikey": SUPABASE_KEY,
    },
    body: bytes,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`auto-import HTTP ${res.status}: ${text}`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  console.log(
    `[scrape]   OK cpfs=${parsed.cpfs?.length ?? 0} dias=${parsed.dias_inseridos ?? 0}`,
  );
  fs.unlinkSync(pdfPath); // não acumula arquivos
}

// ===================== Utils =====================

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Env var obrigatória ausente: ${name}`);
    process.exit(1);
  }
  return v;
}

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
