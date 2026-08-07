import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFeedbackMessage,
  createFeedbackThread,
  getFeedbackThread,
  getFeedbackThreads,
  updateFeedbackThreadStatus
} from "../api";
import type {
  FeedbackMessageCreateRequest,
  FeedbackThread,
  FeedbackThreadCreateMetadata,
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
    // 投稿は該当セッションのスレッド一覧にだけ影響する (レビューセッション自体は変わらない)
    onSuccess: (thread: FeedbackThread) => {
      void queryClient.invalidateQueries({ queryKey: keys.feedbackThreads.list(thread.reviewSessionId) });
    }
  });
}

export function useCreateFeedbackMessageMutation(reviewSessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { threadId: string; request: FeedbackMessageCreateRequest }) =>
      createFeedbackMessage(input.threadId, input.request),
    onSuccess: (_message, input) => {
      void queryClient.invalidateQueries({ queryKey: keys.feedbackThreads.list(reviewSessionId) });
      void queryClient.invalidateQueries({ queryKey: keys.feedbackThreads.detail(input.threadId) });
    }
  });
}

export function useUpdateFeedbackThreadStatusMutation(reviewSessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { threadId: string; request: FeedbackThreadStatusPatchRequest }) =>
      updateFeedbackThreadStatus(input.threadId, input.request),
    onSuccess: (thread) => {
      queryClient.setQueryData(keys.feedbackThreads.detail(thread.id), thread);
      void queryClient.invalidateQueries({ queryKey: keys.feedbackThreads.list(reviewSessionId) });
    }
  });
}
