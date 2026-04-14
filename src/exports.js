// Lazy-loaded: these are imported dynamically to keep the initial bundle small

/* ── helpers ─────────────────────────────────────────────────────────── */

const ACT_LABELS = ["Rust", "Beschikbaar", "Werk", "Rijden"];

function toSegments(acts) {
  if (!acts.length) return [];
  const sorted = [...acts].sort((a, b) => a.time - b.time);
  return sorted
    .map((a, i) => {
      const start = a.time;
      const end = sorted[i + 1]?.time ?? 1440;
      return { act: a.act, start, end, dur: end - start };
    })
    .filter((s) => s.dur > 0);
}

function fmtMins(m) {
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

function fmtDate(d) {
  return d.toLocaleDateString("nl-BE");
}

/** Compute per-day totals from a day's activities. */
function dayTotals(day) {
  const segs = toSegments(day.activities);
  const mins = [0, 0, 0, 0]; // rest, available, work, driving
  for (const s of segs) mins[s.act] += s.dur;
  return { rest: mins[0], available: mins[1], work: mins[2], driving: mins[3] };
}

/** Count violations on a given date. */
function violationsOnDate(violations, date) {
  const d = date.toDateString();
  return violations.filter((v) => v.date.toDateString() === d);
}

/* ── severity colours ────────────────────────────────────────────────── */

const SEV_COLORS = {
  MSI: { r: 220, g: 53, b: 69 },   // red
  VSI: { r: 253, g: 126, b: 20 },  // orange
  SI:  { r: 255, g: 193, b: 7 },   // amber
  MI:  { r: 108, g: 117, b: 125 }, // blue-gray
};

const SEV_COLORS_HEX = {
  MSI: "FFDC3545",
  VSI: "FFFD7E14",
  SI:  "FFFFC107",
  MI:  "FF6C757D",
};

/* ═══════════════════════════════════════════════════════════════════════
   1.  PDF EXPORT
   ═══════════════════════════════════════════════════════════════════════ */

async function exportPDF(data, violations) {
  const { default: jsPDF } = await import("jspdf");
  await import("jspdf-autotable");
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginL = 14;
  const marginR = 14;
  let y = 16;

  /* ── footer on every page ──────────────────────────────────────────── */
  const addFooter = () => {
    const pages = doc.internal.getNumberOfPages();
    const now = fmtDate(new Date());
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setTextColor(130);
      doc.text(
        `Rapport gegenereerd: ${now} — TachoViewer \u00b7 lokale verwerking`,
        marginL,
        pageH - 8
      );
      doc.text(`Pagina ${i} / ${pages}`, pageW - marginR, pageH - 8, {
        align: "right",
      });
    }
  };

  /* ── header ────────────────────────────────────────────────────────── */
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(33, 37, 41);
  doc.text("TACHOVIEWER \u2014 Activiteitenrapport", marginL, y);
  y += 6;
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text(data.name, marginL, y);
  y += 8;

  /* ── card info ─────────────────────────────────────────────────────── */
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.text("Kaartgegevens", marginL, y);
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.text(`Kaartnummer: ${data.cardNumber}`, marginL, y);
  doc.text(`Uitgevende instantie: ${data.cardIssuer}`, marginL + 80, y);
  doc.text(`Geldig tot: ${fmtDate(data.cardExpiry)}`, marginL + 170, y);
  y += 8;

  /* ── summary stats ─────────────────────────────────────────────────── */
  const totals = { driving: 0, work: 0, rest: 0, available: 0, km: 0 };
  for (const day of data.days) {
    const t = dayTotals(day);
    totals.driving += t.driving;
    totals.work += t.work;
    totals.rest += t.rest;
    totals.available += t.available;
    totals.km += day.dist;
  }
  const drivingDays = data.days.filter(
    (d) => dayTotals(d).driving > 0
  ).length;

  doc.setFont("helvetica", "bold");
  doc.text("Samenvatting", marginL, y);
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.text(`Rijdagen: ${drivingDays}`, marginL, y);
  doc.text(`Totaal km: ${totals.km.toLocaleString("nl-BE")}`, marginL + 40, y);
  doc.text(`Rijden: ${fmtMins(totals.driving)}`, marginL + 90, y);
  doc.text(`Werk: ${fmtMins(totals.work)}`, marginL + 130, y);
  doc.text(`Rust: ${fmtMins(totals.rest)}`, marginL + 165, y);
  doc.text(`Beschikbaar: ${fmtMins(totals.available)}`, marginL + 200, y);
  y += 8;

  /* ── vehicles table ────────────────────────────────────────────────── */
  if (data.vehicles.length) {
    doc.setFont("helvetica", "bold");
    doc.text("Voertuigen", marginL, y);
    y += 2;

    doc.autoTable({
      startY: y,
      margin: { left: marginL, right: marginR },
      head: [["Registratie", "Land", "Km begin", "Km einde", "Eerste gebruik", "Laatste gebruik"]],
      body: data.vehicles.map((v) => [
        v.reg,
        v.nation,
        v.odoBegin?.toLocaleString("nl-BE") ?? "",
        v.odoEnd?.toLocaleString("nl-BE") ?? "",
        v.firstUse ? fmtDate(v.firstUse) : "",
        v.lastUse ? fmtDate(v.lastUse) : "",
      ]),
      styles: { font: "helvetica", fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [41, 128, 185], textColor: 255, fontStyle: "bold" },
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  /* ── daily breakdown table ─────────────────────────────────────────── */
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("Dagelijks overzicht", marginL, y);
  y += 2;

  const dailyBody = data.days.map((day) => {
    const t = dayTotals(day);
    const dayViolations = violationsOnDate(violations, day.date);
    return [
      fmtDate(day.date),
      fmtMins(t.driving),
      fmtMins(t.work),
      fmtMins(t.available),
      fmtMins(t.rest),
      day.dist.toLocaleString("nl-BE"),
      dayViolations.length ? dayViolations.length.toString() : "",
    ];
  });

  doc.autoTable({
    startY: y,
    margin: { left: marginL, right: marginR },
    head: [["Datum", "Rijden", "Werk", "Beschikbaar", "Rust", "km", "Overtredingen"]],
    body: dailyBody,
    styles: { font: "helvetica", fontSize: 8, cellPadding: 1.5 },
    headStyles: { fillColor: [41, 128, 185], textColor: 255, fontStyle: "bold" },
    didParseCell(hookData) {
      // Colour violation cells red
      if (
        hookData.section === "body" &&
        hookData.column.index === 6 &&
        hookData.cell.raw
      ) {
        hookData.cell.styles.textColor = [220, 53, 69];
        hookData.cell.styles.fontStyle = "bold";
      }
    },
  });
  y = doc.lastAutoTable.finalY + 8;

  /* ── activity timeline bars ────────────────────────────────────────── */
  if (y > pageH - 50) { doc.addPage(); y = 16; }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("Activiteitentijdlijn", marginL, y);
  y += 5;

  // Color map for activities (RGB arrays)
  const ACT_COLORS = {
    0: [96, 165, 250],   // rest - blue
    1: [250, 204, 21],   // availability - yellow
    2: [251, 146, 60],   // work - orange
    3: [239, 68, 68],    // driving - red
  };

  // Legend
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  const legendLabels = ["Rust", "Beschikbaar", "Werk", "Rijden"];
  let lx = marginL;
  for (let a = 0; a < 4; a++) {
    doc.setFillColor(...ACT_COLORS[a]);
    doc.rect(lx, y - 2.5, 4, 3, "F");
    doc.text(legendLabels[a], lx + 5, y);
    lx += 25;
  }
  y += 5;

  // Hour ruler
  doc.setFontSize(6);
  doc.setTextColor(130);
  const timelineX = marginL + 22;
  const timelineW = pageW - marginL - marginR - 22;
  for (let h = 0; h <= 24; h += 3) {
    const hx = timelineX + (h / 24) * timelineW;
    doc.text(String(h).padStart(2, "0") + "h", hx, y, { align: "center" });
  }
  y += 3;
  doc.setTextColor(33, 37, 41);

  // Draw bars for each day
  const barH = 2.5;
  const maxBarsPerPage = Math.floor((pageH - y - 20) / (barH + 1));
  let barsDrawn = 0;

  for (const day of data.days) {
    if (barsDrawn >= maxBarsPerPage || y > pageH - 15) {
      doc.addPage();
      y = 16;
      barsDrawn = 0;
      // Re-draw ruler on new page
      doc.setFontSize(6);
      doc.setTextColor(130);
      for (let h = 0; h <= 24; h += 3) {
        const hx = timelineX + (h / 24) * timelineW;
        doc.text(String(h).padStart(2, "0") + "h", hx, y, { align: "center" });
      }
      y += 3;
      doc.setTextColor(33, 37, 41);
    }

    // Date label
    doc.setFontSize(6);
    doc.setFont("helvetica", "normal");
    doc.text(fmtDate(day.date), marginL, y + barH / 2 + 0.5);

    // Background bar
    doc.setFillColor(230, 230, 230);
    doc.rect(timelineX, y, timelineW, barH, "F");

    // Activity segments
    const segs = toSegments(day.activities);
    for (const seg of segs) {
      const x = timelineX + (seg.start / 1440) * timelineW;
      const w = Math.max((seg.dur / 1440) * timelineW, 0.2);
      const c = ACT_COLORS[seg.act] || [200, 200, 200];
      doc.setFillColor(...c);
      doc.rect(x, y, w, barH, "F");
    }

    y += barH + 1;
    barsDrawn++;
  }
  y += 4;

  /* ── violations table ──────────────────────────────────────────────── */
  if (violations.length) {
    // Start a new page if less than 40mm remains
    if (y > pageH - 40) {
      doc.addPage();
      y = 16;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text("Overtredingen", marginL, y);
    y += 2;

    doc.autoTable({
      startY: y,
      margin: { left: marginL, right: marginR },
      head: [["Datum", "Regel", "Beschrijving", "Ernst", "Artikel"]],
      body: violations.map((v) => [
        fmtDate(v.date),
        v.rule,
        v.description,
        v.severity,
        v.article,
      ]),
      styles: { font: "helvetica", fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [41, 128, 185], textColor: 255, fontStyle: "bold" },
      columnStyles: { 2: { cellWidth: 80 } },
      didParseCell(hookData) {
        if (hookData.section === "body" && hookData.column.index === 3) {
          const sev = hookData.cell.raw;
          const c = SEV_COLORS[sev];
          if (c) {
            hookData.cell.styles.textColor = [255, 255, 255];
            hookData.cell.styles.fillColor = [c.r, c.g, c.b];
            hookData.cell.styles.fontStyle = "bold";
          }
        }
      },
    });
  }

  /* ── write footer & save ───────────────────────────────────────────── */
  addFooter();
  doc.save(`tachoviewer_${data.name.replace(/\s+/g, "_")}.pdf`);
}

/* ═══════════════════════════════════════════════════════════════════════
   2.  EXCEL EXPORT
   ═══════════════════════════════════════════════════════════════════════ */

async function exportExcel(data, violations) {
  const ExcelJS = (await import("exceljs")).default;
  const { saveAs } = await import("file-saver");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "TachoViewer";
  workbook.created = new Date();

  /* shared styles */
  const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2980B9" } };
  const headerFont = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
  const thinBorder = {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  };
  const lightRedFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE4EC" } };

  /** Apply header styling to the first row of a sheet. */
  function styleHeader(sheet) {
    const row = sheet.getRow(1);
    row.eachCell((cell) => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.border = thinBorder;
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });
    row.height = 22;
    sheet.views = [{ state: "frozen", ySplit: 1 }];
  }

  /** Auto-fit column widths based on header + data. */
  function autoWidth(sheet) {
    sheet.columns.forEach((col) => {
      let maxLen = 10;
      col.eachCell({ includeEmpty: false }, (cell) => {
        const len = cell.value != null ? String(cell.value).length : 0;
        if (len > maxLen) maxLen = len;
      });
      col.width = Math.min(maxLen + 3, 40);
    });
  }

  /** Apply thin borders to all data cells. */
  function applyBorders(sheet) {
    sheet.eachRow((row, idx) => {
      if (idx === 1) return; // header already styled
      row.eachCell((cell) => {
        cell.border = thinBorder;
      });
    });
  }

  /* ── Sheet 1: Overzicht ────────────────────────────────────────────── */
  const overzicht = workbook.addWorksheet("Overzicht");

  const totals = { driving: 0, work: 0, rest: 0, available: 0, km: 0 };
  for (const day of data.days) {
    const t = dayTotals(day);
    totals.driving += t.driving;
    totals.work += t.work;
    totals.rest += t.rest;
    totals.available += t.available;
    totals.km += day.dist;
  }
  const drivingDays = data.days.filter((d) => dayTotals(d).driving > 0).length;
  const firstDate = data.days.length ? fmtDate(data.days[0].date) : "";
  const lastDate = data.days.length
    ? fmtDate(data.days[data.days.length - 1].date)
    : "";

  const infoRows = [
    ["Bestuurder", data.name],
    ["Kaartnummer", data.cardNumber],
    ["Uitgevende instantie", data.cardIssuer],
    ["Geldig tot", fmtDate(data.cardExpiry)],
    ["Periode", `${firstDate} – ${lastDate}`],
    ["Rijdagen", drivingDays],
    ["Totaal km", totals.km],
    ["Rijden", fmtMins(totals.driving)],
    ["Werk", fmtMins(totals.work)],
    ["Beschikbaar", fmtMins(totals.available)],
    ["Rust", fmtMins(totals.rest)],
    ["Overtredingen", violations.length],
  ];

  overzicht.columns = [{ key: "label", width: 24 }, { key: "value", width: 36 }];
  for (const [label, value] of infoRows) {
    const row = overzicht.addRow({ label, value });
    row.getCell(1).font = { bold: true };
    row.getCell(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFD6EAF8" },
    };
    row.eachCell((cell) => {
      cell.border = thinBorder;
    });
  }

  /* ── Sheet 2: Dagelijks ────────────────────────────────────────────── */
  const dagelijks = workbook.addWorksheet("Dagelijks");
  dagelijks.columns = [
    { header: "Datum", key: "datum", width: 14 },
    { header: "Rijden", key: "rijden", width: 12 },
    { header: "Werk", key: "werk", width: 12 },
    { header: "Beschikbaar", key: "beschikbaar", width: 14 },
    { header: "Rust", key: "rust", width: 12 },
    { header: "Afstand (km)", key: "afstand", width: 14 },
    { header: "Overtredingen", key: "overtredingen", width: 16 },
  ];
  styleHeader(dagelijks);

  const runTotals = { driving: 0, work: 0, rest: 0, available: 0, km: 0, viol: 0 };

  for (const day of data.days) {
    const t = dayTotals(day);
    const dayViolations = violationsOnDate(violations, day.date);
    runTotals.driving += t.driving;
    runTotals.work += t.work;
    runTotals.rest += t.rest;
    runTotals.available += t.available;
    runTotals.km += day.dist;
    runTotals.viol += dayViolations.length;

    const row = dagelijks.addRow({
      datum: fmtDate(day.date),
      rijden: fmtMins(t.driving),
      werk: fmtMins(t.work),
      beschikbaar: fmtMins(t.available),
      rust: fmtMins(t.rest),
      afstand: day.dist,
      overtredingen: dayViolations.length || "",
    });

    if (dayViolations.length) {
      row.eachCell((cell) => {
        cell.fill = lightRedFill;
      });
    }
  }

  // Totals row
  const totRow = dagelijks.addRow({
    datum: "TOTAAL",
    rijden: fmtMins(runTotals.driving),
    werk: fmtMins(runTotals.work),
    beschikbaar: fmtMins(runTotals.available),
    rust: fmtMins(runTotals.rest),
    afstand: runTotals.km,
    overtredingen: runTotals.viol || "",
  });
  totRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.border = thinBorder;
  });

  applyBorders(dagelijks);
  autoWidth(dagelijks);

  /* ── Sheet 3: Overtredingen ────────────────────────────────────────── */
  const overtredingen = workbook.addWorksheet("Overtredingen");
  overtredingen.columns = [
    { header: "Datum", key: "datum", width: 14 },
    { header: "Regel", key: "regel", width: 22 },
    { header: "Beschrijving", key: "beschrijving", width: 50 },
    { header: "Ernst", key: "ernst", width: 10 },
    { header: "Artikel", key: "artikel", width: 18 },
  ];
  styleHeader(overtredingen);

  for (const v of violations) {
    const row = overtredingen.addRow({
      datum: fmtDate(v.date),
      regel: v.rule,
      beschrijving: v.description,
      ernst: v.severity,
      artikel: v.article,
    });

    const sevColor = SEV_COLORS_HEX[v.severity];
    if (sevColor) {
      const cell = row.getCell("ernst");
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: sevColor } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    }
  }

  applyBorders(overtredingen);
  autoWidth(overtredingen);

  /* ── Sheet 4: Voertuigen ───────────────────────────────────────────── */
  const voertuigen = workbook.addWorksheet("Voertuigen");
  voertuigen.columns = [
    { header: "Registratie", key: "reg", width: 16 },
    { header: "Land", key: "land", width: 10 },
    { header: "Km Begin", key: "kmBegin", width: 14 },
    { header: "Km Einde", key: "kmEinde", width: 14 },
    { header: "Eerste gebruik", key: "eerste", width: 16 },
    { header: "Laatste gebruik", key: "laatste", width: 16 },
  ];
  styleHeader(voertuigen);

  for (const v of data.vehicles) {
    voertuigen.addRow({
      reg: v.reg,
      land: v.nation,
      kmBegin: v.odoBegin,
      kmEinde: v.odoEnd,
      eerste: v.firstUse ? fmtDate(v.firstUse) : "",
      laatste: v.lastUse ? fmtDate(v.lastUse) : "",
    });
  }

  applyBorders(voertuigen);
  autoWidth(voertuigen);

  /* ── save ───────────────────────────────────────────────────────────── */
  const buf = await workbook.xlsx.writeBuffer();
  saveAs(new Blob([buf]), `tachoviewer_${data.name.replace(/\s+/g, "_")}.xlsx`);
}

/* ═══════════════════════════════════════════════════════════════════════
   3.  CSV EXPORT
   ═══════════════════════════════════════════════════════════════════════ */

function exportCSV(data, violations) {
  const SEP = ",";
  const rows = [];

  // Header
  rows.push(
    ["Date", "Driving_min", "Work_min", "Available_min", "Rest_min", "Distance_km", "Violation_Count"].join(SEP)
  );

  for (const day of data.days) {
    const t = dayTotals(day);
    const dayViol = violationsOnDate(violations, day.date);
    rows.push(
      [
        fmtDate(day.date),
        t.driving,
        t.work,
        t.available,
        t.rest,
        day.dist,
        dayViol.length,
      ].join(SEP)
    );
  }

  const csvContent = "\uFEFF" + rows.join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `tachoviewer_${data.name.replace(/\s+/g, "_")}.csv`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();

  // Cleanup
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export { exportPDF, exportExcel, exportCSV };
