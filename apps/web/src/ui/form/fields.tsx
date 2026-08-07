import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from "react";
import { mergeChoiceOptions } from "../../utils";
import { feedbackTargetAttribute } from "../../review/types";

// フォーム共通のフィールド部品。ラベル・必須マーク・エラー表示・aria 属性を統一する。
// react-hook-form とは `{...register("name")}` をそのまま展開して組み合わせる:
//
//   <TextField label="名称" required error={errors.name?.message} {...register("name")} />
//
// エラー文言はフィールドの zod スキーマ (日本語メッセージ) 側で持つ。
type FieldOwnProps = {
  label: ReactNode;
  /**
   * レビューのコメント対象としての安定 ID (docs/prototype-review.md 3.3)。
   * 未指定なら name から導出するため、通常のフォームは何も書かなくてよい。
   * 同じ name の項目が 1 画面に複数ある場合だけ明示する
   */
  feedbackId?: string;
  /** 必須マーク (*) を出し aria-required を付ける。検証自体は zod スキーマが行う */
  required?: boolean;
  /** バリデーションエラー文言。指定時は aria-invalid + role=alert で表示する */
  error?: string;
  /** 2 カラムグリッド (object-form) で全幅を使う */
  wide?: boolean;
};

function fieldClassName(wide?: boolean) {
  return wide ? "form-field wide-field" : "form-field";
}

/**
 * フィールドの安定 ID を属性として返す。react-hook-form の name をそのまま使うので、
 * 画面ごとに ID を手で振らなくてもコメントを項目に紐づけられる。
 * 「この項目は必要ですか？」という指摘が、DOM 構造の変更で迷子にならないことが目的
 */
function feedbackAttribute(feedbackId: string | undefined, name: string | undefined) {
  const id = feedbackId ?? name;
  return id ? { [feedbackTargetAttribute]: id } : {};
}

function FieldLabel({ label, required }: { label: ReactNode; required?: boolean }) {
  return (
    <span className="form-field-label">
      {label}
      {required ? (
        <span className="form-field-required" aria-hidden="true">
          *
        </span>
      ) : null}
    </span>
  );
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <p className="field-error" id={id} role="alert">
      {error}
    </p>
  );
}

function fieldAria(required: boolean | undefined, error: string | undefined, errorId: string) {
  return {
    "aria-required": required || undefined,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? errorId : undefined
  } as const;
}

export type TextFieldProps = FieldOwnProps & InputHTMLAttributes<HTMLInputElement>;

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, required, error, wide, feedbackId, ...inputProps },
  ref
) {
  const errorId = useId();
  return (
    <label className={fieldClassName(wide)} {...feedbackAttribute(feedbackId, inputProps.name)}>
      <FieldLabel label={label} required={required} />
      <input ref={ref} {...fieldAria(required, error, errorId)} {...inputProps} />
      <FieldError id={errorId} error={error} />
    </label>
  );
});

// 数値入力。値は文字列のまま扱い、数値化は zod スキーマ側 (coerce 等) で行う
export const NumberField = forwardRef<HTMLInputElement, TextFieldProps>(function NumberField(
  { inputMode = "decimal", ...props },
  ref
) {
  return <TextField ref={ref} inputMode={inputMode} {...props} />;
});

export type TextAreaFieldProps = FieldOwnProps & TextareaHTMLAttributes<HTMLTextAreaElement>;

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(function TextAreaField(
  { label, required, error, wide, feedbackId, ...textareaProps },
  ref
) {
  const errorId = useId();
  return (
    <label className={fieldClassName(wide)} {...feedbackAttribute(feedbackId, textareaProps.name)}>
      <FieldLabel label={label} required={required} />
      <textarea ref={ref} {...fieldAria(required, error, errorId)} {...textareaProps} />
      <FieldError id={errorId} error={error} />
    </label>
  );
});

export type SelectFieldProps = FieldOwnProps &
  SelectHTMLAttributes<HTMLSelectElement> & {
    /** 選択肢。現在値が options にない場合も選択肢として補われる (ChoiceSelect と同じ挙動) */
    options: string[];
    /** 先頭の空選択肢のラベル。null で空選択肢なし */
    emptyLabel?: string | null;
    /** 補完対象の現在値 (RHF では useWatch せず defaultValue や getValues で渡す) */
    currentValue?: string;
  };

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, required, error, wide, feedbackId, options, emptyLabel = "選択", currentValue, ...selectProps },
  ref
) {
  const errorId = useId();
  const normalizedOptions = mergeChoiceOptions(options, currentValue);
  return (
    <label className={fieldClassName(wide)} {...feedbackAttribute(feedbackId, selectProps.name)}>
      <FieldLabel label={label} required={required} />
      <select ref={ref} {...fieldAria(required, error, errorId)} {...selectProps}>
        {emptyLabel !== null ? <option value="">{emptyLabel}</option> : null}
        {normalizedOptions.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <FieldError id={errorId} error={error} />
    </label>
  );
});
