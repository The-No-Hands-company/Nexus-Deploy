FROM node:22-alpine AS web-build
WORKDIR /app/web
COPY web/package.json web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/src ./src
RUN npm install && npm run build

FROM node:22-alpine AS server-build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY routes ./routes
RUN npm install && npm run build:server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=server-build /app/dist ./dist
COPY --from=web-build /app/web/dist ./web/dist
RUN npm install --omit=dev
EXPOSE 3000
CMD ["node", "dist/index.js"]
