# Agent Marketplace backend for Cloud Run (or any container host).
# Cloud Run runs linux/amd64: build with `gcloud run deploy --source .` (Cloud Build),
# or locally with `docker build --platform linux/amd64 .`.
# Configuration comes from the environment at run time; see src/server.ts. No secret is baked in.

ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY supabase ./supabase
# Run the full suite in the build: an image is only produced from code that passes.
RUN npm run check

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_CA_FILE=/app/certs/prod-ca-2021.crt
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
COPY supabase/prod-ca-2021.crt ./certs/prod-ca-2021.crt
USER node
EXPOSE 8080
CMD ["node", "dist/src/server.js"]
