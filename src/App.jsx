import { useState, useRef, useCallback, useMemo } from "react";
import { checkCompliance } from "./compliance.js";
import { exportPDF, exportExcel, exportCSV } from "./exports.js";

/* ── industry-standard tachograph colors ─────────────────────────────── */
const ACT = {
  0: { color: "#60a5fa", label: "Rust", print: "#2563eb" },
  1: { color: "#facc15", label: "Beschikbaarheid", print: "#ca8a04" },
  2: { color: "#fb923c", label: "Werk", print: "#ea580c" },
  3: { color: "#ef4444", label: "Rijden", print: "#dc2626" },
};

const SEV = {
  MSI: { color: "#dc2626", bg: "#fef2f2", label: "Zeer Ernstig+" },
  VSI: { color: "#ea580c", bg: "#fff7ed", label: "Zeer Ernstig" },
  SI:  { color: "#d97706", bg: "#fffbeb", label: "Ernstig" },
  MI:  { color: "#6b7280", bg: "#f9fafb", label: "Gering" },
};

const NATIONS = {1:"A",2:"AL",3:"AND",4:"AM",5:"AZ",6:"B",7:"BG",8:"BA",9:"BY",10:"CH",11:"CY",12:"CZ",13:"D",14:"DK",15:"E",16:"EST",17:"F",18:"FIN",19:"FL",20:"FO",21:"UK",22:"GE",23:"GR",24:"H",25:"HR",26:"I",27:"IRL",28:"IS",29:"KZ",30:"L",31:"LT",32:"LV",33:"M",34:"MC",35:"MD",36:"MK",37:"MN",38:"N",39:"NL",40:"P",41:"PL",42:"RO",43:"RSM",44:"RUS",45:"S",46:"SK",47:"SLO",48:"TM",49:"TR",50:"UA",51:"V",52:"YU"};

/* ── DDD file parser ─────────────────────────────────────────────────── */

function walkTLV(buffer) {
  const view = new DataView(buffer);
  const size = buffer.byteLength;
  const gen1 = {}, gen2 = {};
  let offset = 0, found5 = false;
  while (offset + 5 <= size) {
    const tag = view.getUint16(offset, false);
    const typ = view.getUint8(offset + 2);
    const len = view.getUint16(offset + 3, false);
    if (len === 0 || offset + 5 + len > size) break;
    found5 = true;
    const data = buffer.slice(offset + 5, offset + 5 + len);
    if (typ === 0) gen1[tag] = data;
    else if (typ === 2) gen2[tag] = data;
    offset += 5 + len;
  }
  if (!found5) {
    offset = 0;
    while (offset + 4 <= size) {
      const tag = view.getUint16(offset, false);
      const len = view.getUint16(offset + 2, false);
      offset += 4;
      if (len === 0) continue;
      if (offset + len > size) break;
      gen1[tag] = buffer.slice(offset, offset + len);
      offset += len;
    }
  }
  const efs = {};
  for (const tag of new Set([...Object.keys(gen1), ...Object.keys(gen2)])) {
    efs[tag] = gen1[tag] || gen2[tag];
  }
  return efs;
}

function parseDDD(buffer) {
  const efs = walkTLV(buffer);
  const dec = new TextDecoder("latin1");
  let name = null, cardNumber = null, cardIssuer = null, cardExpiry = null;
  const idBuf = efs[0x0520];
  if (idBuf && idBuf.byteLength >= 103) {
    const v = new DataView(idBuf);
    cardNumber = dec.decode(new Uint8Array(idBuf, 1, 16)).replace(/\0/g, "").trim();
    cardIssuer = dec.decode(new Uint8Array(idBuf, 17, 36)).replace(/\0/g, "").trim();
    const expiryTs = v.getUint32(61, false);
    if (expiryTs > 0 && expiryTs < 4294967295) cardExpiry = new Date(expiryTs * 1000);
    const sur = dec.decode(new Uint8Array(idBuf, 66, 35)).replace(/\0/g, "").trim();
    const fst = dec.decode(new Uint8Array(idBuf, 102, 35)).replace(/\0/g, "").trim();
    name = [fst, sur].filter(Boolean).join(" ");
  }
  const actBuf = efs[0x0504] || efs[0x0505];
  if (!actBuf) throw new Error("Geen activiteitsdata gevonden — geldig rijkaart .ddd bestand?");
  const vehBuf = efs[0x0504] ? efs[0x0505] : efs[0x0506];
  const vehicles = vehBuf ? parseVehicles(vehBuf, dec) : [];
  return { days: parseActivity(actBuf), name, cardNumber, cardIssuer, cardExpiry, vehicles };
}

