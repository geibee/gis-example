import { Layers, Map as MapIcon, Search, X } from "lucide-react";
import type { BusinessObjectFilters, Feature, Layer } from "../types";
import { businessStatusOptions, partyTypeOptions, relationTypeOptions } from "../constants";
import { ChoiceSelect } from "./ChoiceSelect";

export function BusinessFilterPanel({
  kind,
  filters,
  setFilters,
  open,
  setOpen,
  layers,
  selectedFeature,
  selectedFeatureLayer,
  onUseMapBounds,
  onUseSelectedFeature,
  statusOptions = businessStatusOptions,
  useOptions = [],
  partyTypeOptions: partyTypeChoices = partyTypeOptions,
  relationTypeOptions: relationChoices = relationTypeOptions
}: {
  kind: "land" | "building" | "party";
  filters: BusinessObjectFilters;
  setFilters: React.Dispatch<React.SetStateAction<BusinessObjectFilters>>;
  open: boolean;
  setOpen: (value: boolean) => void;
  layers: Layer[];
  selectedFeature: Feature | null;
  selectedFeatureLayer: Layer | null;
  onUseMapBounds?: () => void;
  onUseSelectedFeature?: () => void;
  statusOptions?: string[];
  useOptions?: string[];
  partyTypeOptions?: string[];
  relationTypeOptions?: string[];
}) {
  const update = (key: keyof BusinessObjectFilters, value: string | boolean | undefined) => {
    setFilters((current) => ({ ...current, [key]: value === "" ? undefined : value }));
  };
  const resetSpatial = () => {
    setFilters((current) => ({
      ...current,
      bbox: undefined,
      intersectsLayerId: undefined,
      intersectsFeatureId: undefined,
      distanceMeters: undefined
    }));
  };
  const hasSpatialFilter = Boolean(filters.bbox || filters.intersectsLayerId || filters.intersectsFeatureId);
  return (
    <div className="business-filter-panel">
      <button className="subtle-button" type="button" onClick={() => setOpen(!open)}>
        <Search size={14} />
        {open ? "詳細条件を閉じる" : "詳細条件を表示"}
      </button>
      {open ? (
        <div className="business-filter-fields">
          {kind !== "party" ? (
            <>
              <label>
                ステータス
                <ChoiceSelect
                  value={filters.status ?? ""}
                  onChange={(value) => update("status", value)}
                  options={statusOptions}
                />
              </label>
              <label>
                {kind === "land" ? "地目/用途" : "用途"}
                <ChoiceSelect
                  value={kind === "land" ? filters.landUse ?? "" : filters.buildingUse ?? ""}
                  onChange={(value) => update(kind === "land" ? "landUse" : "buildingUse", value)}
                  options={useOptions}
                />
              </label>
            </>
          ) : (
            <>
              <label>
                種別
                <ChoiceSelect
                  value={filters.partyType ?? ""}
                  onChange={(value) => update("partyType", value)}
                  options={partyTypeChoices}
                />
              </label>
              <label>
                対象
                <select value={filters.targetType ?? ""} onChange={(event) => update("targetType", event.target.value as BusinessObjectFilters["targetType"])}>
                  <option value="">土地/建物</option>
                  <option value="land">土地</option>
                  <option value="building">建物</option>
                </select>
              </label>
            </>
          )}
          {kind !== "party" ? (
            <label>
              関係者種別
              <ChoiceSelect
                value={filters.partyType ?? ""}
                onChange={(value) => update("partyType", value)}
                options={partyTypeChoices}
              />
            </label>
          ) : null}
          <label>
            関係種別
            <ChoiceSelect
              value={filters.relationType ?? ""}
              onChange={(value) => update("relationType", value)}
              options={relationChoices}
            />
          </label>
          <label className="checkbox-field filter-checkbox">
            <input
              type="checkbox"
              checked={filters.linkedOnly ?? false}
              onChange={(event) => update("linkedOnly", event.target.checked)}
            />
            <span>{kind === "party" ? "関係ありのみ" : "GISリンクありのみ"}</span>
          </label>
          {kind !== "party" ? (
            <>
              <label>
                GISレイヤ
                <select value={filters.sourceLayerId ?? ""} onChange={(event) => update("sourceLayerId", event.target.value)}>
                  <option value="">すべて</option>
                  {layers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="filter-command-row">
                <button className="subtle-button" type="button" onClick={onUseMapBounds}>
                  <MapIcon size={14} />
                  表示範囲
                </button>
                <button className="subtle-button" type="button" onClick={onUseSelectedFeature}>
                  <Layers size={14} />
                  選択地物
                </button>
                {hasSpatialFilter ? (
                  <button className="icon-button" type="button" onClick={resetSpatial} title="空間条件を解除">
                    <X size={14} />
                  </button>
                ) : null}
              </div>
              <label>
                近接距離(m)
                <input
                  value={filters.distanceMeters ?? ""}
                  onChange={(event) => update("distanceMeters", event.target.value)}
                  inputMode="decimal"
                />
              </label>
              <p className="filter-summary">
                {filters.bbox ? "表示範囲指定中" : "表示範囲なし"}
                {filters.intersectsFeatureId
                  ? ` / ${selectedFeatureLayer?.name ?? filters.intersectsLayerId} #${selectedFeature?.featureId ?? filters.intersectsFeatureId}`
                  : " / 選択地物なし"}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
