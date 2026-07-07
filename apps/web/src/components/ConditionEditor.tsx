import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { getLayerAttributeValues } from "../api";
import type { AttributeConditionDraft, Layer, SpatialConditionDraft } from "../types";
import { attributeOperators, conditionSpatialOperators } from "../constants";
import { attributeValueOptionKey } from "../utils";
import { ChoiceSelect } from "./ChoiceSelect";

export function ConditionEditor({
  layers,
  layerById,
  attributeConditions,
  setAttributeConditions,
  spatialConditions,
  setSpatialConditions
}: {
  layers: Layer[];
  layerById: Map<string, Layer>;
  attributeConditions: AttributeConditionDraft[];
  setAttributeConditions: React.Dispatch<React.SetStateAction<AttributeConditionDraft[]>>;
  spatialConditions: SpatialConditionDraft[];
  setSpatialConditions: React.Dispatch<React.SetStateAction<SpatialConditionDraft[]>>;
}) {
  const [attributeValueOptions, setAttributeValueOptions] = useState<Record<string, string[]>>({});
  const attributeValueLookups = useMemo(
    () =>
      Array.from(
        new Map(
          attributeConditions
            .filter((condition) => condition.layerId && condition.field && condition.operator !== "IS NULL")
            .map((condition) => [
              attributeValueOptionKey(condition.layerId, condition.field),
              { key: attributeValueOptionKey(condition.layerId, condition.field), layerId: condition.layerId, field: condition.field }
            ])
        ).values()
      ),
    [attributeConditions]
  );

  useEffect(() => {
    const pendingLookups = attributeValueLookups.filter((lookup) => !(lookup.key in attributeValueOptions));
    if (!pendingLookups.length) return;
    let cancelled = false;
    pendingLookups.forEach((lookup) => {
      void getLayerAttributeValues(lookup.layerId, lookup.field)
        .then((values) => {
          if (cancelled) return;
          setAttributeValueOptions((current) => (lookup.key in current ? current : { ...current, [lookup.key]: values }));
        })
        .catch(() => {
          if (cancelled) return;
          setAttributeValueOptions((current) => (lookup.key in current ? current : { ...current, [lookup.key]: [] }));
        });
    });
    return () => {
      cancelled = true;
    };
  }, [attributeValueLookups, attributeValueOptions]);

  const updateAttribute = (id: string, patch: Partial<AttributeConditionDraft>) => {
    setAttributeConditions((current) =>
      current.map((condition) => {
        if (condition.id !== id) return condition;
        const next = { ...condition, ...patch };
        if (patch.layerId !== undefined) {
          next.field = layerById.get(patch.layerId)?.attributes[0]?.name ?? "";
          next.value = "";
        }
        if (patch.field !== undefined) {
          next.value = "";
        }
        if (patch.operator === "IS NULL") {
          next.value = "";
        }
        return next;
      })
    );
  };

  return (
    <div className="conditions">
      {attributeConditions.map((condition) => {
        const fields = layerById.get(condition.layerId)?.attributes ?? [];
        const valueOptions = attributeValueOptions[attributeValueOptionKey(condition.layerId, condition.field)] ?? [];
        const exactValueOperator = condition.operator === "=" || condition.operator === "!=";
        const listId = `attribute-values-${condition.id}`;
        return (
          <div className="condition-row" key={condition.id}>
            <select value={condition.layerId} onChange={(event) => updateAttribute(condition.id, { layerId: event.target.value })}>
              {layers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))}
            </select>
            <select value={condition.field} onChange={(event) => updateAttribute(condition.id, { field: event.target.value })}>
              {fields.map((field) => (
                <option key={field.name} value={field.name}>
                  {field.name}
                </option>
              ))}
            </select>
            <select value={condition.operator} onChange={(event) => updateAttribute(condition.id, { operator: event.target.value })}>
              {attributeOperators.map((operator) => (
                <option key={operator} value={operator}>
                  {operator}
                </option>
              ))}
            </select>
            {condition.operator === "IS NULL" ? (
              <input value="" disabled placeholder="値なし" />
            ) : exactValueOperator && valueOptions.length ? (
              <ChoiceSelect value={condition.value} onChange={(value) => updateAttribute(condition.id, { value })} options={valueOptions} emptyLabel="値を選択" />
            ) : (
              <>
                <input
                  value={condition.value}
                  onChange={(event) => updateAttribute(condition.id, { value: event.target.value })}
                  list={listId}
                  placeholder={condition.operator === "IN" ? "候補をカンマ区切り" : undefined}
                />
                <datalist id={listId}>
                  {valueOptions.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </>
            )}
            <button
              className="icon-button"
              type="button"
              onClick={() => setAttributeConditions((current) => current.filter((item) => item.id !== condition.id))}
              title="条件削除"
            >
              <Trash2 size={15} />
            </button>
          </div>
        );
      })}

      {spatialConditions.map((condition) => (
        <div className="condition-row spatial" key={condition.id}>
          <select
            value={condition.comparisonTarget}
            onChange={(event) =>
              setSpatialConditions((current) =>
                current.map((item) =>
                  item.id === condition.id
                    ? { ...item, comparisonTarget: event.target.value as SpatialConditionDraft["comparisonTarget"] }
                    : item
                )
              )
            }
            aria-label="空間比較対象"
          >
            <option value="layer">レイヤ</option>
            <option value="business">業務データ</option>
          </select>
          <select
            value={condition.layerId}
            onChange={(event) =>
              setSpatialConditions((current) =>
                current.map((item) => (item.id === condition.id ? { ...item, layerId: event.target.value } : item))
              )
            }
            disabled={condition.comparisonTarget === "business"}
          >
            {condition.comparisonTarget === "business" ? (
              <option value="">業務条件に一致する土地/建物</option>
            ) : (
              layers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.name}
                </option>
              ))
            )}
          </select>
          <select
            value={condition.operator}
            onChange={(event) =>
              setSpatialConditions((current) =>
                current.map((item) => (item.id === condition.id ? { ...item, operator: event.target.value } : item))
              )
            }
          >
            {conditionSpatialOperators.map((operator) => (
              <option key={operator.value} value={operator.value}>
                {operator.label}
              </option>
            ))}
          </select>
          <input
            value={condition.operator === "dwithin" ? condition.distanceMeters : ""}
            onChange={(event) =>
              setSpatialConditions((current) =>
                current.map((item) => (item.id === condition.id ? { ...item, distanceMeters: event.target.value } : item))
              )
            }
            disabled={condition.operator !== "dwithin"}
            placeholder={condition.operator === "dwithin" ? "m" : "距離なし"}
            inputMode="decimal"
            aria-label="dwithin距離メートル"
          />
          <button
            className="icon-button"
            type="button"
            onClick={() => setSpatialConditions((current) => current.filter((item) => item.id !== condition.id))}
            title="条件削除"
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
