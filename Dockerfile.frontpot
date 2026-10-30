# syntax=docker/dockerfile:1
# Maps are unchanged upstream assets. Fetch the pinned archive in the builder
# instead of exceeding Railway's CLI upload limit with the full map library.
FROM node:24.15.0-bookworm-slim AS maps
WORKDIR /maps
ADD --checksum=sha256:346243f6c470b4823ed04cb3194cea08e81e868e743af4138e577a0569f4cdc8 https://codeload.github.com/openfrontio/OpenFrontIO/tar.gz/d1f236242864f506a040f2d56cc5ddd41bf27612 /tmp/upstream.tar.gz
RUN tar -xzf /tmp/upstream.tar.gz --strip-components=3 -C /maps OpenFrontIO-d1f236242864f506a040f2d56cc5ddd41bf27612/resources/maps && rm /tmp/upstream.tar.gz

# Dedicated image for the wallet-matchmaking demo, not the upstream deployment.
FROM node:24.15.0-bookworm-slim AS dependencies
WORKDIR /app
ENV HUSKY=0 NPM_CONFIG_IGNORE_SCRIPTS=true
RUN npm install --global --ignore-scripts npm@12.1.0
COPY package.json package-lock.json .npmrc ./
COPY packages/engine/package.json ./packages/engine/
COPY packages/engine-api/package.json ./packages/engine-api/
COPY packages/engine-lib/package.json ./packages/engine-lib/
COPY packages/shared/package.json ./packages/shared/
COPY packages/zbin/package.json ./packages/zbin/
RUN npm ci --ignore-scripts

FROM dependencies AS builder
COPY . .
COPY --from=maps /maps ./resources/maps
RUN npm run build:demo
# Prune in a separate stage so cached build dependencies stay available.
FROM dependencies AS production-dependencies
# Browser wallet SDKs are already compiled into dist-demo, never imported by the server.
RUN npm pkg delete 'dependencies.@privy-io/react-auth' 'dependencies.@stripe/stripe-js' 'dependencies.react' 'dependencies.react-dom' \
    && npm prune --omit=dev --ignore-scripts

# Only runtime dependencies, server sources and served assets enter the image.
FROM node:24.15.0-bookworm-slim AS runtime
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/package-lock.json /app/tsconfig.json /app/tsconfig.base.json ./
COPY --from=builder /app/LICENSE /app/LICENSE-ASSETS /app/LICENSING.md /app/CREDITS.md ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/src ./src
COPY --from=builder /app/resources ./resources
COPY --from=builder /app/dist-demo ./dist-demo
ENV NODE_ENV=production GAME_ENV=dev NUM_WORKERS=1 DOMAIN=localhost GIT_COMMIT=DEV HOST=0.0.0.0 PAYMENTS_MODE=simulation FRONTPOT_STATE_DIR=/data/frontpot
CMD ["node", "--import", "tsx", "src/frontpot/Server.ts"]
