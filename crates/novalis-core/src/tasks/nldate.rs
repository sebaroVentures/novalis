//! Pure natural-language date resolution for the task grammar.
//!
//! [`resolve_nl_date`] turns a phrase like `"next friday"` or `"in 3 days"`
//! into a concrete [`NaiveDate`], relative to an **injected** reference date —
//! never an ambient `now()` — so it is deterministic and fully unit-testable.
//! The service layer supplies the reference (`Local::now().date_naive()`); this
//! module stays free of the clock.
//!
//! ## Supported phrases (case-insensitive, surrounding whitespace trimmed)
//! - ISO pass-through: `2026-07-15` → that date (lets callers run every date
//!   field through one resolver).
//! - `today`, `tomorrow`, `yesterday`.
//! - Weekday names — full (`monday`..`sunday`) or 3-letter (`mon`..`sun`, plus
//!   `tues`/`thurs`), with an optional `next ` prefix. Resolves to the soonest
//!   **strictly future** occurrence: a weekday name never resolves to today, so
//!   `friday` on a Friday means the *next* Friday. `next friday` is treated as a
//!   synonym for `friday` — it does **not** skip an extra week.
//! - `next week` (+7 days), `next month` (+1 month, month-end clamped by chrono).
//! - `in N days`, `in N weeks`, `in N months` (singular units also accepted; `N`
//!   a non-negative integer, so `in 0 days` is today).
//!
//! ## Deliberately NOT supported (returns `None`, never guessed)
//! - `this friday` / `last friday` distinctions, and `next friday`'s week-skip.
//! - Absolute calendar dates in prose (`July 15`, `15th`, `on the 3rd`).
//! - Times of day or datetimes (`3pm`, `friday at 9`).
//! - Word-numbers (`in three days`, `in a week`).
//! - `end/beginning of month`, `eom`, `eow`, `weekend`, `next year`.
//! - Compound or multi-clause phrases.

use chrono::{Datelike, Days, Months, NaiveDate, Weekday};

/// Resolve a natural-language (or ISO) date `phrase` relative to `reference`.
/// Returns `None` for anything unrecognized — see the module docs for the exact
/// supported/unsupported sets.
pub fn resolve_nl_date(phrase: &str, reference: NaiveDate) -> Option<NaiveDate> {
    let p = phrase.trim().to_ascii_lowercase();
    if p.is_empty() {
        return None;
    }

    // ISO pass-through, so a resolved and an explicit date share one code path.
    if let Ok(d) = NaiveDate::parse_from_str(&p, "%Y-%m-%d") {
        return Some(d);
    }

    match p.as_str() {
        "today" => return Some(reference),
        "tomorrow" => return reference.checked_add_days(Days::new(1)),
        "yesterday" => return reference.checked_sub_days(Days::new(1)),
        "next week" => return reference.checked_add_days(Days::new(7)),
        "next month" => return reference.checked_add_months(Months::new(1)),
        _ => {}
    }

    // Bare or `next `-prefixed weekday name.
    let weekday_part = p.strip_prefix("next ").unwrap_or(p.as_str());
    if let Some(wd) = parse_weekday(weekday_part) {
        return next_weekday(reference, wd);
    }

    // `in N days | weeks | months`.
    if let Some(rest) = p.strip_prefix("in ") {
        return resolve_in_n(rest, reference);
    }

    None
}

/// Rewrite `@due(...)` / `@start(...)` annotations on a task line whose inner
/// value is a natural-language phrase (not already `YYYY-MM-DD`) to the resolved
/// concrete date, relative to `reference`. Values that already parse as ISO are
/// left as-is; phrases that don't resolve are left untouched (non-destructive)
/// and logged, so a typo degrades to "no date" rather than corrupting the line.
/// Any other annotations are untouched.
pub fn resolve_inline_dates(line: &str, reference: NaiveDate) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"@(due|start)\(([^)]*)\)").unwrap());

    re.replace_all(line, |caps: &regex::Captures| {
        let key = &caps[1];
        let inner = caps[2].trim();
        // Already a concrete date → leave verbatim.
        if NaiveDate::parse_from_str(inner, "%Y-%m-%d").is_ok() {
            return caps[0].to_string();
        }
        match resolve_nl_date(inner, reference) {
            Some(d) => format!("@{key}({})", d.format("%Y-%m-%d")),
            None => {
                log::warn!("nldate: unrecognized @{key} phrase {inner:?}; leaving as-is");
                caps[0].to_string()
            }
        }
    })
    .into_owned()
}

fn parse_weekday(s: &str) -> Option<Weekday> {
    Some(match s {
        "monday" | "mon" => Weekday::Mon,
        "tuesday" | "tue" | "tues" => Weekday::Tue,
        "wednesday" | "wed" => Weekday::Wed,
        "thursday" | "thu" | "thurs" => Weekday::Thu,
        "friday" | "fri" => Weekday::Fri,
        "saturday" | "sat" => Weekday::Sat,
        "sunday" | "sun" => Weekday::Sun,
        _ => return None,
    })
}

