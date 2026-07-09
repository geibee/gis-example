import { useForm, useWatch, type Control } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { SelectField, TextAreaField, TextField } from "../ui/form/fields";
import { ObjectDetailHeader } from "./ObjectDetailHeader";

// 関係者の作成・編集フォーム。react-hook-form + zod によるフォーム実装の見本
// (docs/ui-guidelines.md 参照)。他 workspace のフォームを移行する際はこの形に合わせる:
//   - スキーマはフォームの近くに置き、エラーメッセージは日本語でスキーマ側に持つ
//   - フィールドは src/ui/form/ の共通部品 + register で宣言する
//   - useWatch はフォーム全体を購読せず、必要なフィールド名に限定して
//     子コンポーネント (ここでは PartyFormHeader) に隔離する
const partyFormSchema = z.object({
  id: z.string().trim(),
  name: z.string().trim().min(1, "名称を入力してください"),
  partyType: z.string().trim().min(1, "種別を選択してください"),
  contact: z.string(),
  address: z.string(),
  memo: z.string(),
  tags: z.string()
});

// 新規作成時のみ ID が必須になる
const partyCreateSchema = partyFormSchema.extend({
  id: z.string().trim().min(1, "IDを入力してください")
});

export type PartyFormValues = z.infer<typeof partyFormSchema>;

export const partyFormId = "party-form";

export function PartyForm({
  creating,
  defaultValues,
  partyTypeOptions,
  detailHref,
  onBack,
  onSubmit
}: {
  creating: boolean;
  defaultValues: PartyFormValues;
  partyTypeOptions: string[];
  detailHref?: string;
  onBack?: () => void;
  /** バリデーション済みの値のみで呼ばれる */
  onSubmit: (values: PartyFormValues) => void;
}) {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors }
  } = useForm<PartyFormValues>({
    resolver: zodResolver(creating ? partyCreateSchema : partyFormSchema),
    defaultValues
  });

  return (
    <>
      <PartyFormHeader control={control} creating={creating} detailHref={detailHref} onBack={onBack} />
      {/* 保存ボタン (ObjectActions) は関係一覧の下に置かれるため form= 属性で関連付ける */}
      <form id={partyFormId} className="object-form" noValidate onSubmit={handleSubmit(onSubmit)}>
        <TextField
          label="ID"
          required={creating}
          disabled={!creating}
          error={errors.id?.message}
          {...register("id")}
        />
        <TextField label="名称" required error={errors.name?.message} {...register("name")} />
        <SelectField
          label="種別"
          required
          options={partyTypeOptions}
          currentValue={defaultValues.partyType}
          emptyLabel="選択"
          error={errors.partyType?.message}
          {...register("partyType")}
        />
        <TextField label="連絡先" error={errors.contact?.message} {...register("contact")} />
        <TextField label="住所" wide error={errors.address?.message} {...register("address")} />
        <TextField
          label="タグ"
          wide
          placeholder="例: 外国人、競合（読点またはカンマ区切り）"
          error={errors.tags?.message}
          {...register("tags")}
        />
        <TextAreaField label="メモ" wide error={errors.memo?.message} {...register("memo")} />
      </form>
    </>
  );
}

// 入力中の名称・種別をヘッダへ即時反映する。useWatch の購読をこの子コンポーネントに
// 限定することで、キー入力のたびにフォーム全体が再レンダリングされるのを避ける。
function PartyFormHeader({
  control,
  creating,
  detailHref,
  onBack
}: {
  control: Control<PartyFormValues>;
  creating: boolean;
  detailHref?: string;
  onBack?: () => void;
}) {
  const id = useWatch({ control, name: "id" });
  const name = useWatch({ control, name: "name" });
  const partyType = useWatch({ control, name: "partyType" });
  return (
    <ObjectDetailHeader
      id={creating ? id || "新規関係者" : id}
      title={name || "関係者"}
      subtitle={partyType}
      href={detailHref}
      onBack={onBack}
    />
  );
}