function parseVehicles(buffer, dec) {
  const view = new DataView(buffer);
  const size = buffer.byteLength;
  if (size < 4) return [];
  dec = dec || new TextDecoder("latin1");
  const vehicles = [];
  let offset = 2;
  while (offset + 31 <= size && vehicles.length < 300) {
    const odoBegin = (view.getUint8(offset) << 16) | (view.getUint8(offset+1) << 8) | view.getUint8(offset+2);
    const odoEnd = (view.getUint8(offset+3) << 16) | (view.getUint8(offset+4) << 8) | view.getUint8(offset+5);
    const tsFirst = view.getUint32(offset + 6, false);
    const tsLast = view.getUint32(offset + 10, false);
    const nation = view.getUint8(offset + 14);
    const regNum = dec.decode(new Uint8Array(buffer, offset + 16, 13)).replace(/\0/g, "").trim();
    if (tsFirst > 946684800 && tsFirst < 2000000000 && regNum.length > 0) {
      vehicles.push({ reg: regNum, nation: NATIONS[nation] || String(nation), odoBegin, odoEnd,
        firstUse: new Date(tsFirst * 1000), lastUse: tsLast > 0 && tsLast < 4294967295 ? new Date(tsLast * 1000) : null });
    }
    offset += 31;
  }
  return vehicles;
}

