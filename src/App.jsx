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
  MSI:  { color: "#dc2626", bg: "#fef2f2", label: "Zeer Ernstig+" },
  VSI:  { color: "#ea580c", bg: "#fff7ed", label: "Zeer Ernstig" },
  SI:   { color: "#d97706", bg: "#fffbeb", label: "Ernstig" },
  MI:   { color: "#6b7280", bg: "#f9fafb", label: "Gering" },
  INFO: { color: "#3b82f6", bg: "#eff6ff", label: "Info" },
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

function parseEvents(buffer, dec) {
  if (!buffer || buffer.byteLength < 24) return [];
  const view = new DataView(buffer);
  const size = buffer.byteLength;
  const labels = ["Tijdsoverlapping", "Kaartconflict", "Rijden zonder kaart", "Kaart ingestoken tijdens rijden", "Laatste sessie niet afgesloten", "Snelheidsoverschrijding"];
  const events = [];
  for (let offset = 0; offset + 24 <= size; offset += 24) {
    const eventType = view.getUint8(offset);
    if (eventType > 5) continue;
    const beginTs = view.getUint32(offset + 1, false);
    const endTs = view.getUint32(offset + 5, false);
    if (beginTs === 0 || beginTs === 0xFFFFFFFF || endTs === 0 || endTs === 0xFFFFFFFF) continue;
    if (beginTs <= 946684800 || beginTs >= 2000000000) continue;
    if (endTs <= 946684800 || endTs >= 2000000000) continue;
    const nation = view.getUint8(offset + 9);
    const regNum = dec.decode(new Uint8Array(buffer, offset + 11, 13)).replace(/\0/g, "").trim();
    events.push({
      type: eventType, typeLabel: labels[eventType] || String(eventType),
      beginTime: new Date(beginTs * 1000), endTime: new Date(endTs * 1000),
      vehicleReg: (NATIONS[nation] || "") + (regNum ? "-" + regNum : ""),
    });
  }
  return events;
}

function parseFaults(buffer, dec) {
  if (!buffer || buffer.byteLength < 24) return [];
  const view = new DataView(buffer);
  const size = buffer.byteLength;
  const labels = ["Kaartfout", "Tachograaffout"];
  const faults = [];
  for (let offset = 0; offset + 24 <= size; offset += 24) {
    const faultType = view.getUint8(offset);
    const beginTs = view.getUint32(offset + 1, false);
    const endTs = view.getUint32(offset + 5, false);
    if (beginTs === 0 || beginTs === 0xFFFFFFFF || endTs === 0 || endTs === 0xFFFFFFFF) continue;
    if (beginTs <= 946684800 || beginTs >= 2000000000) continue;
    if (endTs <= 946684800 || endTs >= 2000000000) continue;
    const nation = view.getUint8(offset + 9);
    const regNum = dec.decode(new Uint8Array(buffer, offset + 11, 13)).replace(/\0/g, "").trim();
    faults.push({
      type: faultType, typeLabel: labels[faultType] || String(faultType),
      beginTime: new Date(beginTs * 1000), endTime: new Date(endTs * 1000),
      vehicleReg: (NATIONS[nation] || "") + (regNum ? "-" + regNum : ""),
    });
  }
  return faults;
}

function parsePlaces(buffer, dec) {
  if (!buffer || buffer.byteLength < 10) return [];
  const view = new DataView(buffer);
  const size = buffer.byteLength;
  const labels = ["Begin werkdag", "Einde werkdag", "Begin rust", "Einde rust"];
  const places = [];
  for (let offset = 0; offset + 10 <= size; offset += 10) {
    const ts = view.getUint32(offset, false);
    if (ts === 0 || ts === 0xFFFFFFFF) continue;
    if (ts <= 946684800 || ts >= 2000000000) continue;
    const entryType = view.getUint8(offset + 4);
    const nationNum = view.getUint8(offset + 5);
    const region = view.getUint8(offset + 6);
    const odo = (view.getUint8(offset + 7) << 16) | (view.getUint8(offset + 8) << 8) | view.getUint8(offset + 9);
    places.push({
      time: new Date(ts * 1000),
      type: entryType,
      typeLabel: labels[entryType] || String(entryType),
      country: NATIONS[nationNum] || String(nationNum),
      odometer: odo,
    });
  }
  return places;
}

