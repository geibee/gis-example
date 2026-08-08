import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FeedbackMessageCreateRequest,
  FeedbackMessageUpdateRequest,
  FeedbackThread,
  FeedbackThreadCreateMetadata,
  FeedbackThreadStatusPatchRequest,
  ReviewSession
} from "./contracts";
import { useFeedbackPluginContext } from "./plugin-context";

const rootKey = (projectId: string) => ["web-gis-feedback-plugin", projectId] as const;

export const feedbackPluginKeys = {
  root: rootKey,
  me: (projectId: string) => [...rootKey(projectId), "me"] as const,
  sessions: (projectId: string, status: ReviewSession["status"]) =>
    [...rootKey(projectId), "review-sessions", status] as const,
  threads: (projectId: string, reviewSessionId: string) =>
    [...rootKey(projectId), "threads", "list", reviewSessionId] as const,
  thread: (projectId: string, threadId: string) =>
    [...rootKey(projectId), "threads", "detail", threadId] as const,
  history: (projectId: string, messageId: string) =>
    [...rootKey(projectId), "messages", messageId, "history"] as const
};

export function useCurrentUserQuery() {
  const { api, projectId } = useFeedbackPluginContext();
  return useQuery({
    queryKey: feedbackPluginKeys.me(projectId),
    queryFn: api.getMe,
    enabled: Boolean(projectId)
  });
}

export function useOpenReviewSessionQuery() {
  const { api, projectId } = useFeedbackPluginContext();
  return useQuery({
    queryKey: feedbackPluginKeys.sessions(projectId, "open"),
    queryFn: () => api.getReviewSessions(projectId, "open"),
    enabled: Boolean(projectId),
    // status=open はAPIにも渡すが、プロキシやテストダブルの誤応答でdraftを案内しないよう防御する。
    select: (sessions) => sessions.find((session) => session.status === "open") ?? null
  });
}

export function useFeedbackThreadsQuery(reviewSessionId: string | null) {
  const { api, projectId } = useFeedbackPluginContext();
  return useQuery({
    queryKey: feedbackPluginKeys.threads(projectId, reviewSessionId ?? ""),
    queryFn: () => api.getFeedbackThreads(reviewSessionId!),
    enabled: Boolean(projectId && reviewSessionId)
  });
}

export function useFeedbackThreadQuery(threadId: string | null) {
  const { api, projectId } = useFeedbackPluginContext();
  return useQuery({
    queryKey: feedbackPluginKeys.thread(projectId, threadId ?? ""),
    queryFn: () => api.getFeedbackThread(threadId!),
    enabled: Boolean(projectId && threadId)
  });
}

export function useFeedbackMessageHistoryQuery(messageId: string | null) {
  const { api, projectId } = useFeedbackPluginContext();
  return useQuery({
    queryKey: feedbackPluginKeys.history(projectId, messageId ?? ""),
    queryFn: () => api.getFeedbackMessageHistory(messageId!),
    enabled: Boolean(projectId && messageId)
  });
}

export type CreateFeedbackThreadInput = {
  reviewSessionId: string;
  metadata: FeedbackThreadCreateMetadata;
  screenshot: Blob | null;
};

export function useCreateFeedbackThreadMutation() {
  const { api, projectId } = useFeedbackPluginContext();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFeedbackThreadInput) =>
      api.createFeedbackThread(input.reviewSessionId, input.metadata, input.screenshot),
    onSuccess: (thread) => {
      queryClient.setQueryData(feedbackPluginKeys.thread(projectId, thread.id), thread);
      void queryClient.invalidateQueries({ queryKey: rootKey(projectId) });
    }
  });
}

export function useCreateFeedbackMessageMutation() {
  const { api, projectId } = useFeedbackPluginContext();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { threadId: string; request: FeedbackMessageCreateRequest }) =>
      api.createFeedbackMessage(input.threadId, input.request),
    onSuccess: (message) => {
      queryClient.setQueryData<FeedbackThread>(
        feedbackPluginKeys.thread(projectId, message.threadId),
        (thread) => thread ? { ...thread, messages: [...thread.messages, message] } : thread
      );
      void queryClient.invalidateQueries({ queryKey: rootKey(projectId) });
    }
  });
}

export function useUpdateFeedbackMessageMutation() {
  const { api, projectId } = useFeedbackPluginContext();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { messageId: string; request: FeedbackMessageUpdateRequest }) =>
      api.updateFeedbackMessage(input.messageId, input.request),
    onSuccess: (message) => {
      queryClient.setQueryData<FeedbackThread>(
        feedbackPluginKeys.thread(projectId, message.threadId),
        (thread) =>
          thread
            ? { ...thread, messages: thread.messages.map((item) => item.id === message.id ? message : item) }
            : thread
      );
      void queryClient.invalidateQueries({ queryKey: feedbackPluginKeys.history(projectId, message.id) });
      void queryClient.invalidateQueries({ queryKey: rootKey(projectId) });
    }
  });
}

export function useUpdateFeedbackThreadStatusMutation() {
  const { api, projectId } = useFeedbackPluginContext();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { threadId: string; request: FeedbackThreadStatusPatchRequest }) =>
      api.updateFeedbackThreadStatus(input.threadId, input.request),
    onSuccess: (thread) => {
      queryClient.setQueryData(feedbackPluginKeys.thread(projectId, thread.id), thread);
      void queryClient.invalidateQueries({ queryKey: rootKey(projectId) });
    }
  });
}
