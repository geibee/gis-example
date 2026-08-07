import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { makeFeedbackThread, makeLayer } from "../testing/fixtures";
import { ReviewProvider, useReview } from "../review";
import { FeedbackMapAdapter } from "./FeedbackMapAdapter";

const toBlob = vi.hoisted(() => vi.fn());
const maplibreState = vi.hoisted(() => ({
  markers: [] as Array<{
    options: unknown;
    lngLat?: [number, number];
    popup?: unknown;
    addedTo?: unknown;
    removed: boolean;
  }>,
  popups: [] as Array<{ options: unknown; content?: Node }>
}));

vi.mock("html-to-image", () => ({ toBlob }));
vi.mock("maplibre-gl", () => {
  class Popup {
    state: (typeof maplibreState.popups)[number] = { options: undefined, content: undefined };

    constructor(options: unknown) {
      this.state.options = options;
      maplibreState.popups.push(this.state);
    }

    setDOMContent(content: Node) {
      this.state.content = content;
      return this;
    }
  }

  class Marker {
    state: (typeof maplibreState.markers)[number] = { options: undefined, removed: false };

    constructor(options: unknown) {
      this.state.options = options;
      maplibreState.markers.push(this.state);
    }

    setLngLat(lngLat: [number, number]) {
      this.state.lngLat = lngLat;
      return this;
    }

    setPopup(popup: unknown) {
      this.state.popup = popup;
      return this;
    }

    addTo(map: unknown) {
      this.state.addedTo = map;
      return this;
    }

    remove() {
      this.state.removed = true;
    }
  }

  return { default: { Marker, Popup } };
});

type MapListener = (event: {
  point: { x: number; y: number };
  lngLat: { lng: number; lat: number };
  preventDefault: () => void;
}) => void;

function makeMap(features: unknown[] = []) {
  const listeners = new Map<string, MapListener>();
  const map = {
    getLayer: () => ({}),
    queryRenderedFeatures: vi.fn(() => features),
    on: vi.fn((event: string, listener: MapListener) => listeners.set(event, listener)),
    off: vi.fn((event: string) => listeners.delete(event))
  };
  return { map: map as unknown as MapLibreMap, listeners, queryRenderedFeatures: map.queryRenderedFeatures };
}

function ReviewProbe() {
  const { mode, picked, startPicking } = useReview();
  return (
    <>
      <button type="button" onClick={startPicking}>
        対象を選ぶ
      </button>
      <output aria-label="レビューモード">{mode}</output>
      <output aria-label="選択対象">{picked ? JSON.stringify(picked.target) : ""}</output>
    </>
  );
}

describe("FeedbackMapAdapter", () => {
  beforeEach(() => {
    maplibreState.markers.length = 0;
    maplibreState.popups.length = 0;
    toBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  });

  it("地図コメントを経緯度 Marker と closeOnClick=false の概要へ復元する", () => {
    const { map } = makeMap();
    const thread = makeFeedbackThread({
      targetType: "MAP_FEATURE",
      targetMetadata: {
        type: "MAP_FEATURE",
        longitude: 139.7001,
        latitude: 35.6902,
        source: "parcel",
        featureId: "10"
      }
    });
    const view = render(
      <ReviewProvider>
        <FeedbackMapAdapter map={map} layers={[]} styleLayersByLayerId={{}} threads={[thread]} />
      </ReviewProvider>
    );

    expect(maplibreState.markers[0]).toMatchObject({
      lngLat: [139.7001, 35.6902],
      addedTo: map,
      removed: false
    });
    expect(maplibreState.popups[0].options).toMatchObject({ closeOnClick: false });
    expect(maplibreState.popups[0].content).toHaveTextContent("土地タブの名称を確認してください");

    view.unmount();
    expect(maplibreState.markers[0].removed).toBe(true);
  });

  it("レビューモードの地図クリックをレイヤ固有 ID の MAP_FEATURE として渡す", async () => {
    const { map, listeners, queryRenderedFeatures } = makeMap([
      { source: "layer-1", sourceLayer: "source-1", properties: { building_id: "B-42" } }
    ]);
    const user = userEvent.setup();
    render(
      <ReviewProvider>
        <ReviewProbe />
        <FeedbackMapAdapter
          map={map}
          layers={[makeLayer({ id: "layer-1", featureIdColumn: "building_id" })]}
          styleLayersByLayerId={{ "layer-1": ["layer-1-fill"] }}
          threads={[]}
        />
      </ReviewProvider>
    );

    await user.click(screen.getByRole("button", { name: "対象を選ぶ" }));
    const preventDefault = vi.fn();
    await act(async () => {
      listeners.get("click")?.({
        point: { x: 120, y: 240 },
        lngLat: { lng: 139.7, lat: 35.6 },
        preventDefault
      });
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(queryRenderedFeatures).toHaveBeenCalledWith([120, 240], { layers: ["layer-1-fill"] });
    expect(screen.getByLabelText("レビューモード")).toHaveTextContent("composing");
    expect(screen.getByLabelText("選択対象")).toHaveTextContent('"featureId":"B-42"');
  });
});