function parseLicence(buffer, dec) {
  if (!buffer || buffer.byteLength < 53) return { licenceNumber: null, licenceAuthority: null };
  const authority = dec.decode(new Uint8Array(buffer, 1, 35)).replace(/\0/g, "").trim();
  const number = dec.decode(new Uint8Array(buffer, 37, 16)).replace(/\0/g, "").trim();
  return { licenceNumber: number || null, licenceAuthority: authority || null };
}

function parseConditions(buffer) {
  if (!buffer || buffer.byteLength < 5) return [];
  const view = new DataView(buffer);
  const size = buffer.byteLength;
  const labels = ["Buiten scope begin", "Buiten scope einde", "Veerboot/trein begin", "Veerboot/trein einde"];
  const conditions = [];
  for (let offset = 0; offset + 5 <= size; offset += 5) {
    const ts = view.getUint32(offset, false);
    if (ts === 0 || ts === 0xFFFFFFFF) continue;
    if (ts <= 946684800 || ts >= 2000000000) continue;
    const condType = view.getUint8(offset + 4);
    conditions.push({
      time: new Date(ts * 1000),
      type: condType,
      typeLabel: labels[condType] || String(condType),
    });
  }
  return conditions;
}

function decodeName(buffer, offset, length) {
  if (!buffer || offset + length > buffer.byteLength) return "";
  const codePage = new Uint8Array(buffer)[offset];
  const textBytes = new Uint8Array(buffer, offset + 1, length - 1);
  const encodings = { 0x01: "iso-8859-1", 0x02: "iso-8859-2", 0x05: "iso-8859-5", 0x07: "iso-8859-7", 0x80: "utf-8" };
  const enc = encodings[codePage] || "iso-8859-1";
  try {
    return new TextDecoder(enc).decode(textBytes).replace(/\0/g, "").trim();
  } catch {
    return new TextDecoder("iso-8859-1").decode(textBytes).replace(/\0/g, "").trim();
  }
}

