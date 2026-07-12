FROM node:22.23.1-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts
RUN npm run build
RUN npm prune --omit=dev

FROM node:22.23.1-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
USER node
ENTRYPOINT ["node", "packages/node-http-host/dist/index.js"]
