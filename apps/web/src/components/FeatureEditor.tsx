import { Loader2, Save, X } from "lucide-react";
import type { Layer } from "../contracts";
import { editableFeatureAttributes } from "../utils";

export function FeatureEditor({
  layer,
  propertyDraft,
  setPropertyDraft,
  geometryDraft,
  setGeometryDraft,
  saving,
  onCancel,
  onSave
}: {
  layer: Layer;
  propertyDraft: Record<string, string>;
  setPropertyDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  geometryDraft: string;
  setGeometryDraft: React.Dispatch<React.SetStateAction<string>>;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const editableAttributes = editableFeatureAttributes(layer);
  return (
    <div className="feature-editor">
      {editableAttributes.length ? (
        <div className="feature-editor-fields">
          {editableAttributes.map((attribute) => (
            <label key={attribute.name}>
              {attribute.name}
              <input
                value={propertyDraft[attribute.name] ?? ""}
                onChange={(event) =>
                  setPropertyDraft((current) => ({
                    ...current,
                    [attribute.name]: event.target.value
                  }))
                }
              />
            </label>
          ))}
        </div>
      ) : (
        <p className="empty-state compact">編集可能な属性はありません</p>
      )}
      <label>
        GeoJSON
        <textarea value={geometryDraft} onChange={(event) => setGeometryDraft(event.target.value)} spellCheck={false} />
      </label>
      <div className="button-row">
        <button className="subtle-button" type="button" onClick={onCancel}>
          <X size={15} />
          閉じる
        </button>
        <button className="command-button" type="button" onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
          保存
        </button>
      </div>
    </div>
  );
}
