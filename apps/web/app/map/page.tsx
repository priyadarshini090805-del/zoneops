// Live map page. Server component shell that mounts the client-only LiveMap.
import LiveMap from "@/components/LiveMap";

export default function MapPage() {
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <LiveMap />
    </div>
  );
}
