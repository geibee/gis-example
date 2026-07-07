import { useEffect, useState } from "react";
import { Loader2, Users } from "lucide-react";
import { getZonePartySummary } from "../api";
import type { ZonePartySummary as ZonePartySummaryData } from "../types";
import { errorMessage } from "../utils";

export function ZonePartySummary({
  zoneId,
  onOpenParty
}: {
  zoneId: string;
  onOpenParty: (id: string) => void;
}) {
  const [summary, setSummary] = useState<ZonePartySummaryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setActiveTag(null);
    getZonePartySummary(zoneId)
      .then((data) => {
        if (active) setSummary(data);
      })
      .catch((err) => {
        if (active) {
          setSummary(null);
          setError(errorMessage(err));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [zoneId]);

  if (loading) {
    return (
      <div className="object-related zone-party-summary">
        <h3>
          <Users size={15} /> 関係者
        </h3>
        <p className="empty-state compact">
          <Loader2 size={14} className="spin" /> 集計中…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="object-related zone-party-summary">
        <h3>
          <Users size={15} /> 関係者
        </h3>
        <p className="empty-state compact">集計を取得できませんでした（{error}）</p>
      </div>
    );
  }

  if (!summary || summary.partyCount === 0) {
    return (
      <div className="object-related zone-party-summary">
        <h3>
          <Users size={15} /> 関係者
        </h3>
        <p className="empty-state compact">区域内に関係者は登録されていません</p>
      </div>
    );
  }

  const topCoverage = summary.parties.length ? Math.round(summary.parties[0].coverageRatio * 100) : 0;
  const visibleParties = activeTag
    ? summary.parties.filter((party) => party.tags.includes(activeTag))
    : summary.parties;

  return (
    <div className="object-related zone-party-summary">
      <h3>
        <Users size={15} /> 関係者
      </h3>

      <div className="zps-chips">
        <span className="zps-chip strong">関係者 {summary.partyCount}名</span>
        {summary.typeBreakdown.map((entry) => (
          <span key={`type-${entry.key}`} className="zps-chip">
            {entry.key} {entry.count}
          </span>
        ))}
        {summary.parties.length ? <span className="zps-chip">最上位カバー率 {topCoverage}%</span> : null}
      </div>

      {summary.tagBreakdown.length ? (
        <div className="zps-chips zps-tags">
          {summary.tagBreakdown.map((entry) => {
            const selected = activeTag === entry.key;
            return (
              <button
                key={`tag-${entry.key}`}
                type="button"
                className={`zps-tag-chip${selected ? " selected" : ""}`}
                onClick={() => setActiveTag(selected ? null : entry.key)}
                aria-pressed={selected}
              >
                {entry.key} {entry.count}
              </button>
            );
          })}
        </div>
      ) : null}

      <ul className="zps-list">
        {visibleParties.map((party) => {
          const coverage = Math.round(party.coverageRatio * 100);
          return (
            <li key={party.id}>
              <button type="button" className="zps-party" onClick={() => onOpenParty(party.id)}>
                <span className="zps-party-head">
                  <strong>{party.name}</strong>
                  <span className="zps-type-badge">{party.partyType}</span>
                  {party.tags.map((tag) => (
                    <span key={tag} className="zps-tag-badge">
                      {tag}
                    </span>
                  ))}
                </span>
                <span className="zps-party-meta">
                  区域内 {party.zoneInvolvement}件 / 全体 {party.projectInvolvement}件
                  {party.relationTypes.length ? ` · ${party.relationTypes.join("、")}` : ""}
                </span>
                <span className="zps-bar" title={`カバー率 ${coverage}%`}>
                  <span className="zps-bar-fill" style={{ width: `${coverage}%` }} />
                </span>
              </button>
            </li>
          );
        })}
        {!visibleParties.length ? (
          <li>
            <p className="empty-state compact">該当する関係者はいません</p>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
