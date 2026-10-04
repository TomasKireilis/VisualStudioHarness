FROM node:22-bookworm
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY templates/demo/ /opt/aiwork/demo/
COPY docker/exec.mjs docker/prepare.mjs /opt/aiwork/
WORKDIR /opt/aiwork/demo
RUN npm install --no-audit --no-fund && node node_modules/@playwright/test/cli.js install --with-deps chromium && node check.mjs
WORKDIR /workspace
CMD ["node", "-e", "setInterval(() => {}, 2147483647)"]
