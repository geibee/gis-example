import { ExternalLink, Loader2 } from "lucide-react";
import type { BusinessLinks } from "../types";

export function BusinessLinksPanel({ links, loading }: { links: BusinessLinks; loading: boolean }) {
  const hasLinks = links.lands.length > 0 || links.buildings.length > 0;
  return (
    <div className="business-links-panel">
      <div className="mini-heading">
        <span>業務リンク</span>
        {loading ? <Loader2 className="spin muted-icon" size={14} /> : null}
      </div>
      {hasLinks ? (
        <div className="business-link-groups">
          {links.lands.length ? (
            <div>
              <strong>関連する土地</strong>
              {links.lands.map((link) => (
                <a key={link.id} href={`/lands/${encodeURIComponent(link.id)}`} target="_blank" rel="noreferrer">
                  {link.id}
                  <span>{link.label}</span>
                  <ExternalLink size={13} />
                </a>
              ))}
            </div>
          ) : null}
          {links.buildings.length ? (
            <div>
              <strong>関連する建物</strong>
              {links.buildings.map((link) => (
                <a key={link.id} href={`/buildings/${encodeURIComponent(link.id)}`} target="_blank" rel="noreferrer">
                  {link.id}
                  <span>{link.label}</span>
                  <ExternalLink size={13} />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="empty-state compact">{loading ? "取得中" : "紐づく業務データはありません"}</p>
      )}
    </div>
  );
}
