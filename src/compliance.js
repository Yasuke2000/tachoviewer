/**
 * Compliance checking engine for EU tachograph regulations.
 *
 * Checks driving/working time rules from:
 *   - EU Regulation (EC) No 561/2006
 *   - Working Time Directive 2002/15/EC
 *
 * Activity codes: 0 = rest, 1 = availability, 2 = work, 3 = driving
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert activity change records into continuous time segments. */
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

/** Format a duration in minutes as "Xh XXm". */
function fmtMins(m) {
  const h = Math.floor(m / 60);
  const mins = Math.round(m % 60);
  return `${h}h ${String(mins).padStart(2, "0")}m`;
}

/** Return the ISO week number for a Date. */
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/** Return the Monday 00:00 of the ISO week containing `date`. */
function weekStart(date) {
  const d = new Date(date);
  const day = d.getDay() || 7; // Sunday = 7
  d.setDate(d.getDate() - (day - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Get the total minutes of a specific activity on a day's segments. */
function actMinutes(segments, act) {
  return segments.reduce((sum, s) => (s.act === act ? sum + s.dur : sum), 0);
}

/** Get total minutes of multiple activity types combined. */
function multiActMinutes(segments, acts) {
  return segments.reduce((sum, s) => (acts.includes(s.act) ? sum + s.dur : sum), 0);
}

/**
 * Group days by ISO calendar week.
 * Returns a Map<string, day[]> keyed by "YYYY-WNN".
 */
function groupByWeek(days) {
  const weeks = new Map();
  for (const day of days) {
    const ws = weekStart(day.date);
    const key = `${ws.getFullYear()}-W${String(getISOWeek(ws)).padStart(2, "0")}`;
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(day);
  }
  return weeks;
}

// ---------------------------------------------------------------------------
// Rule checks
// ---------------------------------------------------------------------------

/**
 * Rule 1 — Daily driving limit (Art. 6(1))
 * Max 9h/day, extendable to 10h at most 2x per calendar week.
 */
function checkDailyDriving(days, violations) {
  const weeks = groupByWeek(days);

  for (const [, weekDays] of weeks) {
    // Sort by date so we process chronologically within the week
    const sorted = [...weekDays].sort((a, b) => a.date - b.date);

    // First pass: identify which days exceed 9h and how many extensions used
    let extensionsUsed = 0;
    const dayDrivingMins = sorted.map((day) => {
      const segs = toSegments(day.activities || []);
      return { day, driving: actMinutes(segs, 3) };
    });

    // Count days between 9h and 10h — first 2 are allowed extensions
    const extendedDays = dayDrivingMins.filter(
      (d) => d.driving > 9 * 60 && d.driving <= 10 * 60
    );

    for (const { day, driving } of dayDrivingMins) {
      const drivingH = driving / 60;

      if (driving > 11 * 60) {
        violations.push({
          date: day.date,
          rule: "Daily driving limit",
          description: `Drove ${fmtMins(driving)} in one day (max 9h, or 10h with extension). Exceeds 11h.`,
          actual: fmtMins(driving),
          limit: "9h 00m / 10h 00m",
          severity: "VSI",
          article: "Art. 6(1) Reg 561/2006",
        });
      } else if (driving > 10 * 60) {
        violations.push({
          date: day.date,
          rule: "Daily driving limit",
          description: `Drove ${fmtMins(driving)} in one day (max 10h even with extension).`,
          actual: fmtMins(driving),
          limit: "10h 00m",
          severity: "SI",
          article: "Art. 6(1) Reg 561/2006",
        });
      } else if (driving > 9 * 60) {
        // Between 9h and 10h — only a violation if more than 2 extensions this week
        const idx = extendedDays.findIndex((e) => e.day === day);
        if (idx >= 2) {
          // This is the 3rd+ extension in the week
          violations.push({
            date: day.date,
            rule: "Daily driving limit",
            description: `Drove ${fmtMins(driving)} (used >2 daily extensions this week).`,
            actual: fmtMins(driving),
            limit: "9h 00m (extensions exhausted)",
            severity: "MI",
            article: "Art. 6(1) Reg 561/2006",
          });
        }
      }
    }
  }
}

/**
 * Rule 2 — Weekly driving (Art. 6(2))
 * Max 56h per calendar week (Mon 00:00 – Sun 24:00).
 */
function checkWeeklyDriving(days, violations) {
  const weeks = groupByWeek(days);

  for (const [weekKey, weekDays] of weeks) {
    const totalDriving = weekDays.reduce((sum, day) => {
      const segs = toSegments(day.activities || []);
      return sum + actMinutes(segs, 3);
    }, 0);

    const totalH = totalDriving / 60;
    const firstDate = [...weekDays].sort((a, b) => a.date - b.date)[0].date;

    if (totalH >= 70) {
      violations.push({
        date: firstDate,
        rule: "Weekly driving limit",
        description: `Total weekly driving ${fmtMins(totalDriving)} (week ${weekKey}). Exceeds 70h.`,
        actual: fmtMins(totalDriving),
        limit: "56h 00m",
        severity: "MSI",
        article: "Art. 6(2) Reg 561/2006",
      });
    } else if (totalH >= 65) {
      violations.push({
        date: firstDate,
        rule: "Weekly driving limit",
        description: `Total weekly driving ${fmtMins(totalDriving)} (week ${weekKey}). Exceeds 65h.`,
        actual: fmtMins(totalDriving),
        limit: "56h 00m",
        severity: "VSI",
        article: "Art. 6(2) Reg 561/2006",
      });
    } else if (totalH >= 60) {
      violations.push({
        date: firstDate,
        rule: "Weekly driving limit",
        description: `Total weekly driving ${fmtMins(totalDriving)} (week ${weekKey}). Exceeds 60h.`,
        actual: fmtMins(totalDriving),
        limit: "56h 00m",
        severity: "SI",
        article: "Art. 6(2) Reg 561/2006",
      });
    } else if (totalH > 56) {
      violations.push({
        date: firstDate,
        rule: "Weekly driving limit",
        description: `Total weekly driving ${fmtMins(totalDriving)} (week ${weekKey}). Exceeds 56h.`,
        actual: fmtMins(totalDriving),
        limit: "56h 00m",
        severity: "MI",
        article: "Art. 6(2) Reg 561/2006",
      });
    }
  }
}

/**
 * Rule 3 — Fortnightly driving (Art. 6(3))
 * Max 90h per any 2 consecutive calendar weeks.
 */
function checkFortnightlyDriving(days, violations) {
  const weeks = groupByWeek(days);
  const weekKeys = [...weeks.keys()].sort();

  for (let i = 0; i < weekKeys.length - 1; i++) {
    const week1Days = weeks.get(weekKeys[i]);
    const week2Days = weeks.get(weekKeys[i + 1]);

    const driving1 = week1Days.reduce((sum, day) => {
      const segs = toSegments(day.activities || []);
      return sum + actMinutes(segs, 3);
    }, 0);

    const driving2 = week2Days.reduce((sum, day) => {
      const segs = toSegments(day.activities || []);
      return sum + actMinutes(segs, 3);
    }, 0);

    const totalDriving = driving1 + driving2;
    const totalH = totalDriving / 60;
    const firstDate = [...week1Days].sort((a, b) => a.date - b.date)[0].date;

    if (totalH >= 112.5) {
      violations.push({
        date: firstDate,
        rule: "Fortnightly driving limit",
        description: `Combined driving for weeks ${weekKeys[i]} & ${weekKeys[i + 1]}: ${fmtMins(totalDriving)}. Exceeds 112h 30m.`,
        actual: fmtMins(totalDriving),
        limit: "90h 00m",
        severity: "MSI",
        article: "Art. 6(3) Reg 561/2006",
      });
    } else if (totalH >= 105) {
      violations.push({
        date: firstDate,
        rule: "Fortnightly driving limit",
        description: `Combined driving for weeks ${weekKeys[i]} & ${weekKeys[i + 1]}: ${fmtMins(totalDriving)}. Exceeds 105h.`,
        actual: fmtMins(totalDriving),
        limit: "90h 00m",
        severity: "VSI",
        article: "Art. 6(3) Reg 561/2006",
      });
    } else if (totalH >= 100) {
      violations.push({
        date: firstDate,
        rule: "Fortnightly driving limit",
        description: `Combined driving for weeks ${weekKeys[i]} & ${weekKeys[i + 1]}: ${fmtMins(totalDriving)}. Exceeds 100h.`,
        actual: fmtMins(totalDriving),
        limit: "90h 00m",
        severity: "SI",
        article: "Art. 6(3) Reg 561/2006",
      });
    } else if (totalH > 90) {
      violations.push({
        date: firstDate,
        rule: "Fortnightly driving limit",
        description: `Combined driving for weeks ${weekKeys[i]} & ${weekKeys[i + 1]}: ${fmtMins(totalDriving)}. Exceeds 90h.`,
        actual: fmtMins(totalDriving),
        limit: "90h 00m",
        severity: "MI",
        article: "Art. 6(3) Reg 561/2006",
      });
    }
  }
}

/**
 * Rule 4 — Continuous driving / break requirement (Art. 7)
 * Max 4h30m continuous driving before a 45min break.
 * Breaks of >= 15min count toward resetting the accumulated driving time.
 */
function checkContinuousDriving(days, violations) {
  for (const day of days) {
    const segs = toSegments(day.activities || []);
    if (!segs.length) continue;

    let accumulatedDriving = 0; // minutes of driving since last valid break
    let accumulatedBreak = 0; // minutes of break accumulated toward the 45min target
    let longestUnbrokenStretch = 0;

    for (const seg of segs) {
      if (seg.act === 3) {
        // Driving
        accumulatedBreak = 0; // any non-break resets break accumulation
        accumulatedDriving += seg.dur;
        longestUnbrokenStretch = Math.max(longestUnbrokenStretch, accumulatedDriving);
      } else if (seg.act === 0 || seg.act === 1) {
        // Rest or availability — counts as break if >= 15min
        if (seg.dur >= 15) {
          accumulatedBreak += seg.dur;
          if (accumulatedBreak >= 45) {
            // Full break taken — reset driving accumulation
            accumulatedDriving = 0;
            accumulatedBreak = 0;
          }
        } else {
          // Break too short to count — does NOT reset, treat as interruption
          // but driving counter is not increased either
          accumulatedBreak = 0;
        }
      } else {
        // Work (act 2) — does not count as break, does not count as driving
        accumulatedBreak = 0;
      }
    }

    const limit = 4 * 60 + 30; // 270 min

    if (longestUnbrokenStretch > limit) {
      let severity;
      if (longestUnbrokenStretch >= 6 * 60) {
        severity = "VSI";
      } else if (longestUnbrokenStretch >= 5 * 60) {
        severity = "SI";
      } else {
        severity = "MI";
      }

      violations.push({
        date: day.date,
        rule: "Continuous driving without break",
        description: `Drove ${fmtMins(longestUnbrokenStretch)} without a sufficient break (45min required after 4h 30m).`,
        actual: fmtMins(longestUnbrokenStretch),
        limit: "4h 30m",
        severity,
        article: "Art. 7 Reg 561/2006",
      });
    }
  }
}

/**
 * Compute the effective longest rest for each day, accounting for cross-day
 * rest spans and gaps in card data (card removed = driver resting).
 *
 * When the card is not in the tachograph (overnight, weekends), no activity
 * is recorded. The gap between the end of one day's last activity and the
 * start of the next day's first activity is counted as rest.
 */
function computeEffectiveRest(sortedDays) {
  const result = new Map(); // dateKey -> { longestRest, restSegs (including cross-day) }

  for (let idx = 0; idx < sortedDays.length; idx++) {
    const day = sortedDays[idx];
    const segs = toSegments(day.activities || []);
    const dateKey = day.date.toDateString();

    // Longest rest within this day's segments
    let longestInDay = 0;
    for (const seg of segs) {
      if (seg.act === 0 && seg.dur > longestInDay) longestInDay = seg.dur;
    }

    // Trailing rest: rest at end of this day (from last non-rest to midnight)
    let trailing = 0;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].act === 0) trailing += segs[i].dur;
      else break;
    }

    // Leading rest: rest at start of this day (from midnight to first non-rest)
    let leading = 0;
    for (const seg of segs) {
      if (seg.act === 0) leading += seg.dur;
      else break;
    }

    // Cross-day rest with PREVIOUS day:
    // = previous day's trailing rest + gap (missing days) + this day's leading rest
    let crossRestBefore = leading; // at minimum, leading rest of today
    if (idx > 0) {
      const prevDay = sortedDays[idx - 1];
      const prevSegs = toSegments(prevDay.activities || []);
      let prevTrailing = 0;
      for (let i = prevSegs.length - 1; i >= 0; i--) {
        if (prevSegs[i].act === 0) prevTrailing += prevSegs[i].dur;
        else break;
      }
      // Gap between prev day and this day (missing calendar days = card out = rest)
      const dayGap = Math.round((day.date.getTime() - prevDay.date.getTime()) / 86400000);
      const gapMinutes = Math.max(0, (dayGap - 1)) * 1440; // each missing day = 1440 min rest
      crossRestBefore = prevTrailing + gapMinutes + leading;
    }

    // Cross-day rest with NEXT day:
    // = this day's trailing rest + gap + next day's leading rest
    let crossRestAfter = trailing;
    if (idx < sortedDays.length - 1) {
      const nextDay = sortedDays[idx + 1];
      const nextSegs = toSegments(nextDay.activities || []);
      let nextLeading = 0;
      for (const seg of nextSegs) {
        if (seg.act === 0) nextLeading += seg.dur;
        else break;
      }
      const dayGap = Math.round((nextDay.date.getTime() - day.date.getTime()) / 86400000);
      const gapMinutes = Math.max(0, (dayGap - 1)) * 1440;
      crossRestAfter = trailing + gapMinutes + nextLeading;
    }

    const effectiveRest = Math.max(longestInDay, crossRestBefore, crossRestAfter);

    // Collect all rest segments including cross-day for split rest check
    const allRestSegs = segs.filter(s => s.act === 0).map(s => s.dur);
    if (crossRestBefore > leading) allRestSegs.unshift(crossRestBefore);
    if (crossRestAfter > trailing) allRestSegs.push(crossRestAfter);

    result.set(dateKey, { longestRest: effectiveRest, restDurations: allRestSegs });
  }
  return result;
}

