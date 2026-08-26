import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

describe("MapSupportPane", () => {
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
