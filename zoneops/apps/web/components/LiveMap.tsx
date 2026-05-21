"use client";
// Client-only map component.
//
// Responsibilities:
//   1. Initial paint: GET /v1/assets/latest + /v1/geofences (GeoJSON in both).
//   2. Live updates: subscribe to /v1/stream/live (SSE). On location_update,
//      patch the asset feature in place. On fence_event, flash the fence.
//   3. Geofence draw: a minimal "click to add vertex, double-click to finish"
//      polygon tool, no library. Good enough for a first pass.
//
// Why no react-map-gl: it imposes its own reconciler and the marker patch
// pattern (mutate features in a GeoJSON source) maps poorly to React state
// at update rates of several Hz. Vanilla mapbox-gl is simpler here.
import { useEffect, useRef, useState } from "react";
import mapboxgl, { type Map as MbMap } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
const BEARER = process.env.NEXT_PUBLIC_DEV_BEARER ?? "";
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

const ASSETS_SOURCE = "assets-src";
const ASSETS_LAYER = "assets-layer";
const FENCES_SOURCE = "fences-src";
const FENCES_FILL = "fences-fill";
const FENCES_OUTLINE = "fences-outline";

type FeatureCollection = { type: "FeatureCollection"; features: GeoJSON.Feature[] };

async function authedFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${BEARER}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

export default function LiveMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MbMap | null>(null);
  const assetIndexRef = useRef<Map<string, GeoJSON.Feature>>(new Map());
  const [drawing, setDrawing] = useState(false);
  const drawPointsRef = useRef<Array<[number, number]>>([]);
  const [status, setStatus] = useState<string>("loading…");

  useEffect(() => {
    if (!containerRef.current || !MAPBOX_TOKEN) {
      setStatus(MAPBOX_TOKEN ? "no container" : "set NEXT_PUBLIC_MAPBOX_TOKEN");
      return;
    }
    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-74.006, 40.7128],
      zoom: 10,
    });
    mapRef.current = map;

    map.on("load", async () => {
      // ---- Asset source/layer (point markers) ----
      map.addSource(ASSETS_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: ASSETS_LAYER,
        type: "circle",
        source: ASSETS_SOURCE,
        paint: {
          "circle-radius": 6,
          "circle-color": [
            "match",
            ["get", "kind"],
            "technician", "#1f6feb",
            "vehicle", "#2e7d32",
            "equipment", "#ed6c02",
            /* default */ "#555",
          ],
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2,
        },
      });

      // ---- Geofence source/layers ----
      map.addSource(FENCES_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: FENCES_FILL,
        type: "fill",
        source: FENCES_SOURCE,
        paint: { "fill-color": "#1f6feb", "fill-opacity": 0.08 },
      });
      map.addLayer({
        id: FENCES_OUTLINE,
        type: "line",
        source: FENCES_SOURCE,
        paint: { "line-color": "#1f6feb", "line-width": 2 },
      });

      // ---- Initial paint ----
      try {
        const [assetsFc, fencesFc] = await Promise.all([
          authedFetch("/v1/assets/latest") as Promise<FeatureCollection>,
          authedFetch("/v1/geofences") as Promise<FeatureCollection>,
        ]);
        for (const f of assetsFc.features) {
          const id = (f.properties as { asset_id: string }).asset_id;
          assetIndexRef.current.set(id, f);
        }
        (map.getSource(ASSETS_SOURCE) as mapboxgl.GeoJSONSource).setData(assetsFc);
        (map.getSource(FENCES_SOURCE) as mapboxgl.GeoJSONSource).setData(fencesFc);
        setStatus(`${assetsFc.features.length} assets, ${fencesFc.features.length} fences`);
      } catch (err) {
        console.error(err);
        setStatus(`initial load failed: ${(err as Error).message}`);
        return;
      }

      // ---- SSE live updates ----
      // Browsers' built-in EventSource doesn't allow headers. We use fetch +
      // stream parsing so we can pass the Bearer token. (Production would use
      // a same-origin proxy and an EventSource for resilience.)
      const ctrl = new AbortController();
      void (async () => {
        try {
          const res = await fetch(`${API_BASE}/v1/stream/live`, {
            headers: { Authorization: `Bearer ${BEARER}`, Accept: "text/event-stream" },
            signal: ctrl.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const events = buf.split("\n\n");
            buf = events.pop() ?? "";
            for (const block of events) {
              const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;
              const json = JSON.parse(dataLine.slice(6));
              handleLiveEvent(json, map, assetIndexRef.current);
            }
          }
        } catch (err) {
          if ((err as Error).name !== "AbortError") console.warn("[sse]", err);
        }
      })();

      return () => ctrl.abort();
    });

    // ---- Drawing handlers ----
    map.on("click", (e) => {
      if (!drawing) return;
      drawPointsRef.current.push([e.lngLat.lng, e.lngLat.lat]);
      // Show in-progress polygon as a transient feature in the same source.
      drainDrawingPreview(map, drawPointsRef.current);
    });
    map.on("dblclick", async (e) => {
      if (!drawing) return;
      e.preventDefault();
      const ring = [...drawPointsRef.current];
      if (ring.length < 3) {
        setStatus("polygon needs at least 3 points");
        return;
      }
      ring.push(ring[0]!); // close ring
      const name = prompt("Geofence name?") ?? `fence ${new Date().toISOString()}`;
      try {
        await authedFetch("/v1/geofences", {
          method: "POST",
          body: JSON.stringify({
            name,
            category: "custom",
            geometry: { type: "Polygon", coordinates: [ring] },
          }),
        });
        // Refetch fences. Cheap enough for MVP.
        const fc = (await authedFetch("/v1/geofences")) as FeatureCollection;
        (map.getSource(FENCES_SOURCE) as mapboxgl.GeoJSONSource).setData(fc);
        setStatus(`created fence "${name}"`);
      } catch (err) {
        setStatus(`create failed: ${(err as Error).message}`);
      } finally {
        drawPointsRef.current = [];
        setDrawing(false);
      }
    });

    return () => map.remove();
  }, [drawing]);

  return (
    <>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
      <div style={{
        position: "absolute", top: 12, left: 12, background: "white", padding: "8px 12px",
        borderRadius: 6, boxShadow: "0 1px 4px rgba(0,0,0,0.15)", fontSize: 13, zIndex: 1,
      }}>
        <div><strong>ZoneOps</strong></div>
        <div style={{ color: "#555" }}>{status}</div>
        <button
          onClick={() => setDrawing((d) => !d)}
          style={{ marginTop: 6, fontSize: 12 }}
        >
          {drawing ? "Cancel draw" : "Draw geofence"}
        </button>
        {drawing && <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>Click to add points, double-click to finish.</div>}
      </div>
    </>
  );
}