/**
 * Rule 5 — Insufficient daily rest (Art. 8)
 * Regular daily rest: >= 11h within a 24h period.
 * Reduced daily rest: >= 9h (max 3x between weekly rests).
 *
 * Accounts for cross-day rest spans and card-out gaps.
 */
function checkDailyRest(days, violations) {
  let reducedRestCount = 0;
  const sorted = [...days].sort((a, b) => a.date - b.date);
  const effectiveRestMap = computeEffectiveRest(sorted);

  for (const day of sorted) {
    const dateKey = day.date.toDateString();
    const info = effectiveRestMap.get(dateKey);
    if (!info) continue;

    const longestRest = info.longestRest;

    if (longestRest >= 11 * 60) {
      continue; // Compliant — regular daily rest
    }

    // Rule 9 — Split daily rest (3h + 9h = 12h)
    const restDurs = info.restDurations;
    let splitRestCompliant = false;
    for (let i = 0; i < restDurs.length; i++) {
      if (restDurs[i] >= 3 * 60) {
        for (let j = i + 1; j < restDurs.length; j++) {
          if (restDurs[j] >= 9 * 60 && restDurs[i] + restDurs[j] >= 12 * 60) {
            splitRestCompliant = true;
            break;
          }
        }
      }
      if (splitRestCompliant) break;
    }
    if (splitRestCompliant) continue;

    if (longestRest >= 9 * 60) {
      reducedRestCount++;
      if (reducedRestCount > 3) {
        violations.push({
          date: day.date,
          rule: "Insufficient daily rest (excess reduced rests)",
          description: `Reduced daily rest of ${fmtMins(longestRest)} (${reducedRestCount}th reduced rest, max 3 allowed between weekly rests).`,
          actual: fmtMins(longestRest),
          limit: "11h 00m (regular) / max 3 reduced",
          severity: "MI",
          article: "Art. 8(4) Reg 561/2006",
        });
      }
      continue;
    }

    // Less than 9h
    let severity, requiredLabel;
    if (reducedRestCount < 3) {
      if (longestRest >= 8 * 60) severity = "MI";
      else if (longestRest >= 7 * 60) severity = "SI";
      else severity = "VSI";
      requiredLabel = "9h 00m (reduced)";
      reducedRestCount++;
    } else {
      if (longestRest >= 10 * 60) severity = "MI";
      else if (longestRest >= 8 * 60 + 30) severity = "SI";
      else severity = "VSI";
      requiredLabel = "11h 00m (regular)";
    }

    violations.push({
      date: day.date,
      rule: "Insufficient daily rest",
      description: `Longest continuous rest was ${fmtMins(longestRest)}, required at least ${requiredLabel}.`,
      actual: fmtMins(longestRest),
      limit: requiredLabel,
      severity,
      article: "Art. 8 Reg 561/2006",
    });
  }
}

