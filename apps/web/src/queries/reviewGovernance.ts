import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getReviewRetentionPolicy,
  purgeExpiredReviewEvidence,
  updateReviewRetentionPolicy
} from "../api";
import type { ReviewRetentionPolicyPatchRequest } from "../contracts";
import { keys } from "./keys";

export function useReviewRetentionPolicyQuery(projectId: string) {
  return useQuery({
    queryKey: keys.reviewRetention.policy(projectId),
    queryFn: () => getReviewRetentionPolicy(projectId),
    enabled: Boolean(projectId)
  });
}

export function useUpdateReviewRetentionPolicyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; request: ReviewRetentionPolicyPatchRequest }) =>
      updateReviewRetentionPolicy(input.projectId, input.request),
    onSuccess: (policy) => {
      queryClient.setQueryData(keys.reviewRetention.policy(policy.projectId), policy);
      void queryClient.invalidateQueries({ queryKey: keys.reviewSessions.all });
      void queryClient.invalidateQueries({ queryKey: keys.feedbackThreads.all });
    }
  });
}

export function usePurgeExpiredReviewEvidenceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => purgeExpiredReviewEvidence(projectId),
    onSuccess: (_result, projectId) => {
      void queryClient.invalidateQueries({ queryKey: keys.reviewRetention.policy(projectId) });
      void queryClient.invalidateQueries({ queryKey: keys.feedbackThreads.all });
    }
  });
}
