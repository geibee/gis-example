import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFeedbackMessage,
  createFeedbackThread,
  getFeedbackEvidence,
  getFeedbackSummary,
  getFeedbackThread,
  getFeedbackThreads,
  searchFeedbackThreads,
  updateFeedbackThreadStatus
} from "../api";
import type {
  FeedbackMessageCreateRequest,
  FeedbackThread,
  FeedbackThreadCreateMetadata,
  FeedbackThreadSearchQuery,
  FeedbackThreadStatusPatchRequest
} from "../contracts";
import { keys } from "./keys";

export function useFeedbackThreadsQuery(reviewSessionId: string | null) {
  return useQuery({
    queryKey: keys.feedbackThreads.list(reviewSessionId ?? ""),
    queryFn: () => getFeedbackThreads(reviewSessionId!),
    enabled: Boolean(reviewSessionId)
  });
}

export function useFeedbackThreadQuery(threadId: string | null) {
  return useQuery({
    queryKey: keys.feedbackThreads.detail(threadId ?? ""),
    queryFn: () => getFeedbackThread(threadId!),
    enabled: Boolean(threadId)
  });
}

export function useFeedbackThreadSearchQuery(query: FeedbackThreadSearchQuery) {
  return useQuery({
    queryKey: keys.feedbackThreads.search(query),
    queryFn: () => searchFeedbackThreads(query),
    enabled: Boolean(query.projectId)
  });
}

export function useFeedbackSummaryQuery(projectId: string) {
  return useQuery({
    queryKey: keys.feedbackThreads.summary(projectId),
    queryFn: () => getFeedbackSummary(projectId),
    enabled: Boolean(projectId)
  });
}

export function useFeedbackEvidenceQuery(threadId: string | null) {
  return useQuery({
    queryKey: keys.feedbackThreads.evidence(threadId ?? ""),
    queryFn: () => getFeedbackEvidence(threadId!),
    enabled: Boolean(threadId),
    staleTime: Number.POSITIVE_INFINITY
  });
}

export type CreateFeedbackThreadInput = {
  reviewSessionId: string;
  metadata: FeedbackThreadCreateMetadata;
  screenshot: Blob | null;
};

export function useCreateFeedbackThreadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFeedbackThreadInput) =>
      createFeedbackThread(input.reviewSessionId, input.metadata, input.screenshot),
    // 管理検索・集計・ピン一覧のすべてへ反映する (レビューセッション自体は変わらない)
    onSuccess: (_thread: FeedbackThread) => {
      void queryClient.invalidateQueries({ queryKey: keys.feedbackThreads.all });
    }
  });
}

export function useCreateFeedbackMessageMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { threadId: string; request: FeedbackMessageCreateRequest }) =>
      createFeedbackMessage(input.threadId, input.request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.feedbackThreads.all });
    }
  });
}

export function useUpdateFeedbackThreadStatusMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { threadId: string; request: FeedbackThreadStatusPatchRequest }) =>
      updateFeedbackThreadStatus(input.threadId, input.request),
    onSuccess: (thread) => {
      queryClient.setQueryData(keys.feedbackThreads.detail(thread.id), thread);
      void queryClient.invalidateQueries({ queryKey: keys.feedbackThreads.all });
    }
  });
}
