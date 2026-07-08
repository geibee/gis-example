import { type FormEvent, useMemo } from "react";
import { Loader2, Plus, Save, Search, X } from "lucide-react";
import type {
  Building,
  Feature,
  FeatureSearchResult,
  Land,
  Layer,
  Party
} from "../contracts";
import type {
  AttributeConditionDraft,
  SpatialConditionDraft,
  ZoneBusinessSourceType
} from "../appTypes";
import { buildingUseOptions, businessStatusOptions, landUseOptions, partyTypeOptions } from "../constants";
import {
  featureResultBusinessSummary,
  featureResultSummary,
  groupFeatureResults,
  mergeChoiceOptions,
  relationshipTypeChoices
} from "../utils";
import { ChoiceSelect } from "./ChoiceSelect";
import { ConditionEditor } from "./ConditionEditor";

export function ZoneSearchPanel({
  layers,
  layerById,
  lands,
  buildings,
  parties,
  resultName,
  setResultName,
  query,
  setQuery,
  builderOpen,
  setBuilderOpen,
  attributeConditions,
  setAttributeConditions,
  spatialConditions,
  setSpatialConditions,
  onAddAttribute,
  onAddSpatial,
  linkedOnly,
  setLinkedOnly,
  spatialLayerIds,
  setSpatialLayerIds,
  businessSourceType,
  setBusinessSourceType,
  businessQuery,
  setBusinessQuery,
  businessStatus,
  setBusinessStatus,
  landUse,
  setLandUse,
  buildingUse,
  setBuildingUse,
  partyQuery,
  setPartyQuery,
  partyType,
  setPartyType,
  relationType,
  setRelationType,
  loading,
  saving,
  results,
  selectedFeature,
  onSearch,
  onSave,
  onClear,
  onSelect
}: {
  layers: Layer[];
  layerById: Map<string, Layer>;
  lands: Land[];
  buildings: Building[];
  parties: Party[];
  resultName: string;
  setResultName: (value: string) => void;
  query: string;
  setQuery: (value: string) => void;
  builderOpen: boolean;
  setBuilderOpen: (value: boolean) => void;
  attributeConditions: AttributeConditionDraft[];
  setAttributeConditions: React.Dispatch<React.SetStateAction<AttributeConditionDraft[]>>;
  spatialConditions: SpatialConditionDraft[];
  setSpatialConditions: React.Dispatch<React.SetStateAction<SpatialConditionDraft[]>>;
  onAddAttribute: () => void;
  onAddSpatial: () => void;
  linkedOnly: boolean;
  setLinkedOnly: (value: boolean) => void;
  spatialLayerIds: string[];
  setSpatialLayerIds: React.Dispatch<React.SetStateAction<string[]>>;
  businessSourceType: ZoneBusinessSourceType;
  setBusinessSourceType: (value: ZoneBusinessSourceType) => void;
  businessQuery: string;
  setBusinessQuery: (value: string) => void;
  businessStatus: string;
  setBusinessStatus: (value: string) => void;
  landUse: string;
  setLandUse: (value: string) => void;
  buildingUse: string;
  setBuildingUse: (value: string) => void;
  partyQuery: string;
  setPartyQuery: (value: string) => void;
  partyType: string;
  setPartyType: (value: string) => void;
  relationType: string;
  setRelationType: (value: string) => void;
  loading: boolean;
  saving: boolean;
  results: FeatureSearchResult[];
  selectedFeature: Feature | null;
  onSearch: () => void;
  onSave: () => void;
  onClear: () => void;
  onSelect: (result: FeatureSearchResult) => void;
}) {
  const groupedResults = groupFeatureResults(results);
  const toggleSpatialLayer = (id: string, checked: boolean) => {
    setSpatialLayerIds((current) => {
      if (checked) return current.includes(id) ? current : [...current, id];
      return current.filter((item) => item !== id);
    });
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSearch();
  };
  const searchDisabled = loading || !spatialLayerIds.length;
  const statusChoices = useMemo(
    () => mergeChoiceOptions(businessStatusOptions, lands.map((land) => land.status), buildings.map((building) => building.status), businessStatus),
    [buildings, businessStatus, lands]
  );
  const landUseChoices = useMemo(
    () => mergeChoiceOptions(landUseOptions, lands.map((land) => land.landUse), landUse),
    [landUse, lands]
  );
  const buildingUseChoices = useMemo(
    () => mergeChoiceOptions(buildingUseOptions, buildings.map((building) => building.buildingUse), buildingUse),
    [buildingUse, buildings]
  );
  const partyNameChoices = useMemo(
    () => mergeChoiceOptions([], parties.map((party) => party.name), partyQuery),
    [parties, partyQuery]
  );
  const partyTypeChoices = useMemo(
    () => mergeChoiceOptions(partyTypeOptions, parties.map((party) => party.partyType), partyType),
    [parties, partyType]
  );
  const relationTypeChoices = useMemo(
    () => relationshipTypeChoices(lands, buildings, parties),
    [buildings, lands, parties]
  );
  const businessKeywordChoices = useMemo(() => {
    const landChoices =
      businessSourceType === "building"
        ? []
        : lands.flatMap((land) => [land.id, land.lotNumber, land.address, land.landUse, land.status]);
    const buildingChoices =
      businessSourceType === "land"
        ? []
        : buildings.flatMap((building) => [
            building.id,
            building.name,
            building.landLabel,
            building.buildingLocation,
            building.buildingUse,
            building.structure,
            building.status
          ]);
    return mergeChoiceOptions([], landChoices, buildingChoices, businessQuery).slice(0, 120);
  }, [buildings, businessQuery, businessSourceType, lands]);
  const handleBusinessSourceTypeChange = (value: ZoneBusinessSourceType) => {
    setBusinessSourceType(value);
    if (value !== "land") setLandUse("");
    if (value !== "building") setBuildingUse("");
  };

  return (
    <section className="panel-section zone-search-section">
      <div className="section-title">
        <Search size={16} />
        <h2>条件検索</h2>
        {loading ? <Loader2 className="spin muted-icon" size={15} /> : null}
      </div>
      <form className="zone-search-form" onSubmit={handleSubmit}>
        <label className="search-field">
          キーワード
          <span>
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} />
          </span>
        </label>

        <div className="mini-heading">
          <span>対象レイヤ</span>
          <small>{spatialLayerIds.length.toLocaleString()}件選択</small>
        </div>
        <div className="zone-layer-checks compact-layer-checks" aria-label="対象レイヤ">
          {layers.map((layer) => (
            <label className="checkbox-field layer-check" key={layer.id}>
              <input
                type="checkbox"
                checked={spatialLayerIds.includes(layer.id)}
                onChange={(event) => toggleSpatialLayer(layer.id, event.target.checked)}
              />
              <span>{layer.name}</span>
            </label>
          ))}
          {!layers.length ? <p className="empty-state compact">対象レイヤはありません</p> : null}
        </div>

        <div className="button-row">
          <button className="subtle-button" type="button" onClick={() => setBuilderOpen(!builderOpen)}>
            <Plus size={15} />
            条件を追加
          </button>
          <button className="subtle-button" type="button" onClick={onClear}>
            <X size={15} />
            条件クリア
          </button>
          <button className="command-button" type="submit" disabled={searchDisabled}>
            {loading ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
            検索
          </button>
        </div>

        {builderOpen ? (
          <div className="condition-builder">
            <div className="condition-builder-heading">
              <span>属性条件</span>
              <button className="subtle-button" type="button" onClick={onAddAttribute}>
                <Plus size={14} />
                属性
              </button>
            </div>
            <div className="condition-builder-heading">
              <span>空間条件</span>
              <button className="subtle-button" type="button" onClick={onAddSpatial}>
                <Plus size={14} />
                空間
              </button>
            </div>
            <ConditionEditor
              layers={layers}
              layerById={layerById}
              attributeConditions={attributeConditions}
              setAttributeConditions={setAttributeConditions}
              spatialConditions={spatialConditions}
              setSpatialConditions={setSpatialConditions}
            />

            <div className="condition-builder-heading">
              <span>業務条件</span>
              <label className="checkbox-field">
                <input type="checkbox" checked={linkedOnly} onChange={(event) => setLinkedOnly(event.target.checked)} />
                <span>使用</span>
              </label>
            </div>
            <div className="zone-condition-grid business-filter-grid">
              <label>
                業務対象
                <select
                  value={businessSourceType}
                  onChange={(event) => handleBusinessSourceTypeChange(event.target.value as ZoneBusinessSourceType)}
                >
                  <option value="all">土地または建物</option>
                  <option value="land">土地</option>
                  <option value="building">建物</option>
                </select>
              </label>
              <label>
                ステータス
                <ChoiceSelect value={businessStatus} onChange={setBusinessStatus} options={statusChoices} />
              </label>
              {businessSourceType === "land" ? (
                <label>
                  土地用途
                  <ChoiceSelect value={landUse} onChange={setLandUse} options={landUseChoices} />
                </label>
              ) : null}
              {businessSourceType === "building" ? (
                <label>
                  建物用途
                  <ChoiceSelect value={buildingUse} onChange={setBuildingUse} options={buildingUseChoices} />
                </label>
              ) : null}
              <label className="search-field">
                業務キーワード
                <span>
                  <Search size={15} />
                  <input
                    value={businessQuery}
                    onChange={(event) => setBusinessQuery(event.target.value)}
                    list="zone-business-keyword-options"
                  />
                </span>
                <datalist id="zone-business-keyword-options">
                  {businessKeywordChoices.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </label>
            </div>
            <div className="zone-condition-grid business-party-grid">
              <label>
                事業者
                <ChoiceSelect value={partyQuery} onChange={setPartyQuery} options={partyNameChoices} />
              </label>
              <label>
                種別
                <ChoiceSelect value={partyType} onChange={setPartyType} options={partyTypeChoices} />
              </label>
              <label>
                関係
                <ChoiceSelect value={relationType} onChange={setRelationType} options={relationTypeChoices} />
              </label>
            </div>
          </div>
        ) : null}
      </form>

      <div className="zone-search-results" aria-live="polite">
        {results.length ? <div className="zone-result-summary">検索結果 {results.length.toLocaleString()}件</div> : null}
        {groupedResults.map((group) => (
          <div className="zone-result-group" key={group.layerId}>
            <div className="zone-result-group-heading">
              <strong>{group.layerName}</strong>
              <span>{group.results.length.toLocaleString()}件</span>
            </div>
            {group.results.map((result) => {
              const active = selectedFeature?.layerId === result.layerId && selectedFeature.featureId === result.featureId;
              return (
                <button
                  className={`zone-result-row${active ? " active" : ""}`}
                  key={`${result.layerId}:${result.featureId}`}
                  type="button"
                  onClick={() => onSelect(result)}
                >
                  <strong>ID {result.featureId}</strong>
                  <span>{result.matchSummary ?? "一致"}</span>
                  <em>{featureResultSummary(result)}</em>
                  <small>{featureResultBusinessSummary(result)}</small>
                </button>
              );
            })}
          </div>
        ))}
        {!results.length ? <p className="empty-state compact">検索結果はありません</p> : null}
      </div>

      {results.length ? (
        <div className="save-search-result">
          <label>
            結果名
            <input
              value={resultName}
              onChange={(event) => setResultName(event.target.value)}
              placeholder="条件検索結果名"
            />
          </label>
          <button className="command-button" type="button" onClick={onSave} disabled={saving}>
            {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
            結果として保存
          </button>
        </div>
      ) : null}
    </section>
  );
}
