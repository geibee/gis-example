import { render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeProject, makeZone } from "../testing/fixtures";
import { ZoneWorkspace } from "./ZoneWorkspace";

vi.mock("./ZonePartySummary", () => ({
  ZonePartySummary: () => (
    <div className="object-related zone-party-summary">
      <h3>関係者</h3>
    </div>
  )
}));

function zoneWorkspaceProps() {
  const selected = makeZone();
  return {
    query: "",
    setQuery: vi.fn(),
    filters: {},
    setFilters: vi.fn(),
    filtersOpen: false,
    setFiltersOpen: vi.fn(),
    items: [selected],
    selectedId: selected.id,
    selected,
    draft: {
      id: selected.id,
      name: selected.name,
      zoneType: selected.zoneType ?? "",
      status: selected.status,
      memo: selected.memo ?? "",
      zoneLayerId: "",
      zoneFeatureId: ""
    },
    setDraft: vi.fn(),
    creating: false,
    loading: false,
    saving: false,
    deleting: false,
    onRefresh: vi.fn(),
    onSearch: vi.fn(),
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onCancelCreate: vi.fn(),
    onBackToList: vi.fn(),
    onSave: vi.fn(),
    onDelete: vi.fn(),
    onOpenLand: vi.fn(),
    onOpenBuilding: vi.fn(),
    onOpenParty: vi.fn(),
    onShowOnMap: vi.fn(),
    onOpenSourceFeature: vi.fn(),
    onUseSelectedFeature: vi.fn(),
    layers: [],
    selectedFeature: null,
    selectedFeatureLayer: null,
    zoneSourceLayerId: "",
    setZoneSourceLayerId: vi.fn(),
    zoneSourceLayers: [],
    zoneUploadFile: null,
    setZoneUploadFile: vi.fn(),
    zoneUploadFormat: "geojson",
    setZoneUploadFormat: vi.fn(),
    zoneUploadSrid: "4326",
    setZoneUploadSrid: vi.fn(),
    creatingZoneLayer: false,
    onSubmitZoneFromLayer: vi.fn(),
    onSubmitZoneUpload: vi.fn(),
    selectedProject: "p1",
    projects: [makeProject()],
    onProjectChange: vi.fn(),
    gisTools: null
  } satisfies Parameters<typeof ZoneWorkspace>[0];
}

describe("ZoneWorkspace", () => {
  it("区域詳細の関連見出しを土地、建物、関係者の DOM 順で表示する", () => {
    const { container } = render(<ZoneWorkspace {...zoneWorkspaceProps()} />);
    const detail = container.querySelector<HTMLElement>(".object-detail");

    expect(detail).not.toBeNull();
    const relatedHeadings = within(detail!)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent?.trim())
      .filter((heading) => ["含まれる土地", "含まれる建物", "関係者"].includes(heading ?? ""));

    expect(relatedHeadings).toEqual(["含まれる土地", "含まれる建物", "関係者"]);
  });
});
