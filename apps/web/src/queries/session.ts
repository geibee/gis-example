import { useQuery } from "@tanstack/react-query";
import { getMe, getProjects } from "../api";
import { keys } from "./keys";

// 認証ユーザー情報。ScreenGuard が「未ロード中は判定保留」に使うため、
// data 未取得 (undefined) と null を区別せず null を返す。
export function useMeQuery() {
  return useQuery({
    queryKey: keys.me,
    queryFn: getMe,
    staleTime: 5 * 60 * 1000
  });
}

export function useProjectsQuery() {
  return useQuery({
    queryKey: keys.projects,
    queryFn: getProjects,
    staleTime: 5 * 60 * 1000
  });
}
