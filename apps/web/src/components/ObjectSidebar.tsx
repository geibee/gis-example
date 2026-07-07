import { Loader2, Plus, RefreshCcw, Search } from "lucide-react";
import type { Project } from "../types";

export function ObjectSidebar({
  title,
  query,
  setQuery,
  loading,
  onRefresh,
  onSearch,
  onCreate,
  filterContent,
  selectedProject,
  projects,
  onProjectChange,
  children
}: {
  title: string;
  query: string;
  setQuery: (value: string) => void;
  loading: boolean;
  onRefresh: () => void;
  onSearch: () => void;
  onCreate: () => void;
  filterContent?: React.ReactNode;
  selectedProject: string;
  projects: Project[];
  onProjectChange: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <aside className="object-sidebar">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Business Object</p>
          <h1>{title}</h1>
        </div>
        <div className="sidebar-actions">
          <button className="icon-button" type="button" onClick={onCreate} title="新規作成">
            <Plus size={18} />
          </button>
          <button className="icon-button" type="button" onClick={onRefresh} title="更新">
            {loading ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
          </button>
        </div>
      </header>
      <label>
        プロジェクト
        <select value={selectedProject} onChange={(event) => onProjectChange(event.target.value)}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <form
        className="sidebar-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <label className="search-field">
          キーワード検索
          <span>
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ID、所在地、地番、名称、関係者名"
            />
          </span>
        </label>
        <button className="command-button sidebar-search-button" type="submit" disabled={loading}>
          {loading ? <Loader2 className="spin" size={15} /> : <Search size={15} />}
          検索
        </button>
      </form>
      {filterContent}
      <div className="object-list">{children}</div>
    </aside>
  );
}
