FROM node:22-bookworm-slim
WORKDIR /opt/shipgremlins
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY bin ./bin
COPY dashboard ./dashboard
COPY runner-local ./runner-local
COPY projects/_templates ./projects/_templates
COPY examples/dashboard-test ./examples/dashboard-test
ENV SHIPGREMLINS_DASHBOARD_FIXTURE=1 PORT=3000
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "examples/dashboard-test/server.mjs"]
