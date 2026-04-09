FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 20120

CMD ["node", "server.js"]
