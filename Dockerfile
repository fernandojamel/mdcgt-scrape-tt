# Imagem oficial do Playwright já vem com Node 20, Chromium e libs.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Instala dependências primeiro pra aproveitar cache de layer.
COPY package.json ./
RUN npm install --omit=dev

# Copia o script.
COPY scrape.js ./
COPY calibrate.js ./

# Diretório dos PDFs (limpos a cada PDF processado, mas precisa existir).
RUN mkdir -p /app/downloads

ENV NODE_ENV=production
ENV HEADLESS=true
ENV DOWNLOAD_DIR=/app/downloads

# Default: roda o scrape. EasyPanel Cron Job vai invocar este comando
# conforme schedule (ex: 0 6 * * * = todo dia 06:00 BRT).
CMD ["node", "scrape.js"]
