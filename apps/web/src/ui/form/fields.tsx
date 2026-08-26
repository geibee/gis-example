import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from "react";
import { mergeChoiceOptions } from "../../utils";

// フォーム共通のフィールド部品。ラベル・必須マーク・エラー表示・aria 属性を統一する。
// react-hook-form とは `{...register("name")}` をそのまま展開して組み合わせる:
//
//   <TextField label="名称" required error={errors.name?.message} {...register("name")} />
//
// エラー文言はフィールドの zod スキーマ (日本語メッセージ) 側で持つ。
type FieldOwnProps = {
  label: ReactNode;
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
  { label, required, error, wide, ...inputProps },
  ref
) {
  const errorId = useId();
  return (
    <label className={fieldClassName(wide)}>
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
  { label, required, error, wide, ...textareaProps },
  ref
) {
  const errorId = useId();
  return (
    <label className={fieldClassName(wide)}>
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
  { label, required, error, wide, options, emptyLabel = "選択", currentValue, ...selectProps },
  ref
) {
  const errorId = useId();
  const normalizedOptions = mergeChoiceOptions(options, currentValue);
  return (
    <label className={fieldClassName(wide)}>
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
