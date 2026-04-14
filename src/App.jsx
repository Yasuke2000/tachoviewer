import { useState, useRef, useCallback } from "react";

const ACT = {
  0: { color: "#22c55e", label: "Rust" },
  1: { color: "#eab308", label: "Beschikbaarheid" },
  2: { color: "#f97316", label: "Werk" },
  3: { color: "#3b82f6", label: "Rijden" },
};

function parseDDD(buffer) {
  const view = new DataView(buffer);
  const size = buffer.byteLength;
  let actBuf = null, name = null;

  // Try 5-byte header first: Tag(2) + Type(1) + Length(2)
  // EU digital tachograph card download format
  let offset = 0;
  while (offset + 5 <= size) {
    const tag = view.getUint16(offset, false);
    const typ = view.getUint8(offset + 2);
    const len = view.getUint16(offset + 3, false);
    if (len === 0 || offset + 5 + len > size) break;
    const dataOff = offset + 5;

    // EF_Identification (0x0520): extract driver name
    // Only use data records (type 0 or 2), not signatures (type 1 or 3)
    if (tag === 0x0520 && (typ === 0 || typ === 2) && len >= 103 && !name) {
      const dec = new TextDecoder("latin1");
      // surname at byte 66 (after codepage byte at 65), 35 chars
      const sur = dec.decode(new Uint8Array(buffer, dataOff + 66, 35)).replace(/\0/g, "").trim();
      // firstName at byte 102 (after codepage byte at 101), 35 chars
      const fst = dec.decode(new Uint8Array(buffer, dataOff + 102, 35)).replace(/\0/g, "").trim();
      name = [fst, sur].filter(Boolean).join(" ");
    }

    // EF_Driver_Activity_Data (0x0504 or 0x0505 depending on card/tool)
    if ((tag === 0x0504 || tag === 0x0505) && (typ === 0 || typ === 2)) {
      if (!actBuf || len > actBuf.byteLength) {
        actBuf = buffer.slice(dataOff, dataOff + len);
      }
    }

    offset = dataOff + len;
  }

  // Fallback: try 4-byte header: Tag(2) + Length(2) (older download tools)
  if (!actBuf) {
    offset = 0;
    while (offset + 4 <= size) {
      const tag = view.getUint16(offset, false);
      const len = view.getUint16(offset + 2, false);
      offset += 4;
      if (len === 0) continue;
      if (offset + len > size) break;
      if (tag === 0x0520 && len >= 103 && !name) {
        const dec = new TextDecoder("latin1");
        const sur = dec.decode(new Uint8Array(buffer, offset + 66, 35)).replace(/\0/g, "").trim();
        const fst = dec.decode(new Uint8Array(buffer, offset + 102, 35)).replace(/\0/g, "").trim();
        name = [fst, sur].filter(Boolean).join(" ");
      }
      if (tag === 0x0502 && len >= 35 && !name) {
        const dec = new TextDecoder("latin1");
        const sur = dec.decode(new Uint8Array(buffer, offset, 35)).replace(/\0/g, "").trim();
        const fst = len >= 70 ? dec.decode(new Uint8Array(buffer, offset + 35, 35)).replace(/\0/g, "").trim() : "";
        name = [fst, sur].filter(Boolean).join(" ");
      }
      if (tag === 0x0504 || tag === 0x0505) {
        if (!actBuf || len > actBuf.byteLength) {
          actBuf = buffer.slice(offset, offset + len);
        }
      }
      offset += len;
    }
  }

  if (!actBuf) throw new Error("Geen activiteitsdata gevonden — geldig rijkaart .ddd bestand?");
  return { days: parseActivity(actBuf), name };
}

function parseActivity(buffer) {
  const view = new DataView(buffer);
  const size = buffer.byteLength;
  if (size < 4) return [];

  function readChunk(from, to, out) {
    let offset = from;
    let guard = 0;
    while (offset + 12 <= to && guard++ < 400) {
      const recLen = view.getUint16(offset + 2, false);
      if (recLen < 12 || recLen > 8192 || offset + recLen > to) break;
      const ts   = view.getUint32(offset + 4, false);
      const dist = view.getUint16(offset + 10, false);
      const date = new Date(ts * 1000);
      const yr   = date.getUTCFullYear();
      if (yr >= 2000 && yr <= 2050) {
        const activities = [];
        for (let i = offset + 12; i + 1 < offset + recLen && i + 1 <= to; i += 2) {
          const w = view.getUint16(i, false);
          if ((w >> 15) & 1) continue;
          activities.push({ act: (w >> 11) & 3, time: w & 0x7ff });
        }
        if (activities.length > 0 || dist > 0) out.push({ date, dist, activities });
      }
      offset += recLen;
    }
  }

  // Read from startOff → end, then wrap: bufStart → startOff (circular buffer)
  function scanWithWrap(ptr) {
    const bufStart  = 4;
    const startOff  = bufStart + (ptr > 0 && ptr < size - bufStart ? ptr : 0);
    const days = [];
    readChunk(startOff, size, days);
    if (startOff > bufStart) readChunk(bufStart, startOff, days);
    return days;
  }

  // EU spec: bytes 0-1 = presence counter, bytes 2-3 = offset to oldest record.
  // Fall back to bytes 0-1 and plain linear starts for older/non-standard cards.
  const ptr2 = view.getUint16(2, false);
  const ptr0 = view.getUint16(0, false);
  for (const fn of [
    () => scanWithWrap(ptr2),
    () => scanWithWrap(ptr0),
    () => { const d = []; readChunk(4, size, d); return d; },
    () => { const d = []; readChunk(0, size, d); return d; },
  ]) {
    const days = fn();
    if (days.length > 0) return days.sort((a, b) => a.date - b.date);
  }
  return [];
}

