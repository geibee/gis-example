import { ArrowLeft, ExternalLink } from "lucide-react";

export function ObjectDetailHeader({
  id,
  title,
  subtitle,
  status,
  href,
  onBack
}: {
  id: string;
  title: string;
  subtitle?: string | null;
  status?: string | null;
  href?: string;
  onBack?: () => void;
}) {
  return (
    <header className="object-detail-header">
      <div className="object-title-group">
        {onBack ? (
          <button className="subtle-button object-back-button" type="button" onClick={onBack}>
            <ArrowLeft size={15} />
            一覧へ戻る
          </button>
        ) : null}
        <div>
          <p className="eyebrow">{id}</p>
          <h1>{title}</h1>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
      </div>
      <div className="object-header-actions">
        {status ? <strong>{status}</strong> : null}
        {href ? (
          <a className="icon-button" href={href} target="_blank" rel="noreferrer" title="別タブで開く">
            <ExternalLink size={16} />
          </a>
        ) : null}
      </div>
    </header>
  );
}
