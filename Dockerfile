# ApexWeb OS core. Node >= 22.18 runs the TypeScript sources directly (type
# stripping), so there is no build step.
FROM node:22-bookworm-slim

# git: project snapshots/rollback. chromium: rendered checks (visual QA,
# responsive, axe, performance). Without chromium those checks report
# "not evaluated" instead of failing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git chromium fonts-liberation fonts-noto-color-emoji ca-certificates tar \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    APEXWEB_DATA_DIR=/data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.ts"]