function toSegments(acts) {
  if (!acts.length) return [];
  const sorted = [...acts].sort((a, b) => a.time - b.time);
  return sorted
    .map((a, i) => {
      const start = a.time, end = sorted[i + 1]?.time ?? 1440;
      return { act: a.act, start, end, dur: end - start };
    })
    .filter((s) => s.dur > 0);
}

function sumAct(days, code) {
  return days.reduce(
    (sum, d) =>
      sum + toSegments(d.activities).filter((s) => s.act === code).reduce((s, x) => s + x.dur, 0),
    0
  );
}

function fmtMins(m) { return `${Math.floor(m / 60)}u ${String(m % 60).padStart(2, "0")}m`; }
function fmtDate(d) { return d.toLocaleDateString("nl-BE", { weekday: "short", day: "2-digit", month: "2-digit" }); }

export default function App() {
  const [days, setDays] = useState(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef();

  const load = useCallback((file) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const res = parseDDD(e.target.result);
        setDays(res.days);
        setName(res.name || file.name.replace(/\.[^.]+$/, ""));
      } catch (ex) {
        setErr(ex.message);
      }
      setBusy(false);
    };
    r.onerror = () => { setErr("Kon bestand niet lezen."); setBusy(false); };
    r.readAsArrayBuffer(file);
  }, []);

  const totalKm = days ? days.reduce((s, d) => s + d.dist, 0) : 0;
  const driveMin = days ? sumAct(days, 3) : 0;
  const restMin = days ? sumAct(days, 0) : 0;
  const activeDays = days ? days.filter((d) => d.activities.some((a) => a.act === 3)).length : 0;

  const styles = {
    root: { fontFamily: "'Courier New', monospace", minHeight: "100vh", background: "#080b12", color: "#c9d1d9", fontSize: 13 },
    hdr: { background: "#0d1117", borderBottom: "2px solid #1c2333", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" },
    logo: { fontWeight: 700, fontSize: 16, color: "#e6edf3", letterSpacing: 1 },
    badge: { fontSize: 10, color: "#3b82f6", border: "1px solid #1d3557", borderRadius: 4, padding: "2px 8px", marginLeft: 8 },
    wrap: { maxWidth: 1040, margin: "0 auto", padding: "24px 16px" },
    dropzone: (isDrag) => ({ border: `2px dashed ${isDrag ? "#3b82f6" : "#1c2333"}`, borderRadius: 12, padding: "64px 32px", textAlign: "center", cursor: "pointer", background: isDrag ? "#0d1929" : "#0d1117", transition: "all 0.15s" }),
    card: { background: "#0d1117", border: "1px solid #1c2333", borderRadius: 8, padding: "12px 16px" },
    stats: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(140px,1fr))", gap: 10, marginBottom: 20 },
    ruler: { display: "flex", paddingLeft: 98, marginBottom: 3, gap: 0 },
    bands: { display: "flex", flexDirection: "column", gap: 2 },
    row: { display: "flex", alignItems: "center", gap: 8 },
    lbl: { width: 90, flexShrink: 0, textAlign: "right", paddingRight: 8, fontSize: 10 },
    band: { flex: 1, height: 17, background: "#0d1117", borderRadius: 2, overflow: "hidden", position: "relative", border: "1px solid #161b27" },
    dur: { width: 40, textAlign: "right", fontSize: 9, color: "#374151", flexShrink: 0 },
    btn: { background: "#1d6aff", color: "white", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 },
    btnGhost: { background: "transparent", color: "#6b7280", border: "1px solid #2d3748", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 12 },
    err: { background: "#1a0505", border: "1px solid #7f1d1d", borderRadius: 8, padding: "12px 16px", color: "#fca5a5", marginTop: 12 },
  };

  return (
    <div style={styles.root}>
      <div style={styles.hdr}>
        <div>
          <span style={styles.logo}>TACHOVIEWER</span>
          <span style={styles.badge}>offline · browser-only</span>
        </div>
        {days && (
          <div className="no-print" style={{ display: "flex", gap: 8 }}>
            <button style={styles.btnGhost} onClick={() => { setDays(null); setName(""); }}>← nieuw</button>
            <button style={styles.btn} onClick={() => window.print()}>↓ PDF</button>
          </div>
        )}
      </div>

      <div style={styles.wrap}>
        {!days && !busy && (
          <div
            style={styles.dropzone(drag)}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); load(e.dataTransfer.files[0]); }}
            onClick={() => inputRef.current?.click()}
          >
            <input ref={inputRef} type="file" accept=".ddd,.esm,.tgd,.add" style={{ display: "none" }} onChange={(e) => load(e.target.files[0])} />
            <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#e6edf3", marginBottom: 6 }}>Sleep je .ddd bestand hier</div>
            <div style={{ color: "#4b5563", marginBottom: 16 }}>of klik om te selecteren · .ddd .esm .tgd .add</div>
            <div style={{ fontSize: 11, color: "#374151" }}>🔒 Bestand verlaat je browser nooit</div>
          </div>
        )}

        {err && <div style={styles.err}>⚠ {err}</div>}
        {busy && <div style={{ textAlign: "center", padding: 48, color: "#4b5563" }}>verwerken...</div>}

        {days && (
          <>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#e6edf3", marginBottom: 2 }}>{name}</div>
              <div style={{ fontSize: 11, color: "#4b5563", marginBottom: 16 }}>
                {days.length} dagrecords · {days[0]?.date.toLocaleDateString("nl-BE")} → {days[days.length - 1]?.date.toLocaleDateString("nl-BE")}
              </div>
              <div style={styles.stats}>
                {[
                  { l: "Rijdagen", v: activeDays, c: "#3b82f6" },
                  { l: "Afstand", v: `${totalKm.toLocaleString("nl-BE")} km`, c: "#22c55e" },
                  { l: "Rijtijd", v: fmtMins(driveMin), c: "#3b82f6" },
                  { l: "Rusttijd", v: fmtMins(restMin), c: "#22c55e" },
                ].map((s) => (
                  <div key={s.l} style={styles.card}>
                    <div style={{ fontSize: 9, color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 5 }}>{s.l}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: s.c }}>{s.v}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
                {Object.entries(ACT).map(([k, v]) => (
                  <div key={k} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "#6b7280" }}>
                    <div style={{ width: 12, height: 12, background: v.color, borderRadius: 2 }} />
                    {v.label}
                  </div>
                ))}
              </div>
            </div>

            <div style={styles.ruler}>
              {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
                <div key={h} style={{ flex: h < 24 ? 1 : 0, fontSize: 9, color: "#374151", minWidth: 0 }}>{String(h).padStart(2, "0")}h</div>
              ))}
            </div>

            <div style={styles.bands}>
              {days.map((day, i) => {
                const segs = toSegments(day.activities);
                const dm = segs.filter((s) => s.act === 3).reduce((s, x) => s + x.dur, 0);
                return (
                  <div key={i} style={styles.row}>
                    <div style={styles.lbl}>
                      <div style={{ color: "#9ca3af" }}>{fmtDate(day.date)}</div>
                      {day.dist > 0 && <div style={{ color: "#374151", fontSize: 9 }}>{day.dist} km</div>}
                    </div>
                    <div style={styles.band}>
                      {segs.map((s, si) => (
                        <div
                          key={si}
                          data-act={s.act}
                          title={`${ACT[s.act].label} ${String(Math.floor(s.start / 60)).padStart(2, "0")}:${String(s.start % 60).padStart(2, "0")}–${String(Math.floor(s.end / 60)).padStart(2, "0")}:${String(s.end % 60).padStart(2, "0")} (${s.dur}m)`}
                          style={{ position: "absolute", left: `${(s.start / 1440) * 100}%`, width: `${(s.dur / 1440) * 100}%`, height: "100%", background: ACT[s.act].color, opacity: 0.88 }}
                        />
                      ))}
                    </div>
                    <div style={styles.dur}>{dm > 0 ? `${Math.floor(dm / 60)}h${String(dm % 60).padStart(2, "0")}` : ""}</div>
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: 24, paddingTop: 12, borderTop: "1px solid #1c2333", fontSize: 9, color: "#374151", display: "flex", justifyContent: "space-between" }}>
              <span>Rapport: {new Date().toLocaleString("nl-BE")}</span>
              <span>TachoViewer · lokale verwerking</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
