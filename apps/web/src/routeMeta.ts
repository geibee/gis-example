import type { BusinessTab } from "./appTypes";

// ルート定義に持たせる画面メタ情報。権限ガードと画面タイトル、
// ヘッダータブのハイライトはすべてこの staticData を正として一元的に扱う。
export type ScreenMeta = {
  tab: BusinessTab;
  title: string;
  requiredSystemRole?: "admin";
};

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    screen?: ScreenMeta;
  }
}

type ScreenMatchLike = {
  staticData: { screen?: ScreenMeta };
  params: unknown;
};

// マッチ列の末端から画面メタ情報を引く (root など screen を持たないルートは飛ばす)
export function activeScreenMeta(matches: ReadonlyArray<ScreenMatchLike>): ScreenMeta | null {
  for (let i = matches.length - 1; i >= 0; i--) {
    const screen = matches[i].staticData.screen;
    if (screen) return screen;
  }
  return null;
}

// 画面ルートの $id パラメータ (選択中オブジェクト ID)。URL を唯一の正とする。
export function activeScreenObjectId(matches: ReadonlyArray<ScreenMatchLike>): string | null {
  for (let i = matches.length - 1; i >= 0; i--) {
    if (!matches[i].staticData.screen) continue;
    const { id } = matches[i].params as { id?: string };
    return id ?? null;
  }
  return null;
}

export const tabBasePath = {
  zone: "/zones",
  lands: "/lands",
  buildings: "/buildings",
  parties: "/parties",
  admin: "/admin"
} as const;

export const tabDetailPath = {
  zone: "/zones/$id",
  lands: "/lands/$id",
  buildings: "/buildings/$id",
  parties: "/parties/$id"
} as const;
