# scrape-tt — Automação diária das Prévias do Tique & Taque

Container Docker que roda 1x por dia no EasyPanel (modo Cron Job),
loga no painel admin do T&T, baixa o "Espelho Prévia" PDF de cada
funcionário e dispara a Edge Function `auto-import-ponto-pdf` no
Supabase pra gravar no banco.

## Arquitetura

```
EasyPanel Cron (06:00 BRT)
  └─ scrape.js (Playwright)
       ├─ login admin.tiquetaque.app
       ├─ lista funcionários
       └─ pra cada um:
            ├─ download PDF Prévia
            └─ POST → Supabase Edge Function
                       └─ auto-import-ponto-pdf
                            ├─ chama parse-ponto-pdf (interno)
                            └─ upsert idempotente em
                               ponto_fechamento + ponto_funcionario_mes
                               + ponto_dia
```

## Pré-requisitos

- Conta no EasyPanel (já tem — `n8n-automacao-n8n-hastag.uar6xg.easypanel.host`).
- Edge Functions já deployadas:
  - `parse-ponto-pdf`
  - `auto-import-ponto-pdf` (criada nesta tarefa)
- Migration `0013_ponto_dia.sql` aplicada.

## Passo a passo

### 1. Calibrar selectors (LOCAL, uma vez)

O script `scrape.js` tem 3 pontos marcados como `TODO CALIBRAÇÃO` que
precisam dos selectors reais do painel T&T:

1. URL da lista de funcionários (após login).
2. Selector que identifica CADA linha de funcionário.
3. Selector do botão/link que dispara "Espelho Prévia".

Pra descobrir:

```bash
cd automacao/scrape-tt
cp .env.example .env   # preencha TT_EMAIL e TT_PASSWORD
npm install
npm run calibrate
```

O browser abre, faz login automaticamente e pausa. O Playwright
Inspector aparece — use ele pra clicar nos elementos e ver os selectors
sugeridos. Anote os 3 valores e edite `scrape.js` substituindo os TODOs.

### 2. Testar localmente

Com os selectors preenchidos:

```bash
HEADLESS=false npm run scrape
```

Você vê o browser executando a rotina inteira. Confere no app MDCGT
(página Espelho Diário) se os dados de hoje apareceram.

### 3. Subir pro git (GitHub/GitLab)

EasyPanel deploya containers a partir de um repo git. Coloque tudo
dentro do repo MDCGT (na pasta `automacao/scrape-tt/`).

> **Nunca commite `.env`** (já está no `.dockerignore` e deveria estar
> no `.gitignore` da raiz). As secrets vão direto no EasyPanel.

### 4. Deploy no EasyPanel

1. Crie um novo **Service** no EasyPanel.
2. Tipo: **App** (não "Cron Job" ainda — primeiro deploy normal pra
   garantir build OK).
3. Source: GitHub (aponta pro repo MDCGT, branch principal,
   build path = `automacao/scrape-tt/`).
4. **Environment**:
   - `TT_EMAIL` → seu email do T&T
   - `TT_PASSWORD` → sua senha do T&T
   - `SUPABASE_URL` → URL do projeto Supabase
   - `SUPABASE_SERVICE_ROLE_KEY` → service_role key (Supabase Dashboard
     → Project Settings → API → service_role secret)
   - `HEADLESS=true`
5. **Deploy** — confira no log que o build do Dockerfile passou.
6. Rode manualmente uma vez (botão "Run" ou similar) e confira que o
   script terminou com `done: ok=N fail=0`.
7. Converta o service em **Cron Job**:
   - Schedule recomendado: `0 9 * * *` (todo dia 06:00 BRT = 09:00 UTC).
   - Ou outro horário onde T&T já consolidou as batidas do dia anterior.

### 5. Monitoramento

- Logs do container ficam no EasyPanel (aba "Logs" do service).
- Erros: o script termina com `process.exit(1)` em erro fatal — Cron
  Jobs do EasyPanel mostram falhas.
- Se ficar burro com Cloudflare/captcha do T&T, o login vai falhar e
  você vê no log.

## Segurança

- `.env` no `.gitignore`. Nunca commitado.
- Secrets do EasyPanel ficam criptografadas no painel.
- service_role do Supabase **só** existe aqui e nas Edge Functions —
  nunca no app Flutter (que usa só anon).
- Senha do T&T no EasyPanel: rotacione se desconfiar de vazamento;
  troque o env var e o próximo run usa a nova.

## Multi-loja

O T&T mistura funcionários das 2 lojas (Tijuca + Metropolitano) num
mesmo painel? Se sim, **NÃO** defina `TT_LOJA` — a Edge Function
infere via CNPJ do PDF.

Se cada loja tem login separado e você quer rodar 2 containers:
- Container A: `TT_EMAIL=tijuca@... TT_LOJA=Tijuca`
- Container B: `TT_EMAIL=met@... TT_LOJA=Metropolitano`

## Troubleshooting

| Sintoma | Causa provável |
|---|---|
| Login falha (timeout) | Cloudflare bloqueando container. Rode `HEADLESS=false` local pra inspecionar; pode precisar de `playwright-extra` + stealth plugin. |
| `0 funcionários encontrados` | Selector da lista mudou ou URL errada — rerun `npm run calibrate`. |
| HTTP 502 do auto-import | `parse-ponto-pdf` falhou. Checa os logs da Edge Function no Supabase. |
| HTTP 401 do auto-import | `SUPABASE_SERVICE_ROLE_KEY` errada/ausente. |
| `dias_inseridos=0` mas sem erro | PDF veio sem tabela diária (espelho diferente?). Conferir o PDF baixado. |