function handleLiveEvent(
  evt: { event: string; [k: string]: unknown },
  map: MbMap,
  index: Map<string, GeoJSON.Feature>,
) {
  if (evt.event === "location_update") {
    const id = String(evt.asset_id);
    const existing = index.get(id);
    if (!existing) return; // ignore unknown assets; first paint hasn't seen them yet
    existing.geometry = {
      type: "Point",
      coordinates: [Number(evt.lon), Number(evt.lat)],
    };
    (existing.properties as { observed_at?: string }).observed_at = String(evt.observed_at);
    const features = [...index.values()];
    (map.getSource(ASSETS_SOURCE) as mapboxgl.GeoJSONSource).setData({
      type: "FeatureCollection", features,
    });
  } else if (evt.event === "fence_event") {
    // Cheap visual: flash a console line for now. UI toast is a one-day task.
    console.log("[fence_event]", evt);
  }
}

function drainDrawingPreview(map: MbMap, ring: Array<[number, number]>) {
  // Render the in-progress polygon as a transient line.
  // We keep this off the persistent source so it disappears when committed.
  const previewId = "drawing-preview";
  if (ring.length < 2) return;
  const data: GeoJSON.Feature = {
    type: "Feature",
    geometry: { type: "LineString", coordinates: ring },
    properties: {},
  };
  if (map.getSource(previewId)) {
    (map.getSource(previewId) as mapboxgl.GeoJSONSource).setData(data);
  } else {
    map.addSource(previewId, { type: "geojson", data });
    map.addLayer({
      id: previewId,
      type: "line",
      source: previewId,
      paint: { "line-color": "#ed6c02", "line-width": 2, "line-dasharray": [2, 2] },
    });
  }
}
