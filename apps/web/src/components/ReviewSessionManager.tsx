import { zodResolver } from "@hookform/resolvers/zod";
import { captureExcludeAttribute } from "@web-gis/feedback-plugin";
import { Pencil, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import type {
  ReviewPerspectiveDefinition,
  ReviewPerspectiveWriteRequest,
  ReviewScopeWriteRequest,
  ReviewSession,
  ReviewSessionCreateRequest,
  ReviewSessionPatchRequest
} from "../contracts";
import { notifyError, notifySuccess } from "../notifications";
import {
  reviewPageOptionKey,
  reviewPageCatalog,
  type ReviewPageCatalogOption
} from "../reviewPageCatalog";
import {
  useCreateReviewSessionMutation,
  useReviewPerspectiveDefinitionsQuery,
  useUpdateReviewSessionMutation
} from "../queries/reviewSessions";
import { errorMessage } from "../utils";
import { reviewSessionStatusLabels } from "./ReviewGuide";

const perspectiveStatusSchema = z.enum(["", "ACTIVE", "FUTURE", "OUT_OF_SCOPE"]);

const reviewSessionFormSchema = z
  .object({
    title: z.string().trim().min(1, "タイトルを入力してください"),
    description: z.string().trim(),
    status: z.enum(["draft", "open", "closed"]),
    startAt: z.string(),
    endAt: z.string(),
    evidenceRetentionDays: z
      .string()
      .refine(
        (value) => value === "" || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 3650),
        "1〜3650日の範囲で入力してください"
      ),
    perspectives: z.array(
      z.object({
        code: z.string().min(1),
        label: z.string(),
        status: perspectiveStatusSchema,
        guidance: z.string().trim()
      })
    ),
    scopes: z.array(
      z.object({
        selected: z.boolean(),
        pageId: z.string().trim().min(1, "画面IDを入力してください"),
        route: z.string(),
        description: z.string().trim(),
        reviewable: z.boolean()
      })
    )
  })
  .superRefine((values, context) => {
    if (values.status === "open" && !values.perspectives.some((item) => item.status === "ACTIVE")) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "受付中にするには、少なくとも1つの観点を「今回確認」にしてください"
      });
    }
    if (values.startAt && values.endAt && new Date(values.endAt) < new Date(values.startAt)) {
      context.addIssue({ code: "custom", path: ["endAt"], message: "終了日時は開始日時以降にしてください" });
    }
    const firstIndexByPage = new Map<string, number>();
    values.scopes.forEach((scope, index) => {
      if (!scope.selected) return;
      const pageKey = `${scope.pageId.trim()}\n${scope.route.trim()}`;
      const firstIndex = firstIndexByPage.get(pageKey);
      if (firstIndex === undefined) {
        firstIndexByPage.set(pageKey, index);
      } else {
        context.addIssue({
          code: "custom",
          path: ["scopes", index, "pageId"],
          message: `同じ画面が${firstIndex + 1}行目にもあります`
        });
      }
    });
  });

type ReviewSessionFormValues = z.infer<typeof reviewSessionFormSchema>;
type EditorMode = "create" | "edit";

type ReviewSessionManagerProps = {
  projectId: string;
  selectedSession: ReviewSession | null;
  onSaved: (session: ReviewSession) => void;
};

