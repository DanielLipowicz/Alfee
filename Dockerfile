FROM node:20.20.2-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 20120

CMD ["node", "server.js"]