/**
 * Rule 6 — Weekly working time WTD (Art. 4(a) Directive 2002/15/EC)
 * Max 60h working time (driving + work, NOT availability) per calendar week.
 */
function checkWeeklyWorkingTime(days, violations) {
  const weeks = groupByWeek(days);

  for (const [weekKey, weekDays] of weeks) {
    const totalWork = weekDays.reduce((sum, day) => {
      const segs = toSegments(day.activities || []);
      return sum + multiActMinutes(segs, [2, 3]); // work + driving
    }, 0);

    const totalH = totalWork / 60;
    const firstDate = [...weekDays].sort((a, b) => a.date - b.date)[0].date;

    if (totalH > 65) {
      violations.push({
        date: firstDate,
        rule: "Weekly working time (WTD)",
        description: `Total working time ${fmtMins(totalWork)} in week ${weekKey}. Exceeds 65h.`,
        actual: fmtMins(totalWork),
        limit: "60h 00m",
        severity: "VSI",
        article: "Art. 4(a) Dir 2002/15/EC",
      });
    } else if (totalH > 60) {
      violations.push({
        date: firstDate,
        rule: "Weekly working time (WTD)",
        description: `Total working time ${fmtMins(totalWork)} in week ${weekKey}. Exceeds 60h.`,
        actual: fmtMins(totalWork),
        limit: "60h 00m",
        severity: "SI",
        article: "Art. 4(a) Dir 2002/15/EC",
      });
    }
  }
}

/**
 * Rule 7 — Continuous work without break WTD (Art. 5 Directive 2002/15/EC)
 * Max 6h consecutive work (driving + other work) without a break of >= 15min.
 */
function checkContinuousWork(days, violations) {
  for (const day of days) {
    const segs = toSegments(day.activities || []);
    if (!segs.length) continue;

    let accumulatedWork = 0;
    let longestWorkStretch = 0;

    for (const seg of segs) {
      if (seg.act === 2 || seg.act === 3) {
        // Work or driving
        accumulatedWork += seg.dur;
        longestWorkStretch = Math.max(longestWorkStretch, accumulatedWork);
      } else if (seg.dur >= 15) {
        // Sufficient break (rest or availability >= 15min)
        accumulatedWork = 0;
      }
      // Breaks < 15min do not reset the work counter
    }

    const limit = 6 * 60; // 360 min

    if (longestWorkStretch > limit) {
      let severity;
      if (longestWorkStretch > 8 * 60) {
        severity = "VSI";
      } else if (longestWorkStretch > 7 * 60) {
        severity = "SI";
      } else {
        severity = "MI";
      }

      violations.push({
        date: day.date,
        rule: "Continuous work without break (WTD)",
        description: `Worked ${fmtMins(longestWorkStretch)} without a break of at least 15 minutes.`,
        actual: fmtMins(longestWorkStretch),
        limit: "6h 00m",
        severity,
        article: "Art. 5 Dir 2002/15/EC",
      });
    }
  }
}

/**
 * Rule 8 — Weekly rest (Art. 8(6) Reg 561/2006)
 *
 * Regular weekly rest: >= 45 consecutive hours. Reduced: >= 24 consecutive hours.
 * Weekly rest must start no later than end of 6x24h periods from previous weekly rest.
 * At least one regular (>= 45h) weekly rest every 2 consecutive weeks.
 *
 * v1 simplification: per calendar week, find the longest rest period (including
 * cross-day spans) and check it meets 24h minimum.
 */
