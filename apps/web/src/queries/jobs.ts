import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createAnalysisJob, createImportJob, getAnalysisJob, getImportJob } from "../api";
import type { AnalysisJob, ImportJob } from "../types";
import { jobPollIntervalMs, jobPollTimeoutMs } from "../constants";
import { keys } from "./keys";

type JobLike = { status: "pending" | "running" | "succeeded" | "failed" };

export type JobPollingHandlers<TJob extends JobLike> = {
  onSucceeded: (job: TJob) => void | Promise<void>;
  onFailed: (job: TJob) => void;
  onTimeout: () => void;
  // ポーリング自体の失敗時の後片付け (エラーメッセージはグローバル onError が通知する)
  onError?: () => void;
};

function isTerminal(status: JobLike["status"] | undefined): boolean {
  return status === "succeeded" || status === "failed";
}

// ジョブ進捗ポーリングの共通実装。
// - refetchInterval のコールバックで「pending/running の間だけ一定間隔、終端状態で停止」を表現する
//   (旧実装の activePollTimersRef による手動 setInterval 管理を置き換え)
// - アンマウント時はクエリの購読が消えるため、タイマー解放処理は不要
// - 進まないジョブは jobPollTimeoutMs で打ち切る
function useJobPolling<TJob extends JobLike>(
  queryKeyOf: (id: string) => readonly unknown[],
  fetchJob: (id: string) => Promise<TJob>,
  handlers: JobPollingHandlers<TJob>
) {
  const [tracked, setTracked] = useState<{ id: string; startedAt: number } | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const { data, dataUpdatedAt, error } = useQuery({
    queryKey: queryKeyOf(tracked?.id ?? ""),
    queryFn: () => fetchJob(tracked!.id),
    enabled: Boolean(tracked),
    staleTime: 0,
    gcTime: 0,
    retry: 0,
    refetchInterval: (query) => (isTerminal(query.state.data?.status) ? false : jobPollIntervalMs)
  });

  useEffect(() => {
    if (!tracked) return;
    if (error) {
      setTracked(null);
      handlersRef.current.onError?.();
      return;
    }
    if (!data) return;
    if (data.status === "failed") {
      setTracked(null);
      handlersRef.current.onFailed(data);
      return;
    }
    if (data.status === "succeeded") {
      setTracked(null);
      void handlersRef.current.onSucceeded(data);
      return;
    }
    if (Date.now() - tracked.startedAt > jobPollTimeoutMs) {
      setTracked(null);
      handlersRef.current.onTimeout();
    }
  }, [data, dataUpdatedAt, error, tracked]);

  return {
    start: (id: string) => setTracked({ id, startedAt: Date.now() }),
    polling: Boolean(tracked)
  };
}

// 取込ジョブ完了時の成果物: レイヤ一覧 (新レイヤ) と区域一覧 (zone ロール取込)
function invalidateImportArtifacts(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: keys.layers.all });
  void queryClient.invalidateQueries({ queryKey: keys.zones.lists() });
}

export function useImportJobPolling(handlers: JobPollingHandlers<ImportJob>) {
  const queryClient = useQueryClient();
  return useJobPolling<ImportJob>((id) => keys.jobs.import(id), getImportJob, {
    ...handlers,
    onSucceeded: async (job) => {
      invalidateImportArtifacts(queryClient);
      await handlers.onSucceeded(job);
    }
  });
}

// 分析ジョブ完了時の成果物: 結果レイヤ (レイヤ一覧)
export function useAnalysisJobPolling(handlers: JobPollingHandlers<AnalysisJob>) {
  const queryClient = useQueryClient();
  return useJobPolling<AnalysisJob>((id) => keys.jobs.analysis(id), getAnalysisJob, {
    ...handlers,
    onSucceeded: async (job) => {
      void queryClient.invalidateQueries({ queryKey: keys.layers.all });
      await handlers.onSucceeded(job);
    }
  });
}

export function useCreateImportJobMutation() {
  return useMutation({ mutationFn: (formData: FormData) => createImportJob(formData) });
}

export function useCreateAnalysisJobMutation() {
  return useMutation({ mutationFn: (body: unknown) => createAnalysisJob(body) });
}
