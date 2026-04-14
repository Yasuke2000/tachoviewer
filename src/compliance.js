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
 * Rule 5 — Insufficient daily rest (Art. 8)
 * Regular daily rest: >= 11h within a 24h period.
 * Reduced daily rest: >= 9h (max 3x between weekly rests).
 *
 * Simplified: check the longest continuous rest per day.
 */
function checkDailyRest(days, violations) {
  let reducedRestCount = 0;

  for (const day of days) {
    const segs = toSegments(day.activities || []);

    // Find longest continuous rest period (act === 0)
    let longestRest = 0;
    for (const seg of segs) {
      if (seg.act === 0 && seg.dur > longestRest) {
        longestRest = seg.dur;
      }
    }

    // Also consider rest that spans from end of activities to midnight
    // and rest at start of day — these are already captured in segments
    // since toSegments fills to 1440.

    if (longestRest >= 11 * 60) {
      // Compliant — regular daily rest
      continue;
    }

    // Rule 9 — Split daily rest check (Art. 8(2) Reg 561/2006)
    // Before flagging a violation for <11h longest rest, check if there is a
    // valid 3h + 9h split pattern (any rest >= 3h followed later by a rest >= 9h,
    // totaling >= 12h within the same 24h period).
    const restSegs = segs.filter((s) => s.act === 0);
    let splitRestCompliant = false;
    for (let i = 0; i < restSegs.length; i++) {
      if (restSegs[i].dur >= 3 * 60) {
        for (let j = i + 1; j < restSegs.length; j++) {
          if (restSegs[j].dur >= 9 * 60 && restSegs[i].dur + restSegs[j].dur >= 12 * 60) {
            splitRestCompliant = true;
            break;
          }
        }
      }
      if (splitRestCompliant) break;
    }

    if (splitRestCompliant) {
      // Compliant via split daily rest (3h + 9h)
      continue;
    }

    if (longestRest >= 9 * 60) {
      // Reduced daily rest
      reducedRestCount++;
      if (reducedRestCount > 3) {
        // Too many reduced rests — violation
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
      // Otherwise the reduced rest is allowed
      continue;
    }

    // Less than 9h — definite violation, severity depends on how short
    let severity;
    let requiredLabel;

    if (reducedRestCount < 3) {
      // Could have taken a reduced rest (9h minimum)
      if (longestRest >= 8 * 60) {
        severity = "MI";
      } else if (longestRest >= 7 * 60) {
        severity = "SI";
      } else {
        severity = "VSI";
      }
      requiredLabel = "9h 00m (reduced)";
      reducedRestCount++; // Count this as a (violated) reduced rest attempt
    } else {
      // Already exhausted reduced rests — must take 11h regular
      if (longestRest >= 10 * 60) {
        severity = "MI";
      } else if (longestRest >= 8 * 60 + 30) {
        severity = "SI";
      } else {
        severity = "VSI";
      }
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

    // Check cross-day spans: trailing rest of day N + full-rest days + leading rest of next non-full-rest day
    for (let i = 0; i < wSorted.length - 1; i++) {
      const info = restInfoByDate.get(wSorted[i].date.getTime());
      if (!info) continue;
      let span = info.trailing;

      // Walk forward across consecutive days
      for (let j = i + 1; j < wSorted.length; j++) {
        // Check days are truly consecutive calendar days
        const prevDate = wSorted[j - 1].date;
        const curDate = wSorted[j].date;
        const diffMs = curDate.getTime() - prevDate.getTime();
        const diffDays = Math.round(diffMs / 86400000);
        if (diffDays !== 1) break; // not consecutive, gap in data

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

  // Sort: by date ascending, then by severity (most severe first)
  const severityOrder = { MSI: 0, VSI: 1, SI: 2, MI: 3 };
  violations.sort((a, b) => {
    const dateDiff = a.date - b.date;
    if (dateDiff !== 0) return dateDiff;
    return (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4);
  });

  return violations;
}

export { checkCompliance };