function checkWeeklyRest(days, violations) {
  const weeks = groupByWeek(days);
  const sorted = [...days].sort((a, b) => a.date - b.date);

  // --- Build cross-day continuous rest spans for the entire dataset ---
  // For each day, compute trailing rest (rest at end of day) and leading rest
  // (rest at start of day).  Adjacent days contribute to a continuous rest span.
  function dayRestInfo(day) {
    const segs = toSegments(day.activities || []);
    if (!segs.length) return { leading: 1440, trailing: 1440, longestInner: 1440 };

    // Leading rest: consecutive rest segments from start of day
    let leading = 0;
    for (const seg of segs) {
      if (seg.act === 0) {
        leading += seg.dur;
      } else {
        break;
      }
    }

    // Trailing rest: consecutive rest segments at end of day
    let trailing = 0;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].act === 0) {
        trailing += segs[i].dur;
      } else {
        break;
      }
    }

    // Longest inner rest (single segment)
    let longestInner = 0;
    for (const seg of segs) {
      if (seg.act === 0 && seg.dur > longestInner) {
        longestInner = seg.dur;
      }
    }

    return { leading, trailing, longestInner };
  }

  // Compute rest info per day
  const restInfoByDate = new Map();
  for (const day of sorted) {
    restInfoByDate.set(day.date.getTime(), dayRestInfo(day));
  }

  // For a set of days (sorted), find the longest continuous rest span,
  // including spans that cross day boundaries.
  function longestContinuousRest(weekDays) {
    const wSorted = [...weekDays].sort((a, b) => a.date - b.date);
    let longest = 0;

    for (const day of wSorted) {
      const info = restInfoByDate.get(day.date.getTime());
      if (info) longest = Math.max(longest, info.longestInner);
    }

    // Check cross-day spans: trailing rest of day N + gap (missing days = rest) + leading rest of next day
    for (let i = 0; i < wSorted.length - 1; i++) {
      const info = restInfoByDate.get(wSorted[i].date.getTime());
      if (!info) continue;
      let span = info.trailing;

      // Walk forward across days (including gaps for missing days = card out = rest)
      for (let j = i + 1; j < wSorted.length; j++) {
        const prevDate = wSorted[j - 1].date;
        const curDate = wSorted[j].date;
        const diffDays = Math.round((curDate.getTime() - prevDate.getTime()) / 86400000);

        // Add rest for any missing calendar days (card removed = rest)
        if (diffDays > 1) {
          span += (diffDays - 1) * 1440;
        }

        const jInfo = restInfoByDate.get(curDate.getTime());
        if (!jInfo) break;

        if (jInfo.leading === 1440) {
          // Entire day is rest — add full day and keep going
          span += 1440;
        } else {
          // Partial day — add leading rest and stop
          span += jInfo.leading;
          break;
        }
      }

      longest = Math.max(longest, span);
    }

    // Also check: if the first day has leading rest + gap before it (within the week)
    // and the last day has trailing rest + gap after it
    if (wSorted.length > 0) {
      const firstInfo = restInfoByDate.get(wSorted[0].date.getTime());
      if (firstInfo) longest = Math.max(longest, firstInfo.leading);
      const lastInfo = restInfoByDate.get(wSorted[wSorted.length - 1].date.getTime());
      if (lastInfo) longest = Math.max(longest, lastInfo.trailing);
    }

    return longest;
  }

  // --- Per-week check: longest rest must be >= 24h (reduced weekly rest minimum) ---
  const weekKeys = [...weeks.keys()].sort();
  const weekLongestRest = new Map();

  for (const weekKey of weekKeys) {
    const weekDays = weeks.get(weekKey);
    const longest = longestContinuousRest(weekDays);
    weekLongestRest.set(weekKey, longest);
    const longestH = longest / 60;
    const firstDate = [...weekDays].sort((a, b) => a.date - b.date)[0].date;

    if (longestH < 24) {
      violations.push({
        date: firstDate,
        rule: "Insufficient weekly rest",
        description: `Longest continuous rest in week ${weekKey} was ${fmtMins(longest)}, required at least 24h (reduced weekly rest).`,
        actual: fmtMins(longest),
        limit: "24h 00m (reduced) / 45h 00m (regular)",
        severity: "VSI",
        article: "Art. 8(6) Reg 561/2006",
      });
    }
  }

  // --- Check: at least one regular (>= 45h) rest every 2 consecutive weeks ---
  for (let i = 0; i < weekKeys.length - 1; i++) {
    const rest1 = weekLongestRest.get(weekKeys[i]) || 0;
    const rest2 = weekLongestRest.get(weekKeys[i + 1]) || 0;

    if (rest1 < 45 * 60 && rest2 < 45 * 60) {
      const firstDate = [...weeks.get(weekKeys[i])].sort((a, b) => a.date - b.date)[0].date;
      // Both weeks only have reduced rests — violation
      const bestRest = Math.max(rest1, rest2);
      let severity;
      if (bestRest >= 42 * 60) {
        severity = "MI";
      } else if (bestRest >= 36 * 60) {
        severity = "SI";
      } else {
        severity = "VSI";
      }

      violations.push({
        date: firstDate,
        rule: "No regular weekly rest in 2 consecutive weeks",
        description: `Neither week ${weekKeys[i]} nor ${weekKeys[i + 1]} had a regular weekly rest (>= 45h). Best was ${fmtMins(bestRest)}.`,
        actual: fmtMins(bestRest),
        limit: "45h 00m (at least once per 2 weeks)",
        severity,
        article: "Art. 8(6) Reg 561/2006",
      });
    }
  }

  // --- 6-day rule: track days since last rest >= 24h ---
  let daysSinceLastWeeklyRest = 0;
  let lastWeeklyRestDate = null;

  for (const day of sorted) {
    const info = restInfoByDate.get(day.date.getTime());
    // Check if this day participates in a cross-day rest >= 24h
    // Simplified: check if longestInner >= 24h or if trailing+next leading >= 24h
    let hasQualifyingRest = false;
    if (info && info.longestInner >= 24 * 60) {
      hasQualifyingRest = true;
    }
    // Check cross-day: trailing of this day + leading of next day
    if (!hasQualifyingRest && info) {
      const nextDayTime = day.date.getTime() + 86400000;
      const nextInfo = restInfoByDate.get(nextDayTime);
      if (nextInfo && info.trailing + nextInfo.leading >= 24 * 60) {
        hasQualifyingRest = true;
      }
      // Also check previous day trailing + this day leading
      const prevDayTime = day.date.getTime() - 86400000;
      const prevInfo = restInfoByDate.get(prevDayTime);
      if (prevInfo && prevInfo.trailing + info.leading >= 24 * 60) {
        hasQualifyingRest = true;
      }
    }

    if (hasQualifyingRest) {
      daysSinceLastWeeklyRest = 0;
      lastWeeklyRestDate = day.date;
    } else {
      daysSinceLastWeeklyRest++;
    }

    if (daysSinceLastWeeklyRest > 6) {
      const overageH = (daysSinceLastWeeklyRest - 6) * 24; // approximate hours over
      let severity;
      if (overageH < 3) {
        severity = "MI";
      } else if (overageH < 12) {
        severity = "SI";
      } else {
        severity = "VSI";
      }

      violations.push({
        date: day.date,
        rule: "6-day rule (weekly rest overdue)",
        description: `${daysSinceLastWeeklyRest} days since last qualifying weekly rest (>= 24h). Maximum is 6 days.`,
        actual: `${daysSinceLastWeeklyRest} days`,
        limit: "6 days",
        severity,
        article: "Art. 8(6) Reg 561/2006",
      });
    }
  }
}

