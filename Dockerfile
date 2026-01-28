FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ libfbclient2 \
 && rm -rf /var/lib/apt/lists/* \
 && npm ci
COPY . .
RUN mkdir -p lib/fbclient \
 && cp /usr/lib/x86_64-linux-gnu/libfbclient.so.2 lib/fbclient/libfbclient.so \
 && npm run build \
 && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
ENV HEALTHCHECK_WATCHDOG_ENABLED=true
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends libfbclient2 \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/lib ./lib
EXPOSE 3400
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/server.js"]
