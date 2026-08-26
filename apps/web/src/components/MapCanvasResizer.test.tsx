import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MapCanvasResizer, mapCanvasMinHeight } from "./MapCanvasResizer";

describe("MapCanvasResizer", () => {
  it("上下キーとHome/Endで地図の高さを変更できる", () => {
    const onHeightChange = vi.fn();
    render(
      <div>
        <div />
        <MapCanvasResizer open fullscreen={false} height={400} onHeightChange={onHeightChange} />
      </div>
    );
    const separator = screen.getByRole("separator", { name: "地図キャンバスの高さを変更" });

    fireEvent.keyDown(separator, { key: "ArrowUp" });
    expect(onHeightChange).toHaveBeenLastCalledWith(368);

    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(onHeightChange).toHaveBeenLastCalledWith(432);

    fireEvent.keyDown(separator, { key: "Home" });
    expect(onHeightChange).toHaveBeenLastCalledWith(mapCanvasMinHeight);

    fireEvent.keyDown(separator, { key: "End" });
    expect(onHeightChange).toHaveBeenLastCalledWith(
      Math.max(mapCanvasMinHeight, window.innerHeight - 168)
    );
  });

  it("境界をドラッグして地図の高さを変更し、上下の最小高さを守る", () => {
    const onHeightChange = vi.fn();
    const { container } = render(
      <div>
        <div data-testid="map-panel" />
        <MapCanvasResizer open fullscreen={false} height={400} onHeightChange={onHeightChange} />
        <div />
      </div>
    );
    const separator = screen.getByRole("separator", { name: "地図キャンバスの高さを変更" });
    const pane = container.firstElementChild as HTMLDivElement;
    const mapPanel = screen.getByTestId("map-panel");
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({
      bottom: 800,
      height: 800,
      left: 0,
      right: 500,
      top: 0,
      width: 500,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });
    vi.spyOn(mapPanel, "getBoundingClientRect").mockReturnValue({
      bottom: 360,
      height: 300,
      left: 0,
      right: 500,
      top: 60,
      width: 500,
      x: 0,
      y: 60,
      toJSON: () => ({})
    });

    fireEvent.pointerDown(separator, { button: 0, clientY: 400, pointerId: 1 });
    expect(onHeightChange).toHaveBeenLastCalledWith(340);

    fireEvent.pointerMove(separator, { clientY: 100, pointerId: 1 });
    expect(onHeightChange).toHaveBeenLastCalledWith(mapCanvasMinHeight);

    fireEvent.pointerMove(separator, { clientY: 780, pointerId: 1 });
    expect(onHeightChange).toHaveBeenLastCalledWith(572);
  });

  it("地図を閉じているときと全画面表示中は操作対象から外れる", () => {
    const { rerender } = render(
      <MapCanvasResizer
        open={false}
        fullscreen={false}
        height={400}
        onHeightChange={() => undefined}
      />
    );
    const separator = screen.getByRole("separator", {
      name: "地図キャンバスの高さを変更",
      hidden: true
    });
    expect(separator).toHaveClass("hidden");
    expect(separator).toHaveAttribute("tabindex", "-1");

    rerender(
      <MapCanvasResizer open fullscreen height={400} onHeightChange={() => undefined} />
    );
    expect(separator).toHaveClass("hidden");
    expect(separator).toHaveAttribute("tabindex", "-1");
  });
});
