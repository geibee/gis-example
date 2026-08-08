import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Map as MapLibreMap } from "maplibre-gl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackThread, ReviewSession } from "./contracts";
import { FeedbackMapLibreAdapter } from "./FeedbackMapLibreAdapter";
import { FeedbackPluginProvider } from "./plugin-context";
import { useFeedbackState } from "./state";

const maplibreState = vi.hoisted(() => ({
  markers: [] as Array<{ lngLat?: [number, number]; removed: boolean; element?: HTMLElement }>,
  popups: [] as Array<{ options: unknown; content?: Node }>
}));

vi.mock("maplibre-gl", () => {
  class Popup {
    state = { options: undefined as unknown, content: undefined as Node | undefined };
    constructor(options: unknown) {
      this.state.options = options;
      maplibreState.popups.push(this.state);
    }
    setDOMContent(content: Node) { this.state.content = content; return this; }
  }
  class Marker {
    state = { lngLat: undefined as [number, number] | undefined, removed: false, element: undefined as HTMLElement | undefined };
    constructor(options?: { element?: HTMLElement }) {
      this.state.element = options?.element;
      maplibreState.markers.push(this.state);
    }
    setLngLat(value: [number, number]) { this.state.lngLat = value; return this; }
    setPopup() { return this; }
    addTo() { return this; }
    remove() { this.state.removed = true; }
  }
  return { default: { Popup, Marker } };
});

type MapListener = (event: {
  point: { x: number; y: number };
  lngLat: { lng: number; lat: number };
  preventDefault: () => void;
  originalEvent?: {
    clientX: number;
    clientY: number;
    preventDefault: () => void;
  };
}) => void;

function makeMap() {
  const listeners = new Map<string, MapListener>();
  const queryRenderedFeatures = vi.fn(() => [
    { source: "layer-1", sourceLayer: "buildings", properties: { building_id: "B-42" } }
  ]);
  const map = {
    getLayer: () => ({}),
    queryRenderedFeatures,
    on: vi.fn((event: string, listener: MapListener) => listeners.set(event, listener)),
    off: vi.fn((event: string) => listeners.delete(event))
  };
  return { map: map as unknown as MapLibreMap, listeners, queryRenderedFeatures };
}

const session: ReviewSession = {
  id: "session-map",
  projectId: "p1",
  title: "地図レビュー",
  status: "open",
  evidenceRetentionDays: null,
  effectiveEvidenceRetentionDays: null,
  createdAt: "2026-08-08T00:00:00Z",
  updatedAt: "2026-08-08T00:00:00Z",
  perspectives: [],
  scopes: []
};

const thread: FeedbackThread = {
  id: "thread-map",
  projectId: "p1",
  reviewSessionId: session.id,
  perspectiveCode: "MAP",
  perspectiveLabel: "地図操作",
  targetType: "MAP_FEATURE",
  targetMetadata: {
    type: "MAP_FEATURE",
    longitude: 139.7,
    latitude: 35.6,
    source: "layer-1",
    featureId: "B-42"
  },
  status: "OPEN",
  createdAt: "2026-08-08T00:00:00Z",
  updatedAt: "2026-08-08T00:00:00Z",
  messages: [{ id: "m1", threadId: "thread-map", body: "この建物です", createdAt: "2026-08-08T00:00:00Z" }]
};

function Probe() {
  const state = useFeedbackState();
  return <>
    <button type="button" onClick={state.startPicking}>対象を選ぶ</button>
    <output aria-label="モード">{state.mode}</output>
    <output aria-label="対象">{state.picked ? JSON.stringify(state.picked.target) : ""}</output>
    <output aria-label="右クリック対象">{state.contextMenu ? JSON.stringify(state.contextMenu.target) : ""}</output>
    <output aria-label="開いているスレッド">{state.activeThreadId ?? ""}</output>
  </>;
}

beforeEach(() => {
  maplibreState.markers.length = 0;
  maplibreState.popups.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const value = url.includes("/api/review-sessions?") ? [session] : url.endsWith("/threads") ? [thread] : [];
    return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

describe("FeedbackMapLibreAdapter", () => {
  it("地物選択を変換し、地図ピンを経緯度へ描画してunmount時に破棄する", async () => {
    const { map, listeners, queryRenderedFeatures } = makeMap();
    const user = userEvent.setup();
    const view = render(
      <FeedbackPluginProvider
      apiBaseUrl="https://feedback.example.test"
      projectId="p1"
      appVersion="test"
      routes={[{ pageId: "host.map", path: "/", label: "地図" }]}
      getAccessToken={() => "token"}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Probe />
        <FeedbackMapLibreAdapter
          map={map}
          layers={[{ id: "layer-1", featureIdColumn: "building_id" }]}
          styleLayersByLayerId={{ "layer-1": ["layer-1-fill"] }}
        />
      </FeedbackPluginProvider>
    );

    await waitFor(() => expect(maplibreState.markers[0]).toMatchObject({ lngLat: [139.7, 35.6] }));
    await act(async () => maplibreState.markers[0].element?.click());
    await waitFor(() => expect(screen.getByLabelText("開いているスレッド")).toHaveTextContent("thread-map"));
    await waitFor(() => expect(listeners.get("contextmenu")).toBeDefined());
    const preventMapDefault = vi.fn();
    const preventBrowserDefault = vi.fn();
    await act(async () => {
      listeners.get("contextmenu")?.({
        point: { x: 10, y: 20 },
        lngLat: { lng: 139.71, lat: 35.61 },
        preventDefault: preventMapDefault,
        originalEvent: { clientX: 300, clientY: 240, preventDefault: preventBrowserDefault }
      });
    });
    expect(preventMapDefault).toHaveBeenCalled();
    expect(preventBrowserDefault).toHaveBeenCalled();
    expect(screen.getByLabelText("右クリック対象")).toHaveTextContent('"featureId":"B-42"');
    await user.click(screen.getByRole("button", { name: "対象を選ぶ" }));
    await waitFor(() => expect(listeners.get("click")).toBeDefined());
    await act(async () => {
      listeners.get("click")?.({
        point: { x: 10, y: 20 },
        lngLat: { lng: 139.71, lat: 35.61 },
        preventDefault: vi.fn()
      });
    });
    expect(queryRenderedFeatures).toHaveBeenCalledWith([10, 20], { layers: ["layer-1-fill"] });
    expect(screen.getByLabelText("対象")).toHaveTextContent('"featureId":"B-42"');

    view.unmount();
    expect(maplibreState.markers[0].removed).toBe(true);
  });
});