/** セッション一覧に隣接する、editor向けの作成・編集入口。 */
export function ReviewSessionManager({ projectId, selectedSession, onSaved }: ReviewSessionManagerProps) {
  const definitionsQuery = useReviewPerspectiveDefinitionsQuery(projectId);
  const [mode, setMode] = useState<EditorMode | null>(null);

  useEffect(() => setMode(null), [projectId]);

  return (
    <div className="review-session-manager">
      <div className="review-session-actions">
        <button
          type="button"
          className="subtle-button"
          disabled={definitionsQuery.isPending || definitionsQuery.isError}
          onClick={() => setMode("create")}
        >
          <Plus size={14} />
          新規作成
        </button>
        <button
          type="button"
          className="subtle-button"
          disabled={!selectedSession || definitionsQuery.isPending || definitionsQuery.isError}
          onClick={() => setMode("edit")}
        >
          <Pencil size={14} />
          編集
        </button>
      </div>
      {definitionsQuery.isPending ? <p className="review-guide-note">レビュー観点を読み込んでいます...</p> : null}
      {definitionsQuery.isError ? (
        <p className="notice error" role="alert">
          {errorMessage(definitionsQuery.error)}
        </p>
      ) : null}
      {mode && definitionsQuery.data ? (
        <ReviewSessionDialog
          key={`${mode}:${mode === "edit" ? selectedSession?.id ?? "none" : projectId}`}
          mode={mode}
          projectId={projectId}
          session={mode === "edit" ? selectedSession : null}
          definitions={definitionsQuery.data}
          onClose={() => setMode(null)}
          onSaved={(session) => {
            onSaved(session);
            setMode(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ReviewSessionDialog({
  mode,
  projectId,
  session,
  definitions,
  onClose,
  onSaved
}: {
  mode: EditorMode;
  projectId: string;
  session: ReviewSession | null;
  definitions: ReviewPerspectiveDefinition[];
  onClose: () => void;
  onSaved: (session: ReviewSession) => void;
}) {
  const createSession = useCreateReviewSessionMutation();
  const updateSession = useUpdateReviewSessionMutation();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const pageOptions = useMemo(
    () => withLegacyPageOptions(reviewPageCatalog, session?.scopes ?? []),
    [session?.scopes]
  );
  const defaultValues = useMemo(
    () => formValuesFromSession(session, definitions, pageOptions),
    [definitions, pageOptions, session]
  );
  const {
    control,
    register,
    handleSubmit,
    setValue,
    formState: { errors }
  } = useForm<ReviewSessionFormValues>({
    resolver: zodResolver(reviewSessionFormSchema),
    defaultValues
  });
  const selectedStatus = useWatch({ control, name: "status" });
  const selectedScopes = useWatch({ control, name: "scopes" });
  const pending = createSession.isPending || updateSession.isPending;
  const pageOptionsByGroup = useMemo(() => groupPageOptions(pageOptions), [pageOptions]);
  const selectedScopeCount = selectedScopes.filter((scope) => scope.selected).length;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, pending]);

  const submit = async (values: ReviewSessionFormValues) => {
    setSubmitError(null);
    const request = requestFromForm(values);
    try {
      const saved = mode === "create"
        ? await createSession.mutateAsync({ ...request, projectId } satisfies ReviewSessionCreateRequest)
        : await updateSession.mutateAsync({ id: session!.id, request: request satisfies ReviewSessionPatchRequest });
      notifySuccess(mode === "create" ? "レビューセッションを作成しました" : "レビューセッションを更新しました");
      onSaved(saved);
    } catch (caught) {
      const message = errorMessage(caught);
      setSubmitError(message);
      notifyError(message);
    }
  };

  return (
    <div className="review-session-dialog-backdrop" {...{ [captureExcludeAttribute]: "" }}>
      <section
        className="review-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "create" ? "レビューセッションの作成" : "レビューセッションの編集"}
      >
        <header className="review-session-dialog-header">
          <div>
            <p className="eyebrow">レビュー管理</p>
            <h2>{mode === "create" ? "レビューセッションを作成" : "レビューセッションを編集"}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="セッション管理を閉じる" disabled={pending} onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <form className="review-session-form" noValidate onSubmit={handleSubmit((values) => void submit(values))}>
          {submitError ? <p className="notice error review-session-form-wide" role="alert">{submitError}</p> : null}
          <label className="review-session-form-wide">
            タイトル <span className="form-field-required" aria-hidden="true">*</span>
            <input autoFocus {...register("title")} aria-invalid={Boolean(errors.title)} />
            {errors.title ? <span className="field-error" role="alert">{errors.title.message}</span> : null}
          </label>
          <label className="review-session-form-wide">
            説明
            <textarea rows={3} {...register("description")} />
          </label>
          <label>
            状態
            <select {...register("status")} aria-invalid={Boolean(errors.status)}>
              {(Object.entries(reviewSessionStatusLabels) as Array<[ReviewSession["status"], string]>).map(([value, label]) => (
                <option value={value} key={value}>{label}</option>
              ))}
            </select>
            {errors.status ? <span className="field-error" role="alert">{errors.status.message}</span> : null}
            {selectedStatus === "open" ? <small>保存後、コメント受付が始まります。</small> : null}
          </label>
          <label>
            証跡保存日数
            <input type="number" min={1} max={3650} placeholder="プロジェクト既定を継承" {...register("evidenceRetentionDays")} />
            {errors.evidenceRetentionDays ? (
              <span className="field-error" role="alert">{errors.evidenceRetentionDays.message}</span>
            ) : null}
          </label>
          <label>
            開始日時
            <input type="datetime-local" {...register("startAt")} />
          </label>
          <label>
            終了日時
            <input type="datetime-local" {...register("endAt")} aria-invalid={Boolean(errors.endAt)} />
            {errors.endAt ? <span className="field-error" role="alert">{errors.endAt.message}</span> : null}
          </label>

          <fieldset className="review-session-form-section review-session-form-wide">
            <legend>レビュー観点</legend>
            <p>「未使用」はセッションのガイドに表示しません。受付中には「今回確認」が1つ以上必要です。</p>
            <div className="review-perspective-editor-list">
              {defaultValues.perspectives.map((perspective, index) => (
                <div className="review-perspective-editor-row" key={perspective.code}>
                  <input type="hidden" {...register(`perspectives.${index}.code`)} />
                  <input type="hidden" {...register(`perspectives.${index}.label`)} />
                  <span>
                    <strong>{perspective.label}</strong>
                    {definitions[index]?.description ? <small>{definitions[index].description}</small> : null}
                  </span>
                  <label>
                    扱い
                    <select {...register(`perspectives.${index}.status`)}>
                      <option value="">未使用</option>
                      <option value="ACTIVE">今回確認</option>
                      <option value="FUTURE">今後確認</option>
                      <option value="OUT_OF_SCOPE">今回対象外</option>
                    </select>
                  </label>
                  <label>
                    補足
                    <input placeholder="顧客へ見せる補足" {...register(`perspectives.${index}.guidance`)} />
                  </label>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset className="review-session-form-section review-session-form-wide">
            <legend>対象画面</legend>
            <p>
              ホストアプリがSDKへ登録したルート一覧です。詳細画面は実データごとではなく
              <code>/zones/{"{id}"}</code> のようなテンプレート単位で指定します。
            </p>
            <div className="review-scope-selection-actions">
              <span>{selectedScopeCount} / {pageOptions.length} 画面を選択中</span>
              <button
                type="button"
                className="subtle-button"
                onClick={() => pageOptions.forEach((_, index) => setValue(`scopes.${index}.selected`, true))}
              >
                すべて選択
              </button>
              <button
                type="button"
                className="subtle-button"
                onClick={() => pageOptions.forEach((_, index) => setValue(`scopes.${index}.selected`, false))}
              >
                すべて解除
              </button>
            </div>
            <div className="review-scope-editor-list">
              {pageOptionsByGroup.map(([group, options]) => (
                <section className="review-scope-route-group" aria-label={group} key={group}>
                  <h3>{group}</h3>
                  <div>
                    {options.map((option) => {
                      const index = pageOptions.findIndex(
                        (candidate) => reviewPageOptionKey(candidate) === reviewPageOptionKey(option)
                      );
                      return (
                        <label className="review-scope-checkbox" key={reviewPageOptionKey(option)}>
                          <input type="checkbox" {...register(`scopes.${index}.selected`)} />
                          <span>
                            <strong>{option.label}</strong>
                            <code>{option.route}</code>
                          </span>
                          <input type="hidden" {...register(`scopes.${index}.pageId`)} />
                          <input type="hidden" {...register(`scopes.${index}.route`)} />
                          <input type="hidden" {...register(`scopes.${index}.description`)} />
                          <input type="hidden" {...register(`scopes.${index}.reviewable`)} />
                        </label>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </fieldset>

          <footer className="review-session-dialog-actions review-session-form-wide">
            <button type="button" className="subtle-button" disabled={pending} onClick={onClose}>キャンセル</button>
            <button type="submit" className="command-button" disabled={pending}>
              {pending ? "保存中..." : mode === "create" ? "セッションを作成" : "変更を保存"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function formValuesFromSession(
  session: ReviewSession | null,
  definitions: ReviewPerspectiveDefinition[],
  pageOptions: ReviewPageCatalogOption[]
): ReviewSessionFormValues {
  const existingByCode = new Map(session?.perspectives.map((item) => [item.code, item]) ?? []);
  const knownCodes = new Set(definitions.map((item) => item.code));
  const allDefinitions = [
    ...definitions,
    ...(session?.perspectives ?? [])
      .filter((item) => !knownCodes.has(item.code))
      .map((item) => ({
        code: item.code,
        label: item.label,
        description: item.description,
        displayOrder: item.displayOrder
      }))
  ];
  return {
    title: session?.title ?? "",
    description: session?.description ?? "",
    status: session?.status ?? "draft",
    startAt: toDateTimeLocal(session?.startAt),
    endAt: toDateTimeLocal(session?.endAt),
    evidenceRetentionDays: session?.evidenceRetentionDays?.toString() ?? "",
    perspectives: allDefinitions.map((definition) => {
      const existing = existingByCode.get(definition.code);
      return {
        code: definition.code,
        label: definition.label,
        status: existing?.status ?? "",
        guidance: existing?.guidance ?? ""
      };
    }),
    scopes: pageOptions.map((option) => {
      const existing = session?.scopes.find(
        (scope) => scope.pageId === option.pageId && (scope.route === null || scope.route === option.route)
      );
      return {
        selected: session ? Boolean(existing) : true,
        pageId: option.pageId,
        route: option.route,
        description: existing?.description ?? option.label,
        reviewable: existing?.reviewable ?? true
      };
    })
  };
}

function requestFromForm(values: ReviewSessionFormValues): Omit<ReviewSessionCreateRequest, "projectId"> {
  const perspectives: ReviewPerspectiveWriteRequest[] = values.perspectives.flatMap((perspective) =>
    perspective.status === ""
      ? []
      : [{
          code: perspective.code,
          status: perspective.status,
          guidance: perspective.guidance || null
        }]
  );
  const scopes: ReviewScopeWriteRequest[] = values.scopes.flatMap((scope) =>
    scope.selected
      ? [{
          pageId: scope.pageId,
          route: scope.route,
          description: scope.description || null,
          reviewable: scope.reviewable
        }]
      : []
  );
  return {
    title: values.title,
    description: values.description || null,
    status: values.status,
    startAt: toIsoTimestamp(values.startAt),
    endAt: toIsoTimestamp(values.endAt),
    evidenceRetentionDays: values.evidenceRetentionDays === "" ? null : Number(values.evidenceRetentionDays),
    perspectives,
    scopes
  };
}

function withLegacyPageOptions(
  options: readonly ReviewPageCatalogOption[],
  scopes: ReviewSession["scopes"]
): ReviewPageCatalogOption[] {
  const known = new Set(options.map(reviewPageOptionKey));
  const legacy = scopes.flatMap((scope) => {
    const route = scope.route ?? options.find((option) => option.pageId === scope.pageId)?.route ?? scope.pageId;
    const candidate = {
      pageId: scope.pageId,
      route,
      label: scope.description || route || scope.pageId,
      group: "以前の設定"
    } satisfies ReviewPageCatalogOption;
    return known.has(reviewPageOptionKey(candidate)) ? [] : [candidate];
  });
  return [...options, ...legacy];
}

function groupPageOptions(options: ReviewPageCatalogOption[]): Array<[string, ReviewPageCatalogOption[]]> {
  const groups = new Map<string, ReviewPageCatalogOption[]>();
  for (const option of options) {
    const items = groups.get(option.group) ?? [];
    items.push(option);
    groups.set(option.group, items);
  }
  return [...groups.entries()];
}

function toDateTimeLocal(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIsoTimestamp(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
