import { createRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeLayer } from "../testing/fixtures";
import { MapSupportPane } from "./MapSupportPane";

function mapSupportPaneProps(overrides: Partial<Parameters<typeof MapSupportPane>[0]> = {}) {
  return {
    open: true,
    onToggle: vi.fn(),
    fullscreen: false,
    onToggleFullscreen: vi.fn(),
    mapCanvasHeight: 360,
    onMapCanvasHeightChange: vi.fn(),
    mapContainerRef: createRef<HTMLDivElement>(),
    baseMapVisible: true,
    setBaseMapVisible: vi.fn(),
    layerListItems: [],
    visibleLayerIds: new Set<string>(),
    loadingLayers: false,
    deletingLayerIds: new Set<string>(),
    deletingResultSetIds: new Set<string>(),
    draggingLayerId: null,
    onRefreshLayers: vi.fn(),
    onToggleLayer: vi.fn(),
    onToggleLayerGroup: vi.fn(),
    onRequestLayerDelete: vi.fn(),
    onRequestResultSetDelete: vi.fn(),
    onDragLayerStart: vi.fn(),
    onDragLayerOver: vi.fn(),
    onDropLayer: vi.fn(),
    onDragLayerEnd: vi.fn(),
    selectedFeature: null,
    selectedFeatureLayer: null,
    businessLinks: { lands: [], buildings: [] },
    loadingBusinessLinks: false,
    featureEditOpen: false,
    setFeatureEditOpen: vi.fn(),
    featurePropertyDraft: {},
    setFeaturePropertyDraft: vi.fn(),
    featureGeometryDraft: "",
    setFeatureGeometryDraft: vi.fn(),
    savingFeature: false,
    onSaveFeature: vi.fn(),
    ...overrides
  } satisfies Parameters<typeof MapSupportPane>[0];
}

function controlledContent(button: HTMLElement) {
  const id = button.getAttribute("aria-controls");
  expect(id).toBeTruthy();
  const content = document.getElementById(id!);
  expect(content).not.toBeNull();
  return content!;
}

function EditableFeaturePane() {
  const [featureEditOpen, setFeatureEditOpen] = useState(false);
  const [featurePropertyDraft, setFeaturePropertyDraft] = useState<Record<string, string>>({
    name: "入力前"
  });
  const [featureGeometryDraft, setFeatureGeometryDraft] = useState(
    '{"type":"Point","coordinates":[139.7,35.6]}'
  );
  const layer = makeLayer({
    name: "編集対象レイヤ",
    attributes: [{ name: "name", dataType: "text", ordinalPosition: 1 }]
  });

  return (
    <MapSupportPane
      {...mapSupportPaneProps({
        selectedFeature: {
          layerId: layer.id,
          featureId: "feature-1",
          properties: { name: "入力前" }
        },
        selectedFeatureLayer: layer,
        featureEditOpen,
        setFeatureEditOpen,
        featurePropertyDraft,
        setFeaturePropertyDraft,
        featureGeometryDraft,
        setFeatureGeometryDraft
      })}
    />
  );
}

