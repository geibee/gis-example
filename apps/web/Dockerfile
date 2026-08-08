FROM node:22-alpine AS build

WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/feedback-plugin/package.json packages/feedback-plugin/package.json
RUN npm ci
COPY apps/web apps/web
COPY packages/feedback-plugin packages/feedback-plugin
# OIDC の接続先はビルド時に bundle へ焼き込まれる (import.meta.env)。
# 本番ビルドでは --build-arg で IdP の HTTPS URL を渡すこと。
# 未指定 (dev) では ARG が環境変数として存在しないため、src/auth.ts の localhost 既定が使われる
ARG VITE_OIDC_AUTHORITY
ARG VITE_OIDC_CLIENT_ID
RUN npm --workspace @web-gis/feedback-plugin run build
RUN npm --workspace apps/web run build

FROM nginx:1.27-alpine

# CSP の connect-src に加える環境依存の接続先 (OIDC IdP の origin 等)。
# 本番ビルドでは --build-arg CSP_CONNECT_SRC_EXTRA="https://auth.example.com" のように
# VITE_OIDC_AUTHORITY の origin と揃えて渡すこと。既定は dev の Keycloak
ARG CSP_CONNECT_SRC_EXTRA="http://localhost:8081"

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
RUN sed -i "s|__CSP_CONNECT_SRC_EXTRA__|${CSP_CONNECT_SRC_EXTRA}|g" /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
