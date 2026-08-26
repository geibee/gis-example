import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction
} from "react";
import { useMeQuery, useProjectsQuery } from "./queries/session";
import type { Me, Project } from "./contracts";

// 画面横断の軽量な状態 (認証ユーザー・プロジェクト選択・地図ペイン開閉) のみを持つ。
// サーバ状態のキャッシュは TanStack Query、画面固有の状態は各 src/screens/ が持つ。
// 通知は src/notifications.ts (notifySuccess / notifyError / notifyInfo) + ui/Toaster が担う。
export type PaneMode = "split" | "business" | "map";

export function nextPaneMode(current: PaneMode, target: "business" | "map"): PaneMode {
  if (target === "business") return current === "map" ? "split" : "map";
  return current === "business" ? "split" : "business";
}

export type AppShellState = {
  me: Me | null;
  projects: Project[];
  selectedProject: string;
  setSelectedProject: (projectId: string) => void;
  paneMode: PaneMode;
  businessPaneOpen: boolean;
  mapSupportOpen: boolean;
  showMapPane: () => void;
  toggleBusinessPane: () => void;
  toggleMapPane: () => void;
  mapPaneWidth: number;
  setMapPaneWidth: Dispatch<SetStateAction<number>>;
  mapCanvasHeight: number;
  setMapCanvasHeight: Dispatch<SetStateAction<number>>;
  mapFullscreen: boolean;
  setMapFullscreen: Dispatch<SetStateAction<boolean>>;
};

const AppShellContext = createContext<AppShellState | null>(null);

export function AppShellProvider({ children }: { children: ReactNode }) {
  const meQuery = useMeQuery();
  const projectsQuery = useProjectsQuery();
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);

  const [selectedProject, setSelectedProject] = useState("");
  const [paneMode, setPaneMode] = useState<PaneMode>("split");
  const [mapPaneWidth, setMapPaneWidth] = useState(() =>
    typeof window === "undefined" ? 560 : Math.max(360, Math.round(window.innerWidth * 0.42))
  );
  const [mapCanvasHeight, setMapCanvasHeight] = useState(() =>
    typeof window === "undefined" ? 360 : Math.max(260, Math.round(window.innerHeight * 0.42))
  );
  const [mapFullscreen, setMapFullscreen] = useState(false);

  useEffect(() => {
    if (!selectedProject && projects[0]) {
      setSelectedProject(projects[0].id);
    }
  }, [projects, selectedProject]);

  const value = useMemo<AppShellState>(
    () => ({
      me: meQuery.data ?? null,
      projects,
      selectedProject,
      setSelectedProject,
      paneMode,
      businessPaneOpen: paneMode !== "map",
      mapSupportOpen: paneMode !== "business",
      showMapPane: () => setPaneMode((current) => current === "business" ? "split" : current),
      toggleBusinessPane: () => setPaneMode((current) => nextPaneMode(current, "business")),
      toggleMapPane: () => setPaneMode((current) => nextPaneMode(current, "map")),
      mapPaneWidth,
      setMapPaneWidth,
      mapCanvasHeight,
      setMapCanvasHeight,
      mapFullscreen,
      setMapFullscreen
    }),
    [mapCanvasHeight, mapFullscreen, mapPaneWidth, meQuery.data, paneMode, projects, selectedProject]
  );

  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>;
}

export function useAppShell(): AppShellState {
  const state = useContext(AppShellContext);
  if (!state) {
    throw new Error("AppShellContext が提供されていません (AppShellProvider 配下でのみ使用できます)");
  }
  return state;
}