describe("MapSupportPane", () => {
  it("レイヤは閉じ、選択地物は開いた初期状態で制御対象を DOM に保持する", () => {
    render(<MapSupportPane {...mapSupportPaneProps()} />);

    const layersToggle = screen.getByRole("button", { name: "レイヤを展開" });
    const selectedFeatureToggle = screen.getByRole("button", { name: "選択地物を折りたたむ" });
    const layersContent = controlledContent(layersToggle);
    const selectedFeatureContent = controlledContent(selectedFeatureToggle);

    expect(layersToggle).toHaveAttribute("aria-expanded", "false");
    expect(selectedFeatureToggle).toHaveAttribute("aria-expanded", "true");
    expect(layersToggle.getAttribute("aria-controls")).not.toBe(
      selectedFeatureToggle.getAttribute("aria-controls")
    );
    expect(layersContent).toBeInTheDocument();
    expect(layersContent).toHaveAttribute("hidden");
    expect(selectedFeatureContent).toBeInTheDocument();
    expect(selectedFeatureContent).not.toHaveAttribute("hidden");
  });

  it("両セクションをキーボードで独立して開閉できる", async () => {
    const user = userEvent.setup();
    render(<MapSupportPane {...mapSupportPaneProps()} />);

    const layersToggle = screen.getByRole("button", { name: "レイヤを展開" });
    layersToggle.focus();
    await user.keyboard("{Enter}");

    expect(layersToggle).toHaveAttribute("aria-expanded", "true");
    expect(controlledContent(layersToggle)).not.toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "選択地物を折りたたむ" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    const selectedFeatureToggle = screen.getByRole("button", { name: "選択地物を折りたたむ" });
    selectedFeatureToggle.focus();
    await user.keyboard(" ");

    expect(selectedFeatureToggle).toHaveAttribute("aria-expanded", "false");
    expect(controlledContent(selectedFeatureToggle)).toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "レイヤを折りたたむ" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("レイヤ更新は更新処理だけを呼び、閉じた状態を変えない", async () => {
    const user = userEvent.setup();
    const onRefreshLayers = vi.fn();
    render(<MapSupportPane {...mapSupportPaneProps({ onRefreshLayers })} />);

    await user.click(screen.getByRole("button", { name: "レイヤ更新" }));

    expect(onRefreshLayers).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "レイヤを展開" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("編集中に折りたたんでも編集モード・属性値・GeoJSONを保持する", async () => {
    const user = userEvent.setup();
    render(<EditableFeaturePane />);

    const selectedFeatureToggle = screen.getByRole("button", { name: "選択地物を折りたたむ" });
    await user.click(screen.getByRole("button", { name: "地物編集" }));
    expect(selectedFeatureToggle).toHaveAttribute("aria-expanded", "true");

    const propertyInput = screen.getByRole("textbox", { name: "name" });
    const geometryInput = screen.getByRole("textbox", { name: "GeoJSON" });
    await user.clear(propertyInput);
    await user.type(propertyInput, "入力途中の属性");
    await user.clear(geometryInput);
    fireEvent.change(geometryInput, {
      target: { value: '{"type":"Point","coordinates":[135,34]}' }
    });

    await user.click(selectedFeatureToggle);
    expect(controlledContent(selectedFeatureToggle)).toHaveAttribute("hidden");
    await user.click(screen.getByRole("button", { name: "選択地物を展開" }));

    expect(screen.getByRole("button", { name: "編集を閉じる" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "name" })).toHaveValue("入力途中の属性");
    expect(screen.getByRole("textbox", { name: "GeoJSON" })).toHaveValue(
      '{"type":"Point","coordinates":[135,34]}'
    );
  });

  it("指定した地図高さと縦幅変更用の境界を表示する", () => {
    const { container } = render(<MapSupportPane {...mapSupportPaneProps()} />);

    expect(container.querySelector(".map-support-pane")).toHaveStyle({
      "--map-canvas-height": "360px"
    });
    expect(screen.getByRole("separator", { name: "地図キャンバスの高さを変更" })).toHaveAttribute(
      "aria-orientation",
      "horizontal"
    );
  });

  it("全画面表示ボタンから表示を切り替えられる", async () => {
    const user = userEvent.setup();
    const onToggleFullscreen = vi.fn();
    render(<MapSupportPane {...mapSupportPaneProps({ onToggleFullscreen })} />);

    const button = screen.getByRole("button", { name: "地図を全画面表示" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    await user.click(button);

    expect(onToggleFullscreen).toHaveBeenCalledOnce();
  });

  it("全画面表示中はEscで解除できる", () => {
    const onToggleFullscreen = vi.fn();
    const { container } = render(
      <MapSupportPane {...mapSupportPaneProps({ fullscreen: true, onToggleFullscreen })} />
    );

    expect(container.querySelector(".map-support-pane")).toHaveClass("fullscreen");
    expect(screen.getByRole("dialog", { name: "地図" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "地図の全画面表示を終了" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("separator", {
      name: "地図キャンバスの高さを変更",
      hidden: true
    })).toHaveClass("hidden");
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onToggleFullscreen).toHaveBeenCalledOnce();
  });
});
