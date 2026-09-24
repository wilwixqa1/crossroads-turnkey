# The Crossroads image that runs in ROFL. Built and pushed by the deploy workflow, never by hand.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY public ./public
# Compiles the server and bundles the page into public/app.js (which is not in git).
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
LABEL org.opencontainers.image.source=https://github.com/wilwixqa1/crossroads-turnkey
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
EXPOSE 8080
CMD ["node", "dist/server.js"]
