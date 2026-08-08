# Feedback Admin Console

Feedback Service v1 のみを利用する独立管理 SPA。Web GIS の API、DB、router、権限体系には依存しない。

ローカルではリポジトリルートで `npm ci` を実行し、必要な公開設定を指定して起動する。

```bash
VITE_FEEDBACK_API_BASE=http://localhost:8090/feedback/v1 \
VITE_FEEDBACK_ADMIN_OIDC_AUTHORITY=http://localhost:8081/realms/gis \
VITE_FEEDBACK_ADMIN_OIDC_CLIENT_ID=feedback-admin \
VITE_FEEDBACK_ADMIN_APPLICATION_KEY=web-gis \
VITE_FEEDBACK_ADMIN_ENVIRONMENT_KEY=local \
VITE_FEEDBACK_ADMIN_WORKSPACE_KEY=00000000-0000-0000-0000-000000000000 \
npm --workspace @feedback/admin-console run dev
```

または Web GIS を起動対象へ含めず、次のローカル fixture 一式を起動する。

```bash
docker compose --env-file infra/.env -f infra/docker-compose.yml --profile feedback up --build \
  feedback-admin feedback-service feedback-export-worker feedback-notification-worker feedback-retention-worker
```

管理画面は `http://localhost:5174` に起動する。`VITE_*` はブラウザへ配布されるため、secret を設定しない。
Web GIS などの consumer は `applicationKey`、`environmentKey`、`workspaceKey` query parameter を付けて
対象 workspace を開ける。OIDC redirect 中はこの3値だけを sessionStorage に一時保存し、tokenやconsumerの
任意 query は Admin Console へ転送しない。
