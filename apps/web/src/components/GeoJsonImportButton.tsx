import { useRef } from "react";
import { Loader2, Upload } from "lucide-react";

export function GeoJsonImportButton({
  importing,
  onSelect
}: {
  importing: boolean;
  onSelect: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        className="icon-button"
        type="button"
        onClick={() => inputRef.current?.click()}
        title="GeoJSON取込"
        aria-label="GeoJSON取込"
        disabled={importing}
      >
        {importing ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".geojson,.json,application/geo+json,application/json"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onSelect(file);
        }}
      />
    </>
  );
}