/// The soonest occurrence of `target` strictly after `reference` (same weekday
/// as the reference resolves to a full week later, never to the reference day).
fn next_weekday(reference: NaiveDate, target: Weekday) -> Option<NaiveDate> {
    let cur = reference.weekday().num_days_from_monday();
    let tgt = target.num_days_from_monday();
    let mut delta = (tgt + 7 - cur) % 7;
    if delta == 0 {
        delta = 7;
    }
    reference.checked_add_days(Days::new(delta as u64))
}

fn resolve_in_n(rest: &str, reference: NaiveDate) -> Option<NaiveDate> {
    let mut it = rest.split_whitespace();
    let n: u64 = it.next()?.parse().ok()?;
    let unit = it.next()?;
    if it.next().is_some() {
        return None; // trailing tokens → not a phrase we support
    }
    match unit {
        "day" | "days" => reference.checked_add_days(Days::new(n)),
        "week" | "weeks" => reference.checked_add_days(Days::new(n.checked_mul(7)?)),
        "month" | "months" => reference.checked_add_months(Months::new(u32::try_from(n).ok()?)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wednesday.
    fn reference() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 7, 8).unwrap()
    }

    fn ymd(y: i32, m: u32, d: u32) -> Option<NaiveDate> {
        NaiveDate::from_ymd_opt(y, m, d)
    }

    #[test]
    fn resolve_nl_date_table() {
        // Reference 2026-07-08 is a Wednesday.
        let cases: &[(&str, Option<NaiveDate>)] = &[
            // Anchors.
            ("today", ymd(2026, 7, 8)),
            ("Tomorrow", ymd(2026, 7, 9)),
            ("  YESTERDAY ", ymd(2026, 7, 7)),
            ("next week", ymd(2026, 7, 15)),
            ("next month", ymd(2026, 8, 8)),
            // ISO pass-through.
            ("2026-07-15", ymd(2026, 7, 15)),
            // Weekdays are strictly future: same weekday → +7.
            ("wednesday", ymd(2026, 7, 15)),
            ("wed", ymd(2026, 7, 15)),
            ("thursday", ymd(2026, 7, 9)),
            ("fri", ymd(2026, 7, 10)),
            ("saturday", ymd(2026, 7, 11)),
            ("sunday", ymd(2026, 7, 12)),
            ("monday", ymd(2026, 7, 13)),
            ("tuesday", ymd(2026, 7, 14)),
            // "next <weekday>" is a synonym for the bare weekday (no week skip).
            ("next friday", ymd(2026, 7, 10)),
            ("next wednesday", ymd(2026, 7, 15)),
            // in N units (singular + plural, N may be zero).
            ("in 3 days", ymd(2026, 7, 11)),
            ("in 1 day", ymd(2026, 7, 9)),
            ("in 0 days", ymd(2026, 7, 8)),
            ("in 2 weeks", ymd(2026, 7, 22)),
            ("in 1 month", ymd(2026, 8, 8)),
            // Unsupported → None (never guessed).
            ("", None),
            ("someday", None),
            ("next year", None),
            ("in three days", None),
            ("in 3 fortnights", None),
            ("end of month", None),
            ("july 15", None),
            ("friday at 9", None),
            ("2026/07/15", None),
        ];
        for (phrase, expected) in cases {
            assert_eq!(
                resolve_nl_date(phrase, reference()),
                *expected,
                "phrase {phrase:?}"
            );
        }
    }

    #[test]
    fn weekday_wraps_across_month_and_year_ends() {
        // 2026-12-31 is a Thursday; "friday" → 2027-01-01.
        let dec31 = NaiveDate::from_ymd_opt(2026, 12, 31).unwrap();
        assert_eq!(resolve_nl_date("friday", dec31), ymd(2027, 1, 1));
        // "next month" from Jan 31 clamps to Feb 28 (chrono month-end behavior).
        let jan31 = NaiveDate::from_ymd_opt(2026, 1, 31).unwrap();
        assert_eq!(resolve_nl_date("next month", jan31), ymd(2026, 2, 28));
    }

    #[test]
    fn resolve_inline_dates_rewrites_only_unresolved_date_slots() {
        // NL @due is resolved; an already-ISO @start is left verbatim; a
        // non-date annotation is untouched; an unrecognized phrase is preserved.
        let line = "- [ ] Ship @due(next friday) @start(2026-07-08) @priority(high)";
        assert_eq!(
            resolve_inline_dates(line, reference()),
            "- [ ] Ship @due(2026-07-10) @start(2026-07-08) @priority(high)"
        );

        let untouched = "- [ ] Ship @due(whenever) @project(work)";
        assert_eq!(resolve_inline_dates(untouched, reference()), untouched);
    }
}