function parseActivity(buffer) {
  const view = new DataView(buffer);
  const size = buffer.byteLength;
  if (size < 4) return [];
  function readChunk(from, to, out) {
    let offset = from, guard = 0;
    while (offset + 12 <= to && guard++ < 400) {
      const recLen = view.getUint16(offset + 2, false);
      if (recLen < 12 || recLen > 8192 || offset + recLen > to) break;
      const ts = view.getUint32(offset + 4, false);
      const dist = view.getUint16(offset + 10, false);
      const date = new Date(ts * 1000);
      if (date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2050) {
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
  function scanWithWrap(ptr) {
    const bufStart = 4;
    const startOff = bufStart + (ptr > 0 && ptr < size - bufStart ? ptr : 0);
    const days = [];
    readChunk(startOff, size, days);
    if (startOff > bufStart) readChunk(bufStart, startOff, days);
    return days;
  }
  for (const fn of [
    () => scanWithWrap(view.getUint16(2, false)),
    () => scanWithWrap(view.getUint16(0, false)),
    () => { const d = []; readChunk(4, size, d); return d; },
    () => { const d = []; readChunk(0, size, d); return d; },
  ]) { const days = fn(); if (days.length > 0) return days.sort((a, b) => a.date - b.date); }
  return [];
}

/* ── helpers ──────────────────────────────────────────────────────────── */
function toSegments(acts) {
  if (!acts.length) return [];
  const sorted = [...acts].sort((a, b) => a.time - b.time);
  return sorted.map((a, i) => {
    const start = a.time, end = sorted[i + 1]?.time ?? 1440;
    return { act: a.act, start, end, dur: end - start };
  }).filter(s => s.dur > 0);
}
function sumAct(days, code) { return days.reduce((sum, d) => sum + toSegments(d.activities).filter(s => s.act === code).reduce((s, x) => s + x.dur, 0), 0); }
function fmtMins(m) { return `${Math.floor(m / 60)}u ${String(m % 60).padStart(2, "0")}m`; }
function fmtDate(d) { return d.toLocaleDateString("nl-BE", { weekday: "short", day: "2-digit", month: "2-digit" }); }

/* ── main component ──────────────────────────────────────────────────── */
export default function App() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [tab, setTab] = useState("activities");
  const inputRef = useRef();

  const violations = useMemo(() => data?.days ? checkCompliance(data.days) : [], [data]);

  const load = useCallback((file) => {
    if (!file) return;
    setBusy(true); setErr(null);
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const res = parseDDD(e.target.result);
        if (!res.name) res.name = file.name.replace(/\.[^.]+$/, "");
        setData(res); setTab("activities");
      } catch (ex) { setErr(ex.message); }
      setBusy(false);
    };
    r.onerror = () => { setErr("Kon bestand niet lezen."); setBusy(false); };
    r.readAsArrayBuffer(file);
  }, []);

  const days = data?.days;
  const totalKm = days ? days.reduce((s, d) => s + d.dist, 0) : 0;
  const driveMin = days ? sumAct(days, 3) : 0;
  const workMin = days ? sumAct(days, 2) : 0;
  const availMin = days ? sumAct(days, 1) : 0;
  const restMin = days ? sumAct(days, 0) : 0;
  const activeDays = days ? days.filter(d => d.activities.some(a => a.act === 3)).length : 0;
  const uniqueVehicles = data?.vehicles ? [...new Map(data.vehicles.map(v => [v.reg, v])).values()] : [];

  const sevCounts = useMemo(() => {
    const c = { MSI: 0, VSI: 0, SI: 0, MI: 0 };
    violations.forEach(v => { if (c[v.severity] !== undefined) c[v.severity]++; });
    return c;
  }, [violations]);

  const S = {
    root: { fontFamily: "'Segoe UI', system-ui, sans-serif", minHeight: "100vh", background: "#080b12", color: "#c9d1d9", fontSize: 13 },
    hdr: { background: "#0d1117", borderBottom: "2px solid #1c2333", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 },
    logo: { fontWeight: 700, fontSize: 16, color: "#e6edf3", letterSpacing: 1, fontFamily: "'Courier New', monospace" },
    badge: { fontSize: 10, color: "#3b82f6", border: "1px solid #1d3557", borderRadius: 4, padding: "2px 8px", marginLeft: 8, fontFamily: "monospace" },
    wrap: { maxWidth: 1100, margin: "0 auto", padding: "24px 16px" },
    dropzone: (isDrag) => ({ border: `2px dashed ${isDrag ? "#3b82f6" : "#1c2333"}`, borderRadius: 12, padding: "64px 32px", textAlign: "center", cursor: "pointer", background: isDrag ? "#0d1929" : "#0d1117", transition: "all 0.15s" }),
    card: { background: "#0d1117", border: "1px solid #1c2333", borderRadius: 8, padding: "12px 16px" },
    stats: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))", gap: 8, marginBottom: 20 },
    infoGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10, marginBottom: 16 },
    ruler: { display: "flex", paddingLeft: 98, marginBottom: 3, gap: 0, paddingRight: 48 },
    bands: { display: "flex", flexDirection: "column", gap: 1 },
    row: { display: "flex", alignItems: "center", gap: 8 },
    lbl: { width: 90, flexShrink: 0, textAlign: "right", paddingRight: 8, fontSize: 10 },
    band: { flex: 1, height: 18, background: "#161b22", borderRadius: 2, overflow: "hidden", position: "relative" },
    dur: { width: 42, textAlign: "right", fontSize: 9, color: "#6b7280", flexShrink: 0 },
    btn: { background: "#1d6aff", color: "white", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 },
    btnSm: { background: "#1c2333", color: "#c9d1d9", border: "1px solid #2d3748", borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 11 },
    btnGhost: { background: "transparent", color: "#6b7280", border: "1px solid #2d3748", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 12 },
    err: { background: "#1a0505", border: "1px solid #7f1d1d", borderRadius: 8, padding: "12px 16px", color: "#fca5a5", marginTop: 12 },
    tabBar: { display: "flex", gap: 4, marginBottom: 16, borderBottom: "1px solid #1c2333", paddingBottom: 8 },
    tab: (active) => ({ padding: "6px 16px", borderRadius: "6px 6px 0 0", cursor: "pointer", fontSize: 12, fontWeight: active ? 600 : 400, color: active ? "#e6edf3" : "#6b7280", background: active ? "#1c2333" : "transparent", border: "none" }),
    vRow: { background: "#0d1117", border: "1px solid #1c2333", borderRadius: 8, padding: "10px 14px", marginBottom: 6 },
    sevBadge: (sev) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, color: "#fff", background: SEV[sev]?.color || "#6b7280" }),
  };

  return (
    <div style={S.root}>
      <div style={S.hdr}>
        <div><span style={S.logo}>TACHOVIEWER</span><span style={S.badge}>offline · browser-only</span></div>
        {data && (
          <div className="no-print" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button style={S.btnSm} onClick={() => exportPDF(data, violations)}>PDF</button>
            <button style={S.btnSm} onClick={() => exportExcel(data, violations)}>Excel</button>
            <button style={S.btnSm} onClick={() => exportCSV(data, violations)}>CSV</button>
            <button style={S.btnGhost} onClick={() => setData(null)}>← nieuw</button>
          </div>
        )}
      </div>
      <div style={S.wrap}>
        {!data && !busy && (
          <div style={S.dropzone(drag)} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); load(e.dataTransfer.files[0]); }} onClick={() => inputRef.current?.click()}>
            <input ref={inputRef} type="file" accept=".ddd,.esm,.tgd,.add" style={{ display: "none" }} onChange={e => load(e.target.files[0])} />
            <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#e6edf3", marginBottom: 6 }}>Sleep je .ddd bestand hier</div>
            <div style={{ color: "#4b5563", marginBottom: 16 }}>of klik om te selecteren · .ddd .esm .tgd .add</div>
            <div style={{ fontSize: 11, color: "#374151" }}>🔒 Bestand verlaat je browser nooit</div>
          </div>
        )}
        {err && <div style={S.err}>⚠ {err}</div>}
        {busy && <div style={{ textAlign: "center", padding: 48, color: "#4b5563" }}>verwerken...</div>}

        {data && days && (<>
          {/* Header */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#e6edf3" }}>{data.name}</div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              {days.length} dagrecords · {days[0]?.date.toLocaleDateString("nl-BE")} → {days[days.length - 1]?.date.toLocaleDateString("nl-BE")}
            </div>
          </div>

          {/* Card & Vehicle info */}
          <div style={S.infoGrid}>
            {data.cardNumber && <div style={S.card}>
              <div style={{ fontSize: 9, color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Rijkaart</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", fontFamily: "monospace" }}>{data.cardNumber}</div>
              {data.cardIssuer && <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>{data.cardIssuer}</div>}
              {data.cardExpiry && <div style={{ fontSize: 10, color: "#6b7280" }}>Geldig tot {data.cardExpiry.toLocaleDateString("nl-BE")}</div>}
            </div>}
            {uniqueVehicles.map(v => (
              <div key={v.reg} style={S.card}>
                <div style={{ fontSize: 9, color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Voertuig</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3", fontFamily: "monospace" }}>{v.nation}-{v.reg}</div>
                <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>{v.odoBegin.toLocaleString("nl-BE")} → {v.odoEnd < 16777215 ? v.odoEnd.toLocaleString("nl-BE") : "—"} km</div>
              </div>
            ))}
            {/* Compliance badge */}
            <div style={{ ...S.card, borderColor: violations.length ? "#7f1d1d" : "#14532d" }}>
              <div style={{ fontSize: 9, color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Naleving</div>
              {violations.length === 0
                ? <div style={{ fontSize: 14, fontWeight: 700, color: "#22c55e" }}>Geen overtredingen</div>
                : <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#ef4444", marginBottom: 4 }}>{violations.length} overtreding{violations.length !== 1 ? "en" : ""}</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {Object.entries(sevCounts).filter(([,c]) => c > 0).map(([sev, c]) => (
                        <span key={sev} style={S.sevBadge(sev)}>{c}× {sev}</span>
                      ))}
                    </div>
                  </div>
              }
            </div>
          </div>

          {/* Stats */}
          <div style={S.stats}>
            {[
              { l: "Rijdagen", v: activeDays, c: "#ef4444" },
              { l: "Afstand", v: `${totalKm.toLocaleString("nl-BE")} km`, c: "#22c55e" },
              { l: "Rijtijd", v: fmtMins(driveMin), c: "#ef4444" },
              { l: "Werktijd", v: fmtMins(workMin), c: "#fb923c" },
              { l: "Beschikbaar", v: fmtMins(availMin), c: "#facc15" },
              { l: "Rusttijd", v: fmtMins(restMin), c: "#60a5fa" },
            ].map(s => (
              <div key={s.l} style={S.card}>
                <div style={{ fontSize: 9, color: "#4b5563", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>{s.l}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: s.c }}>{s.v}</div>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="no-print" style={S.tabBar}>
            <button style={S.tab(tab === "activities")} onClick={() => setTab("activities")}>Activiteiten</button>
            <button style={S.tab(tab === "violations")} onClick={() => setTab("violations")}>
              Overtredingen {violations.length > 0 && <span style={{ background: "#ef4444", color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 10, marginLeft: 4 }}>{violations.length}</span>}
            </button>
          </div>

          {/* Activities tab */}
          {tab === "activities" && <>
            <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
              {Object.entries(ACT).map(([k, v]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#9ca3af" }}>
                  <div style={{ width: 14, height: 14, background: v.color, borderRadius: 2 }} />{v.label}
                </div>
              ))}
            </div>
            <div style={S.ruler}>
              {[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => (
                <div key={h} style={{ flex: h < 24 ? 1 : 0, fontSize: 9, color: "#4b5563", minWidth: 0 }}>{String(h).padStart(2, "0")}h</div>
              ))}
            </div>
            <div style={S.bands}>
              {days.map((day, i) => {
                const segs = toSegments(day.activities);
                const dm = segs.filter(s => s.act === 3).reduce((s, x) => s + x.dur, 0);
                const dayViols = violations.filter(v => v.date.toDateString() === day.date.toDateString());
                return (
                  <div key={i} style={{ ...S.row, background: dayViols.length ? "rgba(127,29,29,0.15)" : "transparent", borderRadius: 3, padding: "0 4px" }}>
                    <div style={S.lbl}>
                      <div style={{ color: "#9ca3af" }}>{fmtDate(day.date)}</div>
                      {day.dist > 0 && <div style={{ color: "#4b5563", fontSize: 9 }}>{day.dist} km</div>}
                    </div>
                    <div style={S.band}>
                      {segs.map((s, si) => (
                        <div key={si} data-act={s.act}
                          title={`${ACT[s.act].label} ${String(Math.floor(s.start/60)).padStart(2,"0")}:${String(s.start%60).padStart(2,"0")}–${String(Math.floor(s.end/60)).padStart(2,"0")}:${String(s.end%60).padStart(2,"0")} (${s.dur}m)`}
                          style={{ position: "absolute", left: `${(s.start/1440)*100}%`, width: `${Math.max((s.dur/1440)*100, 0.3)}%`, height: "100%", background: ACT[s.act].color }} />
                      ))}
                    </div>
                    <div style={S.dur}>{dm > 0 ? `${Math.floor(dm/60)}h${String(dm%60).padStart(2,"0")}` : ""}</div>
                    {dayViols.length > 0 && <div style={{ fontSize: 9, color: "#ef4444", width: 16, textAlign: "center" }}>⚠</div>}
                  </div>
                );
              })}
            </div>
          </>}

          {/* Violations tab */}
          {tab === "violations" && <>
            {violations.length === 0 ? (
              <div style={{ textAlign: "center", padding: 48, color: "#22c55e", fontSize: 16 }}>
                Geen overtredingen gevonden — volledig conform
              </div>
            ) : (
              <div>
                <div style={{ marginBottom: 12, fontSize: 12, color: "#6b7280" }}>
                  {violations.length} overtreding{violations.length !== 1 ? "en" : ""} gevonden op basis van Reg 561/2006 en Dir 2002/15/EC
                </div>
                {violations.map((v, i) => (
                  <div key={i} style={S.vRow}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={S.sevBadge(v.severity)}>{v.severity}</span>
                        <span style={{ fontWeight: 600, color: "#e6edf3" }}>{v.rule}</span>
                      </div>
                      <span style={{ fontSize: 11, color: "#6b7280" }}>{v.date.toLocaleDateString("nl-BE")}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 4 }}>{v.description}</div>
                    <div style={{ display: "flex", gap: 16, fontSize: 10, color: "#4b5563" }}>
                      <span>Werkelijk: <b style={{ color: "#ef4444" }}>{v.actual}</b></span>
                      <span>Limiet: <b style={{ color: "#22c55e" }}>{v.limit}</b></span>
                      <span style={{ color: "#3b82f6" }}>{v.article}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>}

          {/* Footer */}
          <div style={{ marginTop: 24, paddingTop: 12, borderTop: "1px solid #1c2333", fontSize: 9, color: "#4b5563", display: "flex", justifyContent: "space-between" }}>
            <span>Rapport: {new Date().toLocaleString("nl-BE")}</span>
            <span>TachoViewer · lokale verwerking · Reg 561/2006 + Dir 2002/15/EC</span>
          </div>
        </>)}
      </div>
    </div>
  );
}
