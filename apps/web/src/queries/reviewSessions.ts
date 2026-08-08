import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { feedbackPluginKeys } from "@web-gis/feedback-plugin";
import {
  createReviewSession,
  getReviewPerspectiveDefinitions,
  getReviewSession,
  getReviewSessions,
  updateReviewSession
} from "../api";
import type {
  ReviewPerspectiveDefinition,
  ReviewSession,
  ReviewSessionCreateRequest,
  ReviewSessionPatchRequest
} from "../contracts";
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

export function useReviewPerspectiveDefinitionsQuery(projectId: string) {
  return useQuery<ReviewPerspectiveDefinition[]>({
    queryKey: keys.reviewSessions.perspectiveDefinitions(projectId),
    queryFn: () => getReviewPerspectiveDefinitions(projectId),
    enabled: Boolean(projectId)
  });
}

export function useCreateReviewSessionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: ReviewSessionCreateRequest) => createReviewSession(request),
    onSuccess: (session) => {
      queryClient.setQueryData(keys.reviewSessions.detail(session.id), session);
      queryClient.setQueryData<ReviewSession[]>(keys.reviewSessions.list(session.projectId), (current) =>
        current ? [session, ...current.filter((item) => item.id !== session.id)] : [session]
      );
      void queryClient.invalidateQueries({ queryKey: keys.reviewSessions.lists() });
      void queryClient.invalidateQueries({ queryKey: feedbackPluginKeys.root(session.projectId) });
    }
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
      void queryClient.invalidateQueries({ queryKey: feedbackPluginKeys.root(session.projectId) });
    }
  });
}