/**
 * Rule 10 — WTD night work (Art. 7(1) Dir 2002/15/EC)
 *
 * If any work is performed during the night period (00:00–05:00 by default),
 * total working time (driving + work) in that calendar day must not exceed 10h.
 */
function checkNightWork(days, violations) {
  const NIGHT_START = 0; // minutes from midnight
  const NIGHT_END = 5 * 60; // 05:00 = 300 minutes

  for (const day of days) {
    const segs = toSegments(day.activities || []);
    if (!segs.length) continue;

    // Check if any work (act 2 or 3) overlaps with the night period
    let hasNightWork = false;
    for (const seg of segs) {
      if ((seg.act === 2 || seg.act === 3) && seg.start < NIGHT_END && seg.end > NIGHT_START) {
        hasNightWork = true;
        break;
      }
    }

    if (!hasNightWork) continue;

    // Total working time for the day (driving + work)
    const totalWork = multiActMinutes(segs, [2, 3]);
    const totalH = totalWork / 60;

    if (totalH > 13) {
      violations.push({
        date: day.date,
        rule: "Night work daily limit (WTD)",
        description: `Night worker: total working time ${fmtMins(totalWork)} exceeds 13h (limit 10h for night workers).`,
        actual: fmtMins(totalWork),
        limit: "10h 00m",
        severity: "VSI",
        article: "Art. 7(1) Dir 2002/15/EC",
      });
    } else if (totalH > 11) {
      violations.push({
        date: day.date,
        rule: "Night work daily limit (WTD)",
        description: `Night worker: total working time ${fmtMins(totalWork)} exceeds 11h (limit 10h for night workers).`,
        actual: fmtMins(totalWork),
        limit: "10h 00m",
        severity: "SI",
        article: "Art. 7(1) Dir 2002/15/EC",
      });
    } else if (totalH > 10) {
      violations.push({
        date: day.date,
        rule: "Night work daily limit (WTD)",
        description: `Night worker: total working time ${fmtMins(totalWork)} exceeds 10h (limit 10h for night workers).`,
        actual: fmtMins(totalWork),
        limit: "10h 00m",
        severity: "MI",
        article: "Art. 7(1) Dir 2002/15/EC",
      });
    }
  }
}

/**
 * Rule 11 — WTD 48h average (Art. 4(a) Dir 2002/15/EC)
 *
 * Average weekly working time must not exceed 48h over a 17-week reference
 * period (approximation of 4 months). Check rolling 17-week windows.
 */
