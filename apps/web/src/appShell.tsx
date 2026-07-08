import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction
} from "react";
import { subscribeNotices } from "./notifications";
import { useMeQuery, useProjectsQuery } from "./queries/session";
import type { Me, Project } from "./types";

// 画面横断の軽量な状態 (認証ユーザー・プロジェクト選択・通知・地図ペイン開閉) のみを持つ。
// サーバ状態のキャッシュは TanStack Query、画面固有の状態は各 src/screens/ が持つ。
export type AppShellState = {
  me: Me | null;
  projects: Project[];
  selectedProject: string;
  setSelectedProject: (projectId: string) => void;
  notice: string | null;
  setNotice: (notice: string | null) => void;
  mapSupportOpen: boolean;
  setMapSupportOpen: Dispatch<SetStateAction<boolean>>;
};

const AppShellContext = createContext<AppShellState | null>(null);

export function AppShellProvider({ children }: { children: ReactNode }) {
  const meQuery = useMeQuery();
  const projectsQuery = useProjectsQuery();
  const projects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);

  const [selectedProject, setSelectedProject] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [mapSupportOpen, setMapSupportOpen] = useState(true);

  // QueryClient のグローバル onError などツリー外からの通知を受け取る
  useEffect(() => subscribeNotices(setNotice), []);

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
      notice,
      setNotice,
      mapSupportOpen,
      setMapSupportOpen
    }),
    [mapSupportOpen, meQuery.data, notice, projects, selectedProject]
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
