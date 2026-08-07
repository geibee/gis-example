import { useQuery } from "@tanstack/react-query";
import { getReviewSession, getReviewSessions } from "../api";
import type { ReviewSession } from "../contracts";
import { keys } from "./keys";

export function useReviewSessionsQuery(projectId: string, status?: ReviewSession["status"]) {
  return useQuery({
    queryKey: keys.reviewSessions.list(projectId, status),
    queryFn: () => getReviewSessions(projectId, status),
    enabled: Boolean(projectId)
  });
}

export function useReviewSessionQuery(id: string | null) {
  return useQuery({
    queryKey: keys.reviewSessions.detail(id ?? ""),
    queryFn: () => getReviewSession(id!),
    enabled: Boolean(id)
  });
}
