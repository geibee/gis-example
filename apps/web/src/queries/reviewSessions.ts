import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getReviewSession, getReviewSessions, updateReviewSession } from "../api";
import type { ReviewSession, ReviewSessionPatchRequest } from "../contracts";
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

export function useUpdateReviewSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; request: ReviewSessionPatchRequest }) =>
      updateReviewSession(input.id, input.request),
    onSuccess: (session) => {
      queryClient.setQueryData(keys.reviewSessions.detail(session.id), session);
      void queryClient.invalidateQueries({ queryKey: keys.reviewSessions.lists() });
      void queryClient.invalidateQueries({ queryKey: keys.feedbackThreads.all });
    }
  });
}
