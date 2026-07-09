import { Search } from "lucide-react";
import type { Layer } from "../contracts";
import type { BusinessObjectFilters } from "../appTypes";
import { zoneLayerOptions } from "../utils";
import { ChoiceSelect } from "./ChoiceSelect";

export function ZoneFilterPanel({
  filters,
  setFilters,
  open,
  setOpen,
  layers,
  statusOptions,
  typeOptions
}: {
  filters: BusinessObjectFilters;
  setFilters: React.Dispatch<React.SetStateAction<BusinessObjectFilters>>;
  open: boolean;
  setOpen: (value: boolean) => void;
  layers: Layer[];
  statusOptions: string[];
  typeOptions: string[];
}) {
  const update = (key: keyof BusinessObjectFilters, value: string | boolean | undefined) => {
    setFilters((current) => ({ ...current, [key]: value === "" ? undefined : value }));
  };
  const sourceLayers = zoneLayerOptions(layers);
  return (
    <div className="business-filter-panel">
      <button className="subtle-button" type="button" onClick={() => setOpen(!open)}>
        <Search size={14} />
        {open ? "詳細条件を閉じる" : "詳細条件を表示"}
      </button>
      {open ? (
        <div className="business-filter-fields">
          <label>
            ステータス
            <ChoiceSelect value={filters.status ?? ""} onChange={(value) => update("status", value)} options={statusOptions} />
          </label>
          <label>
            種別
            <ChoiceSelect value={filters.zoneType ?? ""} onChange={(value) => update("zoneType", value)} options={typeOptions} />
          </label>
          <label>
            区域レイヤ
            <select value={filters.zoneLayerId ?? ""} onChange={(event) => update("zoneLayerId", event.target.value)}>
              <option value="">すべて</option>
              {sourceLayers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name} ({layer.geometryType})
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-field filter-checkbox">
            <input type="checkbox" checked={filters.linkedOnly ?? false} onChange={(event) => update("linkedOnly", event.target.checked)} />
            <span>区域地物ありのみ</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}
