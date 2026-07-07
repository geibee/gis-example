import { mergeChoiceOptions } from "../utils";

export function ChoiceSelect({
  value,
  onChange,
  options,
  emptyLabel = "すべて"
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  emptyLabel?: string | null;
}) {
  const normalizedOptions = mergeChoiceOptions(options, value);
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {emptyLabel !== null ? <option value="">{emptyLabel}</option> : null}
      {normalizedOptions.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}
