FROM docker.io/library/node:22-alpine AS build

WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/feedback-admin/package.json apps/feedback-admin/package.json
COPY contracts/feedback/package.json contracts/feedback/package.json
COPY packages/feedback-core/package.json packages/feedback-core/package.json
COPY packages/feedback-admin-react/package.json packages/feedback-admin-react/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund --workspace @feedback/contracts --workspace @feedback/core \
    --workspace @feedback/admin-react --workspace @feedback/admin-console \
    --include-workspace-root=false
COPY apps/feedback-admin apps/feedback-admin
COPY contracts/feedback contracts/feedback
COPY packages/feedback-core packages/feedback-core
COPY packages/feedback-admin-react packages/feedback-admin-react

ARG VITE_FEEDBACK_API_BASE
ARG VITE_FEEDBACK_ADMIN_OIDC_AUTHORITY
ARG VITE_FEEDBACK_ADMIN_OIDC_CLIENT_ID
ARG VITE_FEEDBACK_ADMIN_OIDC_REDIRECT_URI
ARG VITE_FEEDBACK_ADMIN_OIDC_SCOPE
ARG FEEDBACK_ADMIN_APPLICATION
ARG FEEDBACK_ADMIN_ENVIRONMENT
ARG FEEDBACK_ADMIN_WORKSPACE

RUN export VITE_FEEDBACK_ADMIN_APPLICATION_KEY="$FEEDBACK_ADMIN_APPLICATION" \
    VITE_FEEDBACK_ADMIN_ENVIRONMENT_KEY="$FEEDBACK_ADMIN_ENVIRONMENT" \
    VITE_FEEDBACK_ADMIN_WORKSPACE_KEY="$FEEDBACK_ADMIN_WORKSPACE" \
    && npm --workspace @feedback/contracts run build \
    && npm --workspace @feedback/core run build \
    && npm --workspace @feedback/admin-react run build \
    && npm --workspace @feedback/admin-console run build

FROM docker.io/library/nginx:1.27-alpine

ARG CSP_CONNECT_SRC_EXTRA="http://localhost:8090 http://localhost:8081"
COPY apps/feedback-admin/nginx.conf /etc/nginx/conf.d/default.conf
RUN sed -i "s|__CSP_CONNECT_SRC_EXTRA__|${CSP_CONNECT_SRC_EXTRA}|g" /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/feedback-admin/dist /usr/share/nginx/html
EXPOSE 80
