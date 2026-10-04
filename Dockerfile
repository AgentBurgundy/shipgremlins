FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/shipgremlins
COPY package.json package-lock.json ./
# tsx is a runtime dependency; the image does not need the test/lint toolchain.
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY bin ./bin
COPY prompts ./prompts
COPY projects/_templates ./projects/_templates
COPY site/dist ./site/dist
COPY docs ./docs
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production SHIPGREMLINS_HOME=/data
USER node
VOLUME ["/data"]
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4310/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "bin/shipgremlins.mjs"]
CMD ["serve", "--host", "0.0.0.0", "--port", "4310"]
