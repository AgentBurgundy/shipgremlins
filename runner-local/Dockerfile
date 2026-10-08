FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/opt/gremlins/browsers
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git gh curl jq openssh-client python3 python3-pip python3-venv make g++ \
    && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) GLAB_SHA=4e6c59de9f7ed2f304bf93aad01ea8f8a69584f0450ce90ad696ef81f69c69aa ;; \
      arm64) GLAB_SHA=c60ebb4cb36f276714847a118845b9b4e69f46a8080c68b21ca63f158722cdea ;; \
      *) exit 1 ;; \
    esac \
    && curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
       "https://gitlab.com/gitlab-org/cli/-/releases/v1.120.0/downloads/glab_1.120.0_linux_${TARGETARCH}.tar.gz" -o /tmp/glab.tar.gz \
    && echo "$GLAB_SHA  /tmp/glab.tar.gz" | sha256sum --check --status \
    && mkdir /tmp/glab && tar -xzf /tmp/glab.tar.gz -C /tmp/glab \
    && install /tmp/glab/bin/glab /usr/local/bin/glab \
    && rm -rf /tmp/glab /tmp/glab.tar.gz
WORKDIR /opt/gremlins
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npx --no-install playwright install --with-deps chromium \
    && ln -s /opt/gremlins/node_modules/.bin/claude /usr/local/bin/claude \
    && chmod -R a+rX /opt/gremlins \
    && rm -rf /var/lib/apt/lists/* /root/.npm
COPY *.mjs ./
COPY git-askpass.sh /opt/gremlins/git-askpass.sh
RUN chmod 644 /opt/gremlins/*.mjs \
    && chmod 755 /opt/gremlins/git-askpass.sh \
    && mkdir -p /work/home /output \
    && chown -R node:node /work /output \
    && git config --system user.name ShipGremlins \
    && git config --system user.email gremlins@shipgremlins.ai
ENV HOME=/work/home NODE_PATH=/opt/gremlins/node_modules
USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/gremlins/job.mjs"]