function parseDDD(buffer) {
  const efs = walkTLV(buffer);
  const dec = new TextDecoder("latin1");
  let name = null, cardNumber = null, cardIssuer = null, cardExpiry = null;
  const idBuf = efs[0x0520];
  if (idBuf && idBuf.byteLength >= 103) {
    const v = new DataView(idBuf);
    cardNumber = dec.decode(new Uint8Array(idBuf, 1, 16)).replace(/\0/g, "").trim();
    cardIssuer = decodeName(idBuf, 17, 36);
    const expiryTs = v.getUint32(61, false);
    if (expiryTs > 0 && expiryTs < 4294967295) cardExpiry = new Date(expiryTs * 1000);
    const sur = decodeName(idBuf, 65, 36);
    const fst = decodeName(idBuf, 101, 36);
    name = [fst, sur].filter(Boolean).join(" ");
  }
  let birthDate = null;
  if (idBuf && idBuf.byteLength >= 141) {
    const bd = new Uint8Array(idBuf, 137, 4);
    const y = ((bd[0] >> 4) * 10 + (bd[0] & 0x0F)) * 100 + (bd[1] >> 4) * 10 + (bd[1] & 0x0F);
    const m = (bd[2] >> 4) * 10 + (bd[2] & 0x0F);
    const d = (bd[3] >> 4) * 10 + (bd[3] & 0x0F);
    if (y > 1900 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      birthDate = `${String(d).padStart(2,"0")}/${String(m).padStart(2,"0")}/${y}`;
    }
  }

  const actBuf = efs[0x0504] || efs[0x0505];
  if (!actBuf) throw new Error("Geen activiteitsdata gevonden — geldig rijkaart .ddd bestand?");
  const vehBuf = efs[0x0504] ? efs[0x0505] : efs[0x0506];
  const vehicles = vehBuf ? parseVehicles(vehBuf, dec) : [];
  const events = parseEvents(efs[0x0502], dec);
  const faults = parseFaults(efs[0x0503], dec);
  const places = parsePlaces(efs[0x0506], dec);
  const { licenceNumber, licenceAuthority } = parseLicence(efs[0x0521], dec);
  const conditions = parseConditions(efs[0x0522]);

  let currentUsage = null;
  const cuBuf = efs[0x0507];
  if (cuBuf && cuBuf.byteLength >= 19) {
    const cuView = new DataView(cuBuf);
    const openTs = cuView.getUint32(0, false);
    if (openTs > 946684800 && openTs < 4294967295) {
      const nation = cuView.getUint8(4);
      const regNum = dec.decode(new Uint8Array(cuBuf, 6, 13)).replace(/\0/g, "").trim();
      currentUsage = {
        sessionStart: new Date(openTs * 1000),
        vehicle: (NATIONS[nation] || "") + (regNum ? "-" + regNum : ""),
      };
    }
  }

  let lastControl = null;
  const ctrlBuf = efs[0x0508];
  if (ctrlBuf && ctrlBuf.byteLength >= 46) {
    const ctrlView = new DataView(ctrlBuf);
    const ctrlType = ctrlView.getUint8(0);
    const ctrlTs = ctrlView.getUint32(1, false);
    if (ctrlTs > 946684800 && ctrlTs < 4294967295) {
      const ctrlCardNation = ctrlView.getUint8(5);
      const ctrlCardNum = dec.decode(new Uint8Array(ctrlBuf, 6, 16)).replace(/\0/g, "").trim();
      const dlBeginTs = ctrlView.getUint32(37, false);
      const dlEndTs = ctrlView.getUint32(41, false);
      const ctrlTypes = ["Kaartdownload", "Weergave", "Afdrukken", "VU-download"];
      lastControl = {
        type: ctrlType,
        typeLabel: ctrlTypes[ctrlType] || String(ctrlType),
        time: new Date(ctrlTs * 1000),
        controllerCard: ctrlCardNum,
        downloadPeriodBegin: dlBeginTs > 0 ? new Date(dlBeginTs * 1000) : null,
        downloadPeriodEnd: dlEndTs > 0 ? new Date(dlEndTs * 1000) : null,
      };
    }
  }

  return { days: parseActivity(actBuf), name, cardNumber, cardIssuer, cardExpiry, vehicles, events, faults, places, licenceNumber, licenceAuthority, conditions, currentUsage, lastControl, birthDate };
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
  const eventCount = (data?.events?.length || 0) + (data?.faults?.length || 0);
  const realViolations = useMemo(() => violations.filter(v => v.severity !== "INFO"), [violations]);
  const totalFine = useMemo(() => violations.reduce((s, v) => s + (v.estimatedFine || 0), 0), [violations]);

  const sevCounts = useMemo(() => {
    const c = { MSI: 0, VSI: 0, SI: 0, MI: 0, INFO: 0 };
    violations.forEach(v => { if (c[v.severity] !== undefined) c[v.severity]++; });
    return c;
  }, [violations]);

  /* glass card base */
  const glass = { background: "rgba(15,23,42,0.6)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", border: "1px solid rgba(56,72,96,0.4)", borderRadius: 12, padding: "14px 18px" };
  const glassAccent = (color) => ({ ...glass, borderLeft: `3px solid ${color}` });

  const TabBadge = ({ count, color }) => count > 0 ? <span className="tab-badge" style={{ background: color || "#3b82f6" }}>{count}</span> : null;

  return (
    <div className="app-root">
      {/* ── Header ────────────────────────────────────────────────── */}
      <header className="app-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="logo-mark">T</div>
          <div>
            <div className="logo-text">TACHOVIEWER</div>
            <div style={{ fontSize: 10, color: "#64748b", letterSpacing: "0.05em" }}>100% browser · geen upload</div>
          </div>
        </div>
        {data && (
          <div className="no-print header-actions">
            <button className="btn-export" onClick={() => exportPDF(data, violations)}>PDF</button>
            <button className="btn-export" onClick={() => exportExcel(data, violations)}>Excel</button>
            <button className="btn-export" onClick={() => exportCSV(data, violations)}>CSV</button>
            <button className="btn-ghost" onClick={() => setData(null)}>← Nieuw bestand</button>
          </div>
        )}
      </header>

      <div className="app-wrap">
        {/* ── Upload zone ──────────────────────────────────────────── */}
        {!data && !busy && (
          <div className={`dropzone ${drag ? "dropzone-active" : ""}`}
            onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); load(e.dataTransfer.files[0]); }}
            onClick={() => inputRef.current?.click()}>
            <input ref={inputRef} type="file" accept=".ddd,.esm,.tgd,.add" style={{ display: "none" }} onChange={e => load(e.target.files[0])} />
            <div className="dropzone-icon">
              <svg width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg>
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#e2e8f0", marginBottom: 8 }}>Sleep je .ddd bestand hier</div>
            <div style={{ color: "#64748b", marginBottom: 20 }}>of klik om te selecteren</div>
            <div className="dropzone-formats">.ddd .esm .tgd .add</div>
            <div style={{ fontSize: 11, color: "#475569", marginTop: 16 }}>🔒 Verwerking volledig in je browser — geen data wordt verstuurd</div>
          </div>
        )}
        {err && <div className="error-banner">⚠ {err}</div>}
        {busy && <div style={{ textAlign: "center", padding: 64, color: "#64748b" }}><div className="spinner" />Bestand verwerken...</div>}

        {data && days && (<>
          {/* ── Driver header ──────────────────────────────────────── */}
          <div style={{ marginBottom: 20 }}>
            <h1 className="driver-name">{data.name}</h1>
            <div className="driver-meta">
              {days.length} dagen · {days[0]?.date.toLocaleDateString("nl-BE")} → {days[days.length - 1]?.date.toLocaleDateString("nl-BE")}
              {data.birthDate && <span className="meta-sep">Geb. {data.birthDate}</span>}
              {data.licenceNumber && <span className="meta-sep">Rijbewijs {data.licenceNumber}</span>}
            </div>
          </div>

          {/* ── Info cards ─────────────────────────────────────────── */}
          <div className="info-grid">
            {data.cardNumber && <div style={glassAccent("#3b82f6")}>
              <div className="card-label">Rijkaart</div>
              <div className="card-value mono">{data.cardNumber}</div>
              {data.cardIssuer && <div className="card-sub">{data.cardIssuer}</div>}
              {data.cardExpiry && <div className="card-sub">Geldig tot {data.cardExpiry.toLocaleDateString("nl-BE")}</div>}
            </div>}
            {uniqueVehicles.map(v => (
              <div key={v.reg} style={glassAccent("#8b5cf6")}>
                <div className="card-label">Voertuig</div>
                <div className="card-value mono">{v.nation}-{v.reg}</div>
                <div className="card-sub">{v.odoBegin.toLocaleString("nl-BE")} → {v.odoEnd < 16777215 ? v.odoEnd.toLocaleString("nl-BE") : "—"} km</div>
              </div>
            ))}
            <div style={glassAccent(realViolations.length ? "#ef4444" : "#22c55e")}>
              <div className="card-label">Naleving</div>
              {realViolations.length === 0
                ? <div className="card-value" style={{ color: "#22c55e" }}>Conform</div>
                : <>
                    <div className="card-value" style={{ color: "#ef4444" }}>{realViolations.length} overtreding{realViolations.length !== 1 ? "en" : ""}</div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                      {Object.entries(sevCounts).filter(([k,c]) => c > 0 && k !== "INFO").map(([sev, c]) => (
                        <span key={sev} className="sev-badge" style={{ background: SEV[sev]?.color }}>{c}× {sev}</span>
                      ))}
                    </div>
                    {totalFine > 0 && <div style={{ fontSize: 11, color: "#f97316", marginTop: 6 }}>Geschatte boete: {totalFine.toLocaleString("nl-BE", { style: "currency", currency: "EUR" })}</div>}
                  </>
              }
            </div>
            {data.lastControl && <div style={glassAccent("#06b6d4")}>
              <div className="card-label">Laatste controle</div>
              <div className="card-value">{data.lastControl.typeLabel}</div>
              <div className="card-sub">{data.lastControl.time.toLocaleDateString("nl-BE")}</div>
              {data.lastControl.controllerCard && <div className="card-sub mono">{data.lastControl.controllerCard}</div>}
            </div>}
          </div>

          {/* ── Stat pills ─────────────────────────────────────────── */}
          <div className="stat-grid">
            {[
              { l: "Rijdagen", v: activeDays, c: "#ef4444", bg: "rgba(239,68,68,0.1)" },
              { l: "Afstand", v: `${totalKm.toLocaleString("nl-BE")} km`, c: "#22c55e", bg: "rgba(34,197,94,0.1)" },
              { l: "Rijtijd", v: fmtMins(driveMin), c: "#ef4444", bg: "rgba(239,68,68,0.1)" },
              { l: "Werktijd", v: fmtMins(workMin), c: "#fb923c", bg: "rgba(251,146,60,0.1)" },
              { l: "Beschikbaar", v: fmtMins(availMin), c: "#facc15", bg: "rgba(250,204,21,0.1)" },
              { l: "Rusttijd", v: fmtMins(restMin), c: "#60a5fa", bg: "rgba(96,165,250,0.1)" },
            ].map(s => (
              <div key={s.l} className="stat-card" style={{ background: s.bg, borderColor: `${s.c}30` }}>
                <div className="stat-label">{s.l}</div>
                <div className="stat-value" style={{ color: s.c }}>{s.v}</div>
              </div>
            ))}
          </div>

          {/* ── Tabs ───────────────────────────────────────────────── */}
          <div className="no-print tab-bar">
            {[
              { id: "activities", label: "Activiteiten", badge: 0, color: "" },
              { id: "violations", label: "Overtredingen", badge: realViolations.length, color: "#ef4444" },
              { id: "vehicles", label: "Voertuigen", badge: data.vehicles?.length || 0, color: "#8b5cf6" },
              { id: "events", label: "Gebeurtenissen", badge: eventCount, color: "#f97316" },
            ].map(t => (
              <button key={t.id} className={`tab-btn ${tab === t.id ? "tab-active" : ""}`} onClick={() => setTab(t.id)}>
                {t.label}<TabBadge count={t.badge} color={t.color} />
              </button>
            ))}
          </div>

          {/* ── Activities ─────────────────────────────────────────── */}
          {tab === "activities" && <>
            <div className="legend">
              {Object.entries(ACT).map(([k, v]) => (
                <div key={k} className="legend-item">
                  <div className="legend-dot" style={{ background: v.color }} />{v.label}
                </div>
              ))}
            </div>
            <div className="ruler">
              {[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => (
                <div key={h} style={{ flex: h < 24 ? 1 : 0, minWidth: 0 }}>{String(h).padStart(2, "0")}h</div>
              ))}
            </div>
            <div className="timeline-list">
              {days.map((day, i) => {
                const segs = toSegments(day.activities);
                const dm = segs.filter(s => s.act === 3).reduce((s, x) => s + x.dur, 0);
                const dayViols = violations.filter(v => v.date.toDateString() === day.date.toDateString());
                return (
                  <div key={i} className={`timeline-row ${dayViols.length ? "timeline-row-warn" : ""}`}>
                    <div className="timeline-label">
                      <span className="timeline-date">{fmtDate(day.date)}</span>
                      {day.dist > 0 && <span className="timeline-km">{day.dist} km</span>}
                    </div>
                    <div className="timeline-bar">
                      {segs.map((s, si) => (
                        <div key={si} data-act={s.act}
                          title={`${ACT[s.act].label} ${String(Math.floor(s.start/60)).padStart(2,"0")}:${String(s.start%60).padStart(2,"0")}–${String(Math.floor(s.end/60)).padStart(2,"0")}:${String(s.end%60).padStart(2,"0")} (${s.dur}m)`}
                          style={{ position: "absolute", left: `${(s.start/1440)*100}%`, width: `${Math.max((s.dur/1440)*100, 0.3)}%`, height: "100%", background: ACT[s.act].color, borderRadius: 1 }} />
                      ))}
                    </div>
                    <div className="timeline-dur">{dm > 0 ? `${Math.floor(dm/60)}h${String(dm%60).padStart(2,"0")}` : ""}</div>
                    {dayViols.length > 0 && <div className="timeline-warn">⚠</div>}
                  </div>
                );
              })}
            </div>
          </>}

          {/* ── Violations ─────────────────────────────────────────── */}
          {tab === "violations" && <>
            {violations.length === 0 ? (
              <div className="empty-state" style={{ color: "#22c55e" }}>
                <svg width="40" height="40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                <div>Geen overtredingen — volledig conform</div>
              </div>
            ) : (
              <>
                <div className="section-intro">{violations.length} resultaten · Reg 561/2006 + Dir 2002/15/EC + KB 17/10/2016</div>
                {violations.map((v, i) => (
                  <div key={i} className="violation-card">
                    <div className="violation-header">
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span className="sev-badge" style={{ background: SEV[v.severity]?.color }}>{v.severity}</span>
                        <span className="violation-rule">{v.rule}</span>
                      </div>
                      <span className="violation-date">{v.date.toLocaleDateString("nl-BE")}</span>
                    </div>
                    <div className="violation-desc">{v.description}</div>
                    <div className="violation-meta">
                      <span>Werkelijk: <b style={{ color: "#ef4444" }}>{v.actual}</b></span>
                      <span>Limiet: <b style={{ color: "#22c55e" }}>{v.limit}</b></span>
                      <span style={{ color: "#60a5fa" }}>{v.article}</span>
                      {v.estimatedFine > 0 && <span className="fine-tag">Boete: {v.estimatedFine.toLocaleString("nl-BE", { style: "currency", currency: "EUR" })}</span>}
                    </div>
                  </div>
                ))}
              </>
            )}
          </>}

          {/* ── Vehicles ───────────────────────────────────────────── */}
          {tab === "vehicles" && <>
            {data.vehicles?.length > 0 ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr>
                    <th>Registratie</th><th>Land</th><th>Km begin</th><th>Km einde</th><th>Eerste gebruik</th><th>Laatste gebruik</th>
                  </tr></thead>
                  <tbody>
                    {data.vehicles.map((v, i) => (
                      <tr key={i}>
                        <td className="mono bold">{v.reg}</td>
                        <td>{v.nation}</td>
                        <td>{v.odoBegin.toLocaleString("nl-BE")}</td>
                        <td>{v.odoEnd < 16777215 ? v.odoEnd.toLocaleString("nl-BE") : "—"}</td>
                        <td>{v.firstUse?.toLocaleDateString("nl-BE")}</td>
                        <td>{v.lastUse?.toLocaleDateString("nl-BE") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="empty-state">Geen voertuiggegevens</div>}
            {data.places?.length > 0 && <>
              <h3 className="section-title">Plaatsen ({data.places.length})</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Datum/tijd</th><th>Type</th><th>Land</th><th>Km</th></tr></thead>
                  <tbody>{data.places.map((p, i) => (
                    <tr key={i}><td>{p.time.toLocaleString("nl-BE")}</td><td>{p.typeLabel}</td><td>{p.country}</td><td>{p.odometer.toLocaleString("nl-BE")}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            </>}
          </>}

          {/* ── Events ─────────────────────────────────────────────── */}
          {tab === "events" && <>
            {data.events?.length > 0 && <>
              <h3 className="section-title">Gebeurtenissen ({data.events.length})</h3>
              <div className="table-wrap"><table className="data-table">
                <thead><tr><th>Type</th><th>Begin</th><th>Einde</th><th>Voertuig</th></tr></thead>
                <tbody>{data.events.map((ev, i) => (
                  <tr key={i}><td style={{ color: "#f97316" }}>{ev.typeLabel}</td><td>{ev.beginTime.toLocaleString("nl-BE")}</td><td>{ev.endTime.toLocaleString("nl-BE")}</td><td className="mono">{ev.vehicleReg}</td></tr>
                ))}</tbody>
              </table></div>
            </>}
            {data.faults?.length > 0 && <>
              <h3 className="section-title">Fouten ({data.faults.length})</h3>
              <div className="table-wrap"><table className="data-table">
                <thead><tr><th>Type</th><th>Begin</th><th>Einde</th><th>Voertuig</th></tr></thead>
                <tbody>{data.faults.map((f, i) => (
                  <tr key={i}><td style={{ color: "#ef4444" }}>{f.typeLabel}</td><td>{f.beginTime.toLocaleString("nl-BE")}</td><td>{f.endTime.toLocaleString("nl-BE")}</td><td className="mono">{f.vehicleReg}</td></tr>
                ))}</tbody>
              </table></div>
            </>}
            {data.conditions?.length > 0 && <>
              <h3 className="section-title">Bijzondere voorwaarden ({data.conditions.length})</h3>
              <div className="table-wrap"><table className="data-table">
                <thead><tr><th>Datum/tijd</th><th>Type</th></tr></thead>
                <tbody>{data.conditions.map((c, i) => (
                  <tr key={i}><td>{c.time.toLocaleString("nl-BE")}</td><td>{c.typeLabel}</td></tr>
                ))}</tbody>
              </table></div>
            </>}
            {eventCount === 0 && !data.conditions?.length && <div className="empty-state" style={{ color: "#22c55e" }}>Geen gebeurtenissen of fouten</div>}
          </>}

          {/* ── Footer ─────────────────────────────────────────────── */}
          <footer className="app-footer">
            <span>Rapport: {new Date().toLocaleString("nl-BE")}</span>
            <span>TachoViewer · Reg 561/2006 + Dir 2002/15/EC + KB 17/10/2016</span>
          </footer>
        </>)}
      </div>
    </div>
  );
}
