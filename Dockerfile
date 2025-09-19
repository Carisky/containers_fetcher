FROM node:20-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ libfbclient2 \
 && npm ci
COPY . .
RUN mkdir -p lib/fbclient \
 && cp /usr/lib/x86_64-linux-gnu/libfbclient.so.2 lib/fbclient/libfbclient.so \
 && npm run build

FROM node:20-bookworm
WORKDIR /app
COPY package*.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ libfbclient2 \
 && npm ci --omit=dev \
 && mkdir -p lib/fbclient \
 && cp /usr/lib/x86_64-linux-gnu/libfbclient.so.2 lib/fbclient/libfbclient.so \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=build /app/lib ./lib
EXPOSE 3400
CMD ["node", "dist/server.js"]
