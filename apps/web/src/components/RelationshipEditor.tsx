import { useEffect, useState } from "react";
import { Pencil, Save, Trash2, X } from "lucide-react";
import type { Building, Land, Party, PartyRelationship } from "../types";
import type { RelationshipDraft } from "../appTypes";
import { relationTypeOptions } from "../constants";
import { mergeChoiceOptions } from "../utils";
import { ChoiceSelect } from "./ChoiceSelect";

export function RelationshipEditor({
  relationships,
  parties,
  lands,
  buildings,
  fixedTarget,
  fixedPartyId,
  onOpenParty,
  onOpenLand,
  onOpenBuilding,
  onSave,
  onDelete,
  relationOptions = relationTypeOptions
}: {
  relationships: PartyRelationship[];
  parties: Party[];
  lands: Land[];
  buildings: Building[];
  fixedTarget?: { targetType: "land" | "building"; targetId: string };
  fixedPartyId?: string;
  onOpenParty: (id: string) => void;
  onOpenLand: (id: string) => void;
  onOpenBuilding: (id: string) => void;
  onSave: (relationshipId: string | null, draft: RelationshipDraft) => void;
  onDelete: (relationshipId: string) => void;
  relationOptions?: string[];
}) {
  const fixedTargetType = fixedTarget?.targetType;
  const fixedTargetId = fixedTarget?.targetId;
  const defaultTargetType = fixedTargetType ?? "land";
  const defaultTargetId = fixedTargetId ?? lands[0]?.id ?? buildings[0]?.id ?? "";
  const defaultPartyId = fixedPartyId ?? parties[0]?.id ?? "";
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RelationshipDraft>({
    partyId: defaultPartyId,
    targetType: defaultTargetType,
    targetId: defaultTargetId,
    relationType: "",
    note: ""
  });

  useEffect(() => {
    if (editingId) return;
    setDraft((current) => ({
      ...current,
      partyId: fixedPartyId ?? (current.partyId || parties[0]?.id || ""),
      targetType: fixedTargetType ?? current.targetType,
      targetId: fixedTargetId ?? (current.targetId || lands[0]?.id || buildings[0]?.id || "")
    }));
  }, [buildings, editingId, fixedPartyId, fixedTargetId, fixedTargetType, lands, parties]);

  const targetOptions = draft.targetType === "land" ? lands : buildings;
  const startEdit = (relationship: PartyRelationship) => {
    setEditingId(relationship.id);
    setDraft({
      partyId: relationship.partyId,
      targetType: relationship.targetType,
      targetId: relationship.targetId,
      relationType: relationship.relationType,
      note: relationship.note ?? ""
    });
  };
  const resetDraft = () => {
    setEditingId(null);
    setDraft({
      partyId: defaultPartyId,
      targetType: defaultTargetType,
      targetId: defaultTargetId,
      relationType: "",
      note: ""
    });
  };
  const submit = () => {
    onSave(editingId, draft);
    resetDraft();
  };

  return (
    <div className="relationship-list">
      <div className="relationship-heading">
        <h3>関係</h3>
        {editingId ? (
          <button className="subtle-button" type="button" onClick={resetDraft}>
            <X size={14} />
            編集解除
          </button>
        ) : null}
      </div>
      <div className="relationship-edit-form">
        {!fixedPartyId ? (
          <label>
            関係者
            <select value={draft.partyId} onChange={(event) => setDraft((current) => ({ ...current, partyId: event.target.value }))}>
              <option value="">選択</option>
              {parties.map((party) => (
                <option key={party.id} value={party.id}>
                  {party.id} {party.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {!fixedTarget ? (
          <>
            <label>
              対象
              <select
                value={draft.targetType}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    targetType: event.target.value as "land" | "building",
                    targetId: event.target.value === "land" ? lands[0]?.id ?? "" : buildings[0]?.id ?? ""
                  }))
                }
              >
                <option value="land">土地</option>
                <option value="building">建物</option>
              </select>
            </label>
            <label>
              対象ID
              <select value={draft.targetId} onChange={(event) => setDraft((current) => ({ ...current, targetId: event.target.value }))}>
                <option value="">選択</option>
                {targetOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id} {"lotNumber" in item ? item.lotNumber : item.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        <label>
          関係種別
          <ChoiceSelect
            value={draft.relationType}
            onChange={(value) => setDraft((current) => ({ ...current, relationType: value }))}
            options={mergeChoiceOptions(relationOptions, relationships.map((relationship) => relationship.relationType))}
            emptyLabel="選択"
          />
        </label>
        <label>
          備考
          <input value={draft.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} />
        </label>
        <button className="command-button" type="button" onClick={submit}>
          <Save size={14} />
          {editingId ? "更新" : "追加"}
        </button>
      </div>
      {relationships.map((relationship) => {
        return (
          <div className="relationship-row editable" key={relationship.id}>
            <span>{relationship.relationType}</span>
            <button type="button" onClick={() => onOpenParty(relationship.partyId)}>
              {relationship.partyName ?? relationship.partyId}
            </button>
            <button
              type="button"
              onClick={() =>
                relationship.targetType === "land" ? onOpenLand(relationship.targetId) : onOpenBuilding(relationship.targetId)
              }
            >
              {relationship.targetId}
              {relationship.targetLabel ? ` · ${relationship.targetLabel}` : ""}
            </button>
            {relationship.note ? <em>{relationship.note}</em> : null}
            <div className="relationship-actions">
              <button className="icon-button" type="button" onClick={() => startEdit(relationship)} title="編集">
                <Pencil size={14} />
              </button>
              <button className="icon-button" type="button" onClick={() => onDelete(relationship.id)} title="削除">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        );
      })}
      {!relationships.length ? <p className="empty-state compact">関係はありません</p> : null}
    </div>
  );
}