function checkWTD48hAverage(days, violations) {
  const weeks = groupByWeek(days);
  const weekKeys = [...weeks.keys()].sort();

  if (weekKeys.length === 0) return;

  // Compute total working time (driving + work) per week
  const weeklyWork = new Map();
  for (const [weekKey, weekDays] of weeks) {
    const totalWork = weekDays.reduce((sum, day) => {
      const segs = toSegments(day.activities || []);
      return sum + multiActMinutes(segs, [2, 3]);
    }, 0);
    weeklyWork.set(weekKey, totalWork);
  }

  const REFERENCE_WEEKS = 17;

  // Rolling 17-week window
  for (let i = 0; i <= weekKeys.length - REFERENCE_WEEKS; i++) {
    let totalMins = 0;
    for (let j = i; j < i + REFERENCE_WEEKS; j++) {
      totalMins += weeklyWork.get(weekKeys[j]) || 0;
    }

    const avgPerWeek = totalMins / REFERENCE_WEEKS;
    const avgH = avgPerWeek / 60;

    if (avgH > 48) {
      const periodStart = weekKeys[i];
      const periodEnd = weekKeys[i + REFERENCE_WEEKS - 1];
      const firstDate = [...weeks.get(weekKeys[i])].sort((a, b) => a.date - b.date)[0].date;

      violations.push({
        date: firstDate,
        rule: "48h average weekly working time (WTD)",
        description: `Average weekly working time over ${periodStart} to ${periodEnd} (17 weeks) is ${fmtMins(Math.round(avgPerWeek))} (limit 48h).`,
        actual: fmtMins(Math.round(avgPerWeek)),
        limit: "48h 00m average",
        severity: "MI",
        article: "Art. 4(a) Dir 2002/15/EC",
      });
    }
  }

  // If fewer than 17 weeks of data, check the available period as a single window
  if (weekKeys.length > 0 && weekKeys.length < REFERENCE_WEEKS) {
    let totalMins = 0;
    for (const key of weekKeys) {
      totalMins += weeklyWork.get(key) || 0;
    }

    const avgPerWeek = totalMins / weekKeys.length;
    const avgH = avgPerWeek / 60;

    if (avgH > 48) {
      const firstDate = [...weeks.get(weekKeys[0])].sort((a, b) => a.date - b.date)[0].date;

      violations.push({
        date: firstDate,
        rule: "48h average weekly working time (WTD)",
        description: `Average weekly working time over ${weekKeys.length} available weeks (${weekKeys[0]} to ${weekKeys[weekKeys.length - 1]}) is ${fmtMins(Math.round(avgPerWeek))} (limit 48h).`,
        actual: fmtMins(Math.round(avgPerWeek)),
        limit: "48h 00m average",
        severity: "MI",
        article: "Art. 4(a) Dir 2002/15/EC",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 12 — Split break order (Art. 7 Reg 561/2006)
// When using a split break (instead of a single 45min break), the 15min
// portion must come BEFORE the 30min portion.
// ---------------------------------------------------------------------------

function checkSplitBreakOrder(days, violations) {
  for (const day of days) {
    const segs = toSegments(day.activities || []);
    if (!segs.length) continue;

    // Walk through segments accumulating driving. When accumulated driving
    // exceeds 4h30m, inspect the break segments that preceded the excess to
    // determine if a split break was attempted and, if so, whether the order
    // was correct.
    let accumulatedDriving = 0;
    const breakSegsSinceReset = []; // break segs >= 15min in current driving period
    let totalBreakSinceReset = 0;

    for (const seg of segs) {
      if (seg.act === 3) {
        accumulatedDriving += seg.dur;
      } else if ((seg.act === 0 || seg.act === 1) && seg.dur >= 15) {
        breakSegsSinceReset.push({ dur: seg.dur, start: seg.start });
        totalBreakSinceReset += seg.dur;
        if (totalBreakSinceReset >= 45) {
          // Break period complete — reset
          accumulatedDriving = 0;
          breakSegsSinceReset.length = 0;
          totalBreakSinceReset = 0;
        }
      } else if (seg.act === 2) {
        // Work — not a break, but not driving either; reset break accumulation
        // but do NOT reset driving (per existing continuous driving logic the
        // break accumulation resets on non-break).
        breakSegsSinceReset.length = 0;
        totalBreakSinceReset = 0;
      }

      // Check if driving exceeded 4h30 with a split break attempt
      if (accumulatedDriving > 4 * 60 + 30 && breakSegsSinceReset.length >= 2) {
        // There were break segments but they didn't total 45min (otherwise we
        // would have reset). Check if there was a 30-before-15 pattern.
        const has15 = breakSegsSinceReset.some((b) => b.dur >= 15 && b.dur < 30);
        const has30 = breakSegsSinceReset.some((b) => b.dur >= 30);

        if (has15 && has30) {
          const first30 = breakSegsSinceReset.find((b) => b.dur >= 30);
          const first15 = breakSegsSinceReset.find((b) => b.dur >= 15 && b.dur < 30);
          if (first30 && first15 && first30.start < first15.start) {
            // 30min came before 15min — wrong order
            violations.push({
              date: day.date,
              rule: "Split break wrong order",
              description: `Split break taken in wrong order: 30min portion before 15min portion. The 15min break must come first.`,
              actual: "30min then 15min",
              limit: "15min then 30min",
              severity: "MI",
              article: "Art. 7 Reg 561/2006",
            });
            // Only flag once per day
            break;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 13 — WTD break duration (Art. 5(1) Dir 2002/15/EC)
// If total work is 6-9h, breaks must total >= 30min.
// If total work > 9h, breaks must total >= 45min.
// Only breaks >= 15min count.
// ---------------------------------------------------------------------------

function checkWTDBreakDuration(days, violations) {
  for (const day of days) {
    const segs = toSegments(day.activities || []);
    if (!segs.length) continue;

    const totalWork = multiActMinutes(segs, [2, 3]); // driving + other work
    const totalWorkH = totalWork / 60;

    if (totalWorkH < 6) continue; // no requirement

    // Sum breaks >= 15min (rest or availability)
    let qualifyingBreaks = 0;
    for (const seg of segs) {
      if ((seg.act === 0 || seg.act === 1) && seg.dur >= 15) {
        qualifyingBreaks += seg.dur;
      }
    }

    let requiredBreak = 0;
    if (totalWorkH > 9) {
      requiredBreak = 45;
    } else {
      requiredBreak = 30;
    }

    const deficit = requiredBreak - qualifyingBreaks;
    if (deficit <= 0) continue;

    let severity;
    if (deficit > 30) {
      severity = "VSI";
    } else if (deficit > 15) {
      severity = "SI";
    } else {
      severity = "MI";
    }

    violations.push({
      date: day.date,
      rule: "WTD break duration",
      description: `Total work ${fmtMins(totalWork)} requires ${fmtMins(requiredBreak)} of breaks (segments >= 15min), but only ${fmtMins(qualifyingBreaks)} taken. Missing ${fmtMins(deficit)}.`,
      actual: fmtMins(qualifyingBreaks),
      limit: fmtMins(requiredBreak),
      severity,
      article: "Art. 5(1) Dir 2002/15/EC",
    });
  }
}

// ---------------------------------------------------------------------------
// Rule 14 — Reduced weekly rest compensation (Art. 8(6b) Reg 561/2006)
// When a reduced weekly rest (24-45h) is taken, the deficit must be
// compensated en bloc within 3 weeks, attached to a rest >= 9h.
// ---------------------------------------------------------------------------

function checkReducedWeeklyRestCompensation(days, violations) {
  const weeks = groupByWeek(days);
  const weekKeys = [...weeks.keys()].sort();

  if (weekKeys.length < 2) return; // need multiple weeks to check

  // Compute longest continuous rest per week (reuse logic from checkWeeklyRest)
  function longestRestInWeek(weekDays) {
    const wSorted = [...weekDays].sort((a, b) => a.date - b.date);

    // Build rest info per day
    function dayRestInfo(day) {
      const segs = toSegments(day.activities || []);
      if (!segs.length) return { leading: 1440, trailing: 1440, longestInner: 1440 };

      let leading = 0;
      for (const seg of segs) {
        if (seg.act === 0) leading += seg.dur;
        else break;
      }

      let trailing = 0;
      for (let i = segs.length - 1; i >= 0; i--) {
        if (segs[i].act === 0) trailing += segs[i].dur;
        else break;
      }

      let longestInner = 0;
      for (const seg of segs) {
        if (seg.act === 0 && seg.dur > longestInner) longestInner = seg.dur;
      }

      return { leading, trailing, longestInner };
    }

    let longest = 0;
    const infoMap = new Map();
    for (const day of wSorted) {
      const info = dayRestInfo(day);
      infoMap.set(day.date.getTime(), info);
      longest = Math.max(longest, info.longestInner);
    }

    // Cross-day spans
    for (let i = 0; i < wSorted.length - 1; i++) {
      const info = infoMap.get(wSorted[i].date.getTime());
      if (!info) continue;
      let span = info.trailing;
      for (let j = i + 1; j < wSorted.length; j++) {
        const prevDate = wSorted[j - 1].date;
        const curDate = wSorted[j].date;
        if (Math.round((curDate - prevDate) / 86400000) !== 1) break;
        const jInfo = infoMap.get(curDate.getTime());
        if (!jInfo) break;
        if (jInfo.leading === 1440) {
          span += 1440;
        } else {
          span += jInfo.leading;
          break;
        }
      }
      longest = Math.max(longest, span);
    }

    return longest;
  }

  // Find weeks with reduced weekly rest and check compensation
  for (let i = 0; i < weekKeys.length; i++) {
    const longestRest = longestRestInWeek(weeks.get(weekKeys[i]));
    const longestRestH = longestRest / 60;

    if (longestRestH >= 24 && longestRestH < 45) {
      // Reduced weekly rest — deficit must be compensated
      const deficit = 45 * 60 - longestRest; // in minutes
      const compensationNeeded = deficit + 9 * 60; // must be attached to >= 9h rest

      // Check next 3 weeks for a rest period >= compensationNeeded
      let compensated = false;
      for (let j = i + 1; j <= i + 3 && j < weekKeys.length; j++) {
        const futureRest = longestRestInWeek(weeks.get(weekKeys[j]));
        if (futureRest >= compensationNeeded) {
          compensated = true;
          break;
        }
      }

      if (!compensated) {
        const firstDate = [...weeks.get(weekKeys[i])].sort((a, b) => a.date - b.date)[0].date;
        violations.push({
          date: firstDate,
          rule: "Reduced weekly rest compensation",
          description: `Reduced weekly rest of ${fmtMins(longestRest)} in week ${weekKeys[i]}. Deficit of ${fmtMins(deficit)} must be compensated en bloc within 3 weeks (attached to >= 9h rest). Compensation not confirmed in available data.`,
          actual: fmtMins(longestRest),
          limit: "45h 00m (regular) — compensation required",
          severity: "MI",
          article: "Art. 8(6b) Reg 561/2006",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 15 — Belgian night work (KB 17/10/2016 Art. 44)
// Belgian night period is 00:00-07:00 (wider than generic 00:00-05:00).
// If any work during 00:00-07:00, total work in that day must not exceed 10h.
// ---------------------------------------------------------------------------

function checkBelgianNightWork(days, violations) {
  const NIGHT_START = 0;      // 00:00 in minutes
  const NIGHT_END = 7 * 60;   // 07:00 = 420 minutes

  for (const day of days) {
    const segs = toSegments(day.activities || []);
    if (!segs.length) continue;

    // Check if any work (act 2 or 3) overlaps with the Belgian night period
    let hasNightWork = false;
    for (const seg of segs) {
      if ((seg.act === 2 || seg.act === 3) && seg.start < NIGHT_END && seg.end > NIGHT_START) {
        hasNightWork = true;
        break;
      }
    }

    if (!hasNightWork) continue;

    const totalWork = multiActMinutes(segs, [2, 3]);
    const totalH = totalWork / 60;

    if (totalH > 13) {
      violations.push({
        date: day.date,
        rule: "Belgian night work daily limit",
        description: `Belgian night worker (00:00-07:00): total working time ${fmtMins(totalWork)} exceeds 13h (limit 10h).`,
        actual: fmtMins(totalWork),
        limit: "10h 00m",
        severity: "VSI",
        article: "Art. 44 KB 17/10/2016",
      });
    } else if (totalH > 11) {
      violations.push({
        date: day.date,
        rule: "Belgian night work daily limit",
        description: `Belgian night worker (00:00-07:00): total working time ${fmtMins(totalWork)} exceeds 11h (limit 10h).`,
        actual: fmtMins(totalWork),
        limit: "10h 00m",
        severity: "SI",
        article: "Art. 44 KB 17/10/2016",
      });
    } else if (totalH > 10) {
      violations.push({
        date: day.date,
        rule: "Belgian night work daily limit",
        description: `Belgian night worker (00:00-07:00): total working time ${fmtMins(totalWork)} exceeds 10h (limit 10h).`,
        actual: fmtMins(totalWork),
        limit: "10h 00m",
        severity: "MI",
        article: "Art. 44 KB 17/10/2016",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 16 — Belgian night premium (PC 140.03)
// Track shifts where >5h of work+availability falls within 20:00-06:00.
// Informational only — not a violation.
// ---------------------------------------------------------------------------

function checkBelgianNightPremium(days, violations) {
  // Night premium window: 20:00 (1200min) to 06:00 next day (1440 + 360 = 1800,
  // but within a single day's 0-1440 range: 0-360 and 1200-1440)
  const WINDOW_EVENING_START = 20 * 60; // 1200 min
  const WINDOW_MORNING_END = 6 * 60;    // 360 min

  for (const day of days) {
    const segs = toSegments(day.activities || []);
    if (!segs.length) continue;

    // Calculate overlap of work+availability (acts 1, 2, 3) with 20:00-06:00
    let nightMinutes = 0;
    for (const seg of segs) {
      if (seg.act === 1 || seg.act === 2 || seg.act === 3) {
        // Morning window: 00:00-06:00
        if (seg.start < WINDOW_MORNING_END && seg.end > 0) {
          const overlapStart = Math.max(seg.start, 0);
          const overlapEnd = Math.min(seg.end, WINDOW_MORNING_END);
          if (overlapEnd > overlapStart) nightMinutes += overlapEnd - overlapStart;
        }
        // Evening window: 20:00-24:00
        if (seg.start < 1440 && seg.end > WINDOW_EVENING_START) {
          const overlapStart = Math.max(seg.start, WINDOW_EVENING_START);
          const overlapEnd = Math.min(seg.end, 1440);
          if (overlapEnd > overlapStart) nightMinutes += overlapEnd - overlapStart;
        }
      }
    }

    if (nightMinutes > 5 * 60) {
      violations.push({
        date: day.date,
        rule: "Belgian night premium applicable",
        description: `Nachtpremie van toepassing — meer dan 5 uur werk/beschikbaarheid tussen 20:00-06:00 (${fmtMins(nightMinutes)}).`,
        actual: fmtMins(nightMinutes),
        limit: "> 5h 00m in 20:00-06:00",
        severity: "INFO",
        article: "PC 140.03 Nachtpremie",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 17 — Belgian download deadline (KB 17/10/2016 Art. 34)
// Belgian driver card must be downloaded every 21 days (not EU 28).
// ---------------------------------------------------------------------------

function checkBelgianDownloadDeadline(days, violations) {
  if (!days.length) return;

  const sorted = [...days].sort((a, b) => a.date - b.date);
  const lastDayDate = sorted[sorted.length - 1].date;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffMs = today.getTime() - lastDayDate.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays <= 21) return;

  const overdue = diffDays - 21;

  let severity;
  if (overdue > 14) {
    // > 35 days total (overdue > 14 means diffDays > 35)
    severity = "VSI";
  } else if (overdue > 4) {
    // 26-35 days total (overdue 5-14 means diffDays 26-35)
    severity = "SI";
  } else {
    // 22-25 days total (overdue 1-4 means diffDays 22-25)
    severity = "MI";
  }

  violations.push({
    date: lastDayDate,
    rule: "Belgian card download deadline",
    description: `Driver card data is ${diffDays} days old (last day: ${lastDayDate.toISOString().slice(0, 10)}). Belgian limit is 21 days. ${overdue} days overdue.`,
    actual: `${diffDays} days`,
    limit: "21 days",
    severity,
    article: "Art. 34 KB 17/10/2016",
  });
}

// ---------------------------------------------------------------------------
// Belgian fine estimation (KB 8/12/2024)
// Estimates Belgian fines for existing violations. Adds `estimatedFine` field.
// ---------------------------------------------------------------------------

function estimateBelgianFine(violation) {
  const rule = violation.rule || "";
  const severity = violation.severity || "";

  // --- Continuous driving excess ---
  if (rule === "Continuous driving without break") {
    // Parse actual driving from the violation
    const actualMinutes = parseMinutesFromFmt(violation.actual);
    const excess = actualMinutes - (4 * 60 + 30); // excess over 4h30m
    if (excess <= 15) return 44;
    if (excess <= 60) return 132;
    if (excess <= 120) return 264;
    if (excess <= 180) return 440;
    if (excess <= 300) return 660;
    return 1100;
  }

  // --- Daily driving excess ---
  if (rule === "Daily driving limit") {
    const actualMinutes = parseMinutesFromFmt(violation.actual);
    const excess = actualMinutes - 9 * 60; // excess over 9h base limit
    if (excess <= 30) return 88;
    if (excess <= 60) return 176;
    if (excess <= 120) return 352;
    if (excess <= 180) return 528;
    return 880;
  }

  // --- Weekly driving excess ---
  if (rule === "Weekly driving limit") {
    const actualMinutes = parseMinutesFromFmt(violation.actual);
    const excess = actualMinutes - 56 * 60; // excess over 56h
    const commencedHours = Math.ceil(excess / 60);
    return commencedHours * 110;
  }

  // --- Fortnightly driving excess ---
  if (rule === "Fortnightly driving limit") {
    const actualMinutes = parseMinutesFromFmt(violation.actual);
    const excess = actualMinutes - 90 * 60;
    const commencedHours = Math.ceil(excess / 60);
    return commencedHours * 110;
  }

  // --- Insufficient daily rest ---
  if (rule === "Insufficient daily rest" || rule === "Insufficient daily rest (excess reduced rests)") {
    const actualMinutes = parseMinutesFromFmt(violation.actual);
    // Required minimum depends on context, use 9h as base for reduced
    const required = rule.includes("excess") ? 11 * 60 : 9 * 60;
    const deficit = required - actualMinutes;
    if (deficit <= 0) return 0;
    const blocks = Math.ceil(deficit / 30); // per missing 30-min block
    return blocks * 55;
  }

  // --- Insufficient weekly rest ---
  if (rule === "Insufficient weekly rest" || rule === "No regular weekly rest in 2 consecutive weeks") {
    const actualMinutes = parseMinutesFromFmt(violation.actual);
    const deficit = 45 * 60 - actualMinutes;
    if (deficit <= 0) return 0;
    const missingHours = Math.ceil(deficit / 60);
    return missingHours * 110;
  }

  // --- 6-day rule ---
  if (rule === "6-day rule (weekly rest overdue)") {
    // Treat similarly to weekly rest
    return 110;
  }

  // --- Weekly rest in vehicle (if detected in description) ---
  if (rule.toLowerCase().includes("weekly rest") && (violation.description || "").toLowerCase().includes("vehicle")) {
    return 1800;
  }

  // --- WTD violations: €110 per commenced hour over limit ---
  if (rule.includes("WTD") || rule.includes("working time") || rule.includes("Continuous work") || rule.includes("Night work")) {
    const actualMinutes = parseMinutesFromFmt(violation.actual);
    let limitMinutes = 0;

    if (rule.includes("48h average")) {
      limitMinutes = 48 * 60;
    } else if (rule.includes("Weekly working time")) {
      limitMinutes = 60 * 60;
    } else if (rule.includes("Continuous work")) {
      limitMinutes = 6 * 60;
    } else if (rule.includes("Night work") || rule.includes("night work")) {
      limitMinutes = 10 * 60;
    } else if (rule.includes("WTD break duration")) {
      // For break duration violations, fine based on deficit
      const limitBreak = parseMinutesFromFmt(violation.limit);
      const actualBreak = parseMinutesFromFmt(violation.actual);
      const deficit = limitBreak - actualBreak;
      const commencedHours = Math.ceil(deficit / 60);
      return Math.max(commencedHours, 1) * 110;
    }

    if (limitMinutes > 0) {
      const excess = actualMinutes - limitMinutes;
      if (excess <= 0) return 110; // minimum
      const commencedHours = Math.ceil(excess / 60);
      return commencedHours * 110;
    }
  }

  // --- Belgian-specific violations ---
  if (rule.includes("Belgian night work")) {
    const actualMinutes = parseMinutesFromFmt(violation.actual);
    const excess = actualMinutes - 10 * 60;
    if (excess <= 0) return 110;
    const commencedHours = Math.ceil(excess / 60);
    return commencedHours * 110;
  }

  if (rule.includes("Belgian card download")) {
    // Fine based on severity tiers
    if (severity === "VSI") return 440;
    if (severity === "SI") return 220;
    return 110;
  }

  // --- Split break order ---
  if (rule === "Split break wrong order") {
    return 44;
  }

  // --- Reduced weekly rest compensation ---
  if (rule === "Reduced weekly rest compensation") {
    return 110;
  }

  // INFO-level items have no fine
  if (severity === "INFO") return 0;

  // Fallback: no estimate available
  return 0;
}

/** Parse "Xh YYm" format back to minutes. */
function parseMinutesFromFmt(str) {
  if (!str || typeof str !== "string") return 0;
  const match = str.match(/(\d+)h\s*(\d+)m/);
  if (match) return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  // Try just hours
  const hMatch = str.match(/(\d+)h/);
  if (hMatch) return parseInt(hMatch[1], 10) * 60;
  return 0;
}

/** Add estimatedFine to all violations in the array. */
function checkBelgianFineEstimate(violations) {
  for (const v of violations) {
    v.estimatedFine = estimateBelgianFine(v);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Check compliance of parsed tachograph data against EU regulations.
 *
 * @param {Array} days - Array of day objects: { date: Date, dist: number, activities: [{act, time}] }
 * @returns {Array} violations - Array of violation objects sorted by date then severity.
 */
function checkCompliance(days) {
  if (!days || !days.length) return [];

  // Sort days chronologically for consistent processing
  const sorted = [...days].sort((a, b) => a.date - b.date);
  const violations = [];

  checkDailyDriving(sorted, violations);
  checkWeeklyDriving(sorted, violations);
  checkFortnightlyDriving(sorted, violations);
  checkContinuousDriving(sorted, violations);
  checkDailyRest(sorted, violations);
  checkWeeklyRest(sorted, violations);
  checkWeeklyWorkingTime(sorted, violations);
  checkContinuousWork(sorted, violations);
  checkNightWork(sorted, violations);
  checkWTD48hAverage(sorted, violations);
  checkSplitBreakOrder(sorted, violations);
  checkWTDBreakDuration(sorted, violations);
  checkReducedWeeklyRestCompensation(sorted, violations);
  checkBelgianNightWork(sorted, violations);
  checkBelgianNightPremium(sorted, violations);
  checkBelgianDownloadDeadline(sorted, violations);

  // Add Belgian fine estimates to all violations (must run after all checks)
  checkBelgianFineEstimate(violations);

  // Sort: by date ascending, then by severity (most severe first)
  const severityOrder = { MSI: 0, VSI: 1, SI: 2, MI: 3, INFO: 4 };
  violations.sort((a, b) => {
    const dateDiff = a.date - b.date;
    if (dateDiff !== 0) return dateDiff;
    return (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5);
  });

  return violations;
}

export { checkCompliance };
