import type { PartyRelationship } from "../types";

export function RelationshipList({ relationships }: { relationships: PartyRelationship[] }) {
  return (
    <div className="relationship-list">
      <h3>関係</h3>
      {relationships.map((relationship) => {
        const targetHref =
          relationship.targetType === "land"
            ? `/lands/${encodeURIComponent(relationship.targetId)}`
            : `/buildings/${encodeURIComponent(relationship.targetId)}`;
        return (
          <div className="relationship-row" key={relationship.id}>
            <span>{relationship.relationType}</span>
            <a href={`/parties/${encodeURIComponent(relationship.partyId)}`} target="_blank" rel="noreferrer">
              {relationship.partyName ?? relationship.partyId}
            </a>
            <a href={targetHref} target="_blank" rel="noreferrer">
              {relationship.targetId}
              {relationship.targetLabel ? ` · ${relationship.targetLabel}` : ""}
            </a>
            {relationship.note ? <em>{relationship.note}</em> : null}
          </div>
        );
      })}
      {!relationships.length ? <p className="empty-state compact">関係はありません</p> : null}
    </div>
  );
}
