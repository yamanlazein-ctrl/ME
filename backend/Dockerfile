# Build context: the REPOSITORY ROOT (docker build -f backend/Dockerfile .).
# The backend imports @erp/shared from ../packages/shared (tsconfig paths, rootDir ".."),
# so the image mirrors the repo layout: /repo/backend + /repo/packages/shared.
FROM node:22-alpine AS build
WORKDIR /repo/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY packages/shared/ /repo/packages/shared/
# packages/shared imports zod etc.; locally they resolve from the workspace root node_modules.
RUN ln -s /repo/backend/node_modules /repo/node_modules
COPY backend/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /repo/backend
# tsc emits dist/backend/src/** and dist/packages/shared/** (rootDir ".."); tsc-alias rewrites
# @erp/shared to relative paths inside dist, so dist is self-contained next to node_modules.
COPY --from=build /repo/backend/dist ./dist
COPY --from=build /repo/backend/node_modules ./node_modules
COPY --from=build /repo/backend/package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/health/ready || exit 1
CMD ["node", "dist/backend/src/presentation/server.js"]
