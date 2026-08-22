import { useEffect } from "react";
import {
  createRedmineFeedbackPluginControllerFromRuntimeConfig,
  type RedmineFeedbackPluginController,
  type RedmineFeedbackRuntimeOptions
} from "@geibee/feedback-redmine-plugin/loader";
import { router } from "./router";
import { connectFeedbackController } from "./feedbackMapRegistry";

type FeedbackRedmineHostAdapter = RedmineFeedbackRuntimeOptions["adapter"];
type FeedbackHostContextV1 = ReturnType<FeedbackRedmineHostAdapter["getContext"]>;
type FeedbackLocationV1 = NonNullable<ReturnType<FeedbackRedmineHostAdapter["getLocation"]>>;
type FeedbackHostResourceRefV1 = NonNullable<ReturnType<FeedbackRedmineHostAdapter["getResourceRef"]>>;

type HostNavigation = {
  pathname(): string;
  navigate(pathname: string): void | Promise<void>;
  subscribe(listener: () => void): () => void;
};

/**
 * Feedbackの唯一のSPA結合点。業務画面、API client、認証tokenへ依存せず、
 * hostから公開してよい画面位置だけをadapterへ写像する。
 */
export function FeedbackRedmineIntegration() {
  useEffect(() => {
    let context: FeedbackHostContextV1;
    try {
      context = loadFeedbackHostContext(import.meta.env);
    } catch (error) {
      console.error("Feedback host設定を読み込めません", error);
      return;
    }

    const adapter = createFeedbackRedmineHostAdapter(context, {
      pathname: () => router.state.location.pathname,
      navigate: (pathname) => router.navigate({ href: pathname }),
      subscribe: (listener) => router.subscribe("onResolved", listener)
    });
    const abort = new AbortController();
    let controller: RedmineFeedbackPluginController | null = null;
    let disconnectController: (() => void) | null = null;
    void createRedmineFeedbackPluginControllerFromRuntimeConfig({
      adapter,
      contextMenu: true,
      signal: abort.signal,
      onUnavailable: (error: unknown) => console.error("Feedbackを利用できません", error)
    }).then((created) => {
      if (abort.signal.aborted) created?.destroy();
      else {
        controller = created;
        disconnectController = created ? connectFeedbackController(created) : null;
      }
    });
    return () => {
      abort.abort();
      disconnectController?.();
      controller?.destroy();
    };
  }, []);

  return null;
}

export function loadFeedbackHostContext(
  environment: Record<string, string | boolean | undefined>
): FeedbackHostContextV1 {
  return {
    schemaVersion: "1",
    applicationKey: required(environment, "VITE_FEEDBACK_REDMINE_APPLICATION_KEY"),
    environmentKey: required(environment, "VITE_FEEDBACK_REDMINE_ENVIRONMENT_KEY"),
    externalWorkspaceKey: required(environment, "VITE_FEEDBACK_REDMINE_WORKSPACE_KEY"),
    release: required(environment, "VITE_FEEDBACK_HOST_RELEASE"),
    locale: "ja-JP"
  };
}

export function createFeedbackRedmineHostAdapter(
  context: FeedbackHostContextV1,
  navigation: HostNavigation
): FeedbackRedmineHostAdapter {
  return {
    getContext: () => context,
    getLocation: () => locationFromPathname(navigation.pathname()),
    getResourceRef: () => resourceRefFromPathname(navigation.pathname()),
    subscribe: navigation.subscribe,
    navigate: (location) => navigation.navigate(pathnameFromLocation(location))
  };
}

export function locationFromPathname(pathname: string): FeedbackLocationV1 {
  const match = /^\/(zones|lands|buildings|parties|admin)(?:\/([^/?#]+))?\/?$/u.exec(pathname);
  if (!match) {
    return {
      schemaVersion: "1",
      pageKey: "application",
      routeTemplate: "/",
      pathParameters: {},
      queryParameters: {}
    };
  }
  const section = match[1]!;
  const id = match[2] ? decodeURIComponent(match[2]) : null;
  return {
    schemaVersion: "1",
    pageKey: id ? `${section}.detail` : section,
    routeTemplate: id ? `/${section}/{id}` : `/${section}`,
    pathParameters: id ? { id } : {},
    queryParameters: {}
  };
}

export function resourceRefFromPathname(pathname: string): FeedbackHostResourceRefV1 {
  const location = locationFromPathname(pathname);
  const id = location.pathParameters.id;
  const key = id ? `${location.pageKey}:${id}` : location.pageKey;
  return {
    schemaVersion: "1",
    kind: id ? "record" : "page",
    key: key.slice(0, 200)
  };
}

function pathnameFromLocation(location: FeedbackLocationV1): string {
  let pathname = location.routeTemplate;
  for (const [name, value] of Object.entries(location.pathParameters)) {
    pathname = pathname.replace(`{${name}}`, encodeURIComponent(value));
  }
  if (!/^\/(zones|lands|buildings|parties|admin)(?:\/[^/?#]+)?$/u.test(pathname)) {
    throw new Error("Feedbackの保存位置から安全な画面遷移先を復元できません");
  }
  return pathname;
}

function required(environment: Record<string, string | boolean | undefined>, name: string): string {
  const value = environment[name];
  if (typeof value !== "string" || !value) throw new Error(`${name}は必須です`);
  return value;
}
