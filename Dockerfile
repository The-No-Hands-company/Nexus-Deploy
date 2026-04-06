# ── Stage 1: Build React dashboard ────────────────────────────────────────
FROM node:22-alpine AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# ── Stage 2: Build TypeScript server ──────────────────────────────────────
FROM node:22-alpine AS server-build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
COPY routes/ ./routes/
RUN npm run build:server

# ── Stage 3: Production image ──────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# Install docker CLI + git + nixpacks for the build engine
RUN apk add --no-cache docker-cli git curl bash \
  && curl -sSL https://nixpacks.com/install.sh | bash

ENV NODE_ENV=production
ENV DATA_DIR=/workspace

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=server-build /app/dist ./dist
COPY --from=web-build /app/web/dist ./web/dist

VOLUME ["/workspace"]
EXPOSE 3000

CMD ["node", "dist/index.js"]
