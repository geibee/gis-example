FROM docker.io/library/node:22-alpine AS build

WORKDIR /repo
COPY package.json package-lock.json ./
COPY contracts/feedback/package.json contracts/feedback/package.json
COPY packages/feedback-core/package.json packages/feedback-core/package.json
COPY packages/feedback-react/package.json packages/feedback-react/package.json
COPY apps/feedback-conformance-consumer/package.json apps/feedback-conformance-consumer/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund --workspace @feedback/contracts --workspace @feedback/core --workspace @feedback/react \
    --workspace @feedback/conformance-consumer --include-workspace-root=false
COPY contracts/feedback contracts/feedback
COPY packages/feedback-core packages/feedback-core
COPY packages/feedback-react packages/feedback-react
COPY apps/feedback-conformance-consumer apps/feedback-conformance-consumer
RUN npm --workspace @feedback/contracts run build \
    && npm --workspace @feedback/core run build \
    && npm --workspace @feedback/react run build \
    && npm --workspace @feedback/conformance-consumer run build

FROM docker.io/library/node:22-alpine
WORKDIR /app
COPY --from=build /repo/apps/feedback-conformance-consumer/dist ./dist
COPY --from=build /repo/apps/feedback-conformance-consumer/build/server ./server-dist
USER node
EXPOSE 8080
CMD ["node", "server-dist/server.js"]
