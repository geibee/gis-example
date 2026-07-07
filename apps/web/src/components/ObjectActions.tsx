import { Loader2, Save, Trash2, X } from "lucide-react";

export function ObjectActions({
  saving,
  deleting,
  onSave,
  onDelete,
  onCancel,
  creating = false
}: {
  saving: boolean;
  deleting: boolean;
  onSave: () => void;
  onDelete?: () => void;
  onCancel?: () => void;
  creating?: boolean;
}) {
  return (
    <div className="object-actions">
      {creating && onCancel ? (
        <button className="subtle-button" type="button" onClick={onCancel} disabled={saving}>
          <X size={15} />
          キャンセル
        </button>
      ) : null}
      {!creating && onDelete ? (
        <button className="danger-button" type="button" onClick={onDelete} disabled={deleting || saving}>
          {deleting ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
          削除
        </button>
      ) : null}
      <button className="command-button" type="button" onClick={onSave} disabled={saving || deleting}>
        {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
        {creating ? "作成" : "保存"}
      </button>
    </div>
  );
}
