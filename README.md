# TachoViewer

100% browser-based tachograph (.ddd) file viewer with EU + Belgian compliance checking. No data leaves your device.

**[Live Demo](https://yasuke2000.github.io/tachoviewer/)**

## Features

### DDD File Parser
- 5-byte TLV format (Gen1 + Gen2) with 4-byte fallback
- 12 Elementary Files extracted: Activity, Vehicles, Events, Faults, Places, Identification, Licence, Conditions, Current Usage, Control Activity, ICC, IC
- Circular buffer activity data with cross-day rest span detection
- BCD birth date decoding, codepage-aware text (ISO 8859-1/2/5/7, UTF-8)
- Multi-file upload — analyze multiple driver cards simultaneously

### Compliance Engine (17 rules)

**Regulation (EC) 561/2006:**
- Daily driving 9h / 10h extension (Art. 6(1))
- Weekly driving 56h (Art. 6(2))
- Fortnightly driving 90h (Art. 6(3))
- Continuous driving 4h30m + break validation (Art. 7)
- Split break order enforcement 15min+30min (Art. 7)
- Daily rest 11h / 9h reduced + split 3h+9h pattern (Art. 8(2)(4))
- Weekly rest 45h / 24h reduced + 6-day rule (Art. 8(6))
- Regular weekly rest every 2 consecutive weeks (Art. 8(6))
- Reduced weekly rest compensation tracking (Art. 8(6b))

**Directive 2002/15/EC (Working Time):**
- Weekly working time 60h absolute (Art. 4(a))
- 48h average over 17-week reference period (Art. 4(a))
- Continuous work 6h + break duration 30/45min (Art. 5(1))
- Night work 10h daily limit (Art. 7(1))

**Belgian-specific (KB 17/10/2016):**
- Night work 00:00-07:00 window (Art. 44)
- Night premium detection 20:00-06:00 (PC 140.03)
- 21-day driver card download deadline (Art. 34)
- Graduated fine calculator per KB 8/12/2024

All violations classified MI/SI/VSI/MSI per Regulation 2016/403.

### Export
- **PDF** — jsPDF with auto-tables, color vector timeline bars, severity-colored violations, page footers
- **Excel** — ExcelJS, 4 styled sheets (Overzicht, Dagelijks, Overtredingen, Voertuigen)
- **CSV** — UTF-8 BOM, daily breakdown

### UI
- Modern glassmorphism design with Inter + JetBrains Mono
- 4 tabs: Activiteiten, Overtredingen, Voertuigen, Gebeurtenissen
- 24h color-coded activity timeline with tooltips
- Driver selector for multi-file analysis
- Industry colors: red (driving), orange (work), yellow (availability), blue (rest)
- Belgian fine estimates per violation
- Privacy policy + terms of service (Dutch)

## Tech Stack

- React 19 + Vite 7
- jsPDF + jspdf-autotable (lazy-loaded)
- ExcelJS + file-saver (lazy-loaded)
- Zero backend — static site on GitHub Pages
- Main bundle: ~256KB, exports load on demand

## Privacy

TachoViewer processes files entirely in the browser. No data is sent to any server, stored in cookies, or saved to local storage. When you close the tab, everything is gone. This is Privacy by Design per GDPR Article 25.

## Regulations Referenced

| Regulation | Scope |
|-----------|-------|
| Reg (EC) 561/2006 | Driving/rest times |
| Dir 2002/15/EC | Working time (WTD) |
| Reg (EU) 165/2014 | Tachograph regulation |
| Reg (EU) 2016/403 | Infringement severity classification |
| KB 17/10/2016 (BE) | Belgian tachograph decree |
| KB 8/12/2024 (BE) | Belgian fine catalogue |
| KB 10/08/2005 (BE) | Employed mobile workers |
| PC 140.03 (BE) | Road transport sectoral agreement |

## Development

```bash
npm install
npm run dev      # development server
npm run build    # production build
```

## License

Open source. See repository for details.
