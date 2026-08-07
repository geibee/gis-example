import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getReviewNotificationSettings,
  retryFailedReviewNotifications,
  updateReviewNotificationSettings
} from "../api";
import type { ReviewNotificationSettingsPatchRequest } from "../contracts";
import { keys } from "./keys";

export function useReviewNotificationSettingsQuery(projectId: string) {
  return useQuery({
    queryKey: keys.reviewNotifications.settings(projectId),
    queryFn: () => getReviewNotificationSettings(projectId),
    enabled: Boolean(projectId)
  });
}

export function useUpdateReviewNotificationSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; request: ReviewNotificationSettingsPatchRequest }) =>
      updateReviewNotificationSettings(input.projectId, input.request),
    onSuccess: (settings) => {
      queryClient.setQueryData(keys.reviewNotifications.settings(settings.projectId), settings);
    }
  });
}

export function useRetryFailedReviewNotificationsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: retryFailedReviewNotifications,
    onSuccess: (_result, projectId) => {
      void queryClient.invalidateQueries({ queryKey: keys.reviewNotifications.settings(projectId) });
    }
  });
}
