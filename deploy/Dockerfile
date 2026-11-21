FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY shared ./shared
COPY desktop ./desktop
COPY server ./server
COPY scripts/build-server.mjs ./scripts/build-server.mjs
RUN node scripts/build-server.mjs && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates libfontconfig1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-server ./dist-server
COPY package.json ./package.json
RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 FFPROBE_PATH=/usr/bin/ffprobe CLOUD_DATA_DIR=/app/.data
EXPOSE 8787
CMD ["node", "dist-server/index.mjs"]
