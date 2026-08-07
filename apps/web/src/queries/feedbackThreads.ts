import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFeedbackThread, getFeedbackThreads } from "../api";
import type { FeedbackThread, FeedbackThreadCreateMetadata } from "../contracts";
import { keys } from "./keys";

export function useFeedbackThreadsQuery(reviewSessionId: string | null) {
  return useQuery({
    queryKey: keys.feedbackThreads.list(reviewSessionId ?? ""),
    queryFn: () => getFeedbackThreads(reviewSessionId!),
    enabled: Boolean(reviewSessionId)
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
