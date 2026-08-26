import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MapPaneResizer } from "./MapPaneResizer";

describe("MapPaneResizer", () => {
  it("左右キーとHome/Endで地図幅を変更できる", () => {
    const onWidthChange = vi.fn();
    render(
      <div>
        <MapPaneResizer open fullscreen={false} width={500} onWidthChange={onWidthChange} />
      </div>
    );
    const separator = screen.getByRole("separator", { name: "地図ペインの幅を変更" });

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onWidthChange).toHaveBeenLastCalledWith(532);

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onWidthChange).toHaveBeenLastCalledWith(468);

    fireEvent.keyDown(separator, { key: "Home" });
    expect(onWidthChange).toHaveBeenLastCalledWith(320);

    fireEvent.keyDown(separator, { key: "End" });
    expect(onWidthChange).toHaveBeenLastCalledWith(Math.max(320, window.innerWidth - 328));
  });

  it("境界をドラッグして地図幅を変更し、最小幅を下回らない", () => {
    const onWidthChange = vi.fn();
    render(
      <div>
        <MapPaneResizer open fullscreen={false} width={500} onWidthChange={onWidthChange} />
      </div>
    );
    const separator = screen.getByRole("separator", { name: "地図ペインの幅を変更" });
    vi.spyOn(separator.parentElement as HTMLDivElement, "getBoundingClientRect").mockReturnValue({
      bottom: 800,
      height: 800,
      left: 0,
      right: 1000,
      top: 0,
      width: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });

    fireEvent.pointerDown(separator, { button: 0, clientX: 580, pointerId: 1 });
    expect(onWidthChange).toHaveBeenLastCalledWith(420);

    fireEvent.pointerMove(separator, { clientX: 900, pointerId: 1 });
    expect(onWidthChange).toHaveBeenLastCalledWith(320);
  });

  it("地図を閉じているときと全画面表示中は操作対象から外れる", () => {
    const { rerender } = render(
      <MapPaneResizer open={false} fullscreen={false} width={500} onWidthChange={() => undefined} />
    );
    const separator = screen.getByRole("separator", { name: "地図ペインの幅を変更", hidden: true });
    expect(separator).toHaveClass("hidden");
    expect(separator).toHaveAttribute("tabindex", "-1");

    rerender(<MapPaneResizer open fullscreen width={500} onWidthChange={() => undefined} />);
    expect(separator).toHaveClass("hidden");
    expect(separator).toHaveAttribute("tabindex", "-1");
  });
});
