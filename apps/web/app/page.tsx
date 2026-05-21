import Link from "next/link";

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "60px auto", padding: "0 24px", lineHeight: 1.6 }}>
      <h1>ZoneOps</h1>
      <p style={{ color: "#555" }}>Operational automation based on spatial context.</p>
      <ul>
        <li><Link href="/map">Live map</Link> — current asset positions, geofences, fence-enter events.</li>
      </ul>
      <p style={{ marginTop: 40, color: "#888", fontSize: 14 }}>
        Dev: set <code>NEXT_PUBLIC_MAPBOX_TOKEN</code> and{" "}
        <code>NEXT_PUBLIC_DEV_BEARER</code> in <code>.env</code>.
      </p>
    </main>
  );
}
