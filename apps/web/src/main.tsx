import React from "react";
import ReactDOM from "react-dom/client";
import { AuthProvider } from "react-oidc-context";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import AuthGate from "./AuthGate";
import { oidcConfig } from "./auth";
import { createQueryClient } from "./queries/queryClient";
import { router } from "./router";
import "./styles.css";

// サーバ状態 (一覧・詳細・ジョブ進捗) のキャッシュを一元管理する QueryClient
const queryClient = createQueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider {...oidcConfig}>
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          <RouterProvider router={router} />
        </AuthGate>
      </QueryClientProvider>
    </AuthProvider>
  </React.StrictMode>
);
