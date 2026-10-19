//! Outcomes and tallies (Task.md §3 "Стих — одно очко").
//!
//! A verse is one point on the scale. People and models each give it an
//! outcome: 1 (supports the first position, "pro"), -1 (the second, "con"),
//! 0 (not relevant) or None (undecided). A subtopic's and a topic's score is
//! the tally of their verses' outcomes. AI and people are never mixed.

use serde_json::{json, Value};

const VALUES: [i64; 3] = [1, -1, 0];

/// The value with the most votes; None if there are no votes or the top two tie.
/// Used for both people (their votes) and AI (one value per model):
/// [1, 1, -1] → 1; [1, -1] → None; [0, 0, 1] → 0; [] → None.
pub fn outcome(values: impl IntoIterator<Item = i64>) -> Option<i64> {
    let mut counts = [0usize; 3];
    for value in values {
        if let Some(index) = VALUES.iter().position(|v| *v == value) {
            counts[index] += 1;
        }
    }
    let mut ranked = counts;
    ranked.sort_unstable_by(|a, b| b.cmp(a));
    if ranked[0] == 0 || ranked[0] == ranked[1] {
        return None;
    }
    VALUES.iter().zip(counts).find(|(_, count)| *count == ranked[0]).map(|(value, _)| *value)
}

/// {pro, con, none} of a verse; `mine` only for a signed-in viewer (null = no vote).
pub fn verse_votes(values: &[i64], mine: Option<i64>, viewer: bool) -> Value {
    let count = |want: i64| values.iter().filter(|v| **v == want).count();
    let mut summary = json!({ "pro": count(1), "con": count(-1), "none": count(0) });
    if viewer {
        summary["mine"] = json!(mine);
    }
    summary
}

/// {up, down} of an interpretation (+ / −); `mine` only for a signed-in viewer.
/// These never feed outcomes, tallies or the AI.
pub fn updown_votes(values: &[i64], mine: Option<i64>, viewer: bool) -> Value {
    let count = |want: i64| values.iter().filter(|v| **v == want).count();
    let mut summary = json!({ "up": count(1), "down": count(-1) });
    if viewer {
        summary["mine"] = json!(mine);
    }
    summary
}

/// Counts of verse outcomes: pro (1), con (-1), none (0), open (None).
pub fn tally(outcomes: impl IntoIterator<Item = Option<i64>>) -> Value {
    let (mut pro, mut con, mut none, mut open) = (0, 0, 0, 0);
    for value in outcomes {
        match value {
            Some(1) => pro += 1,
            Some(-1) => con += 1,
            Some(0) => none += 1,
            _ => open += 1,
        }
    }
    json!({ "pro": pro, "con": con, "none": none, "open": open })
}

/// "none" without verses, "pending" if any verse is being evaluated, else "fresh".
pub fn ai_status<'a>(statuses: impl IntoIterator<Item = &'a str>) -> &'static str {
    let mut any = false;
    for status in statuses {
        if status == "pending" {
            return "pending";
        }
        any = true;
    }
    if any {
        "fresh"
    } else {
        "none"
    }
}

/// Tallies of a subtopic or topic from its rendered verses. A topic's tally is
/// the sum over its subtopics, which equals the tally of all its verses.
pub fn tallies(verses: &[Value]) -> Value {
    let outcome_of = |verse: &Value, who: &str| verse[who]["outcome"].as_i64();
    json!({
        "users": tally(verses.iter().map(|v| outcome_of(v, "users"))),
        "ai": tally(verses.iter().map(|v| outcome_of(v, "ai"))),
        "aiStatus": ai_status(verses.iter().map(|v| v["ai"]["status"].as_str().unwrap_or("none"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcomes() {
        assert_eq!(outcome([1, 1, -1]), Some(1));
        assert_eq!(outcome([1, -1]), None);
        assert_eq!(outcome([0, 0, 1]), Some(0));
        assert_eq!(outcome([]), None);
        assert_eq!(outcome([1, 1, -1, -1, 0]), None);
        assert_eq!(outcome([1, 1, 0, 0, -1, -1]), None);
        assert_eq!(outcome([-1, -1, 1, 0]), Some(-1));
    }

    #[test]
    fn tallies_and_status() {
        assert_eq!(tally([Some(1), None, Some(0), Some(-1), Some(1)]), json!({ "pro": 2, "con": 1, "none": 1, "open": 1 }));
        assert_eq!(ai_status([]), "none");
        assert_eq!(ai_status(["fresh", "pending"]), "pending");
        assert_eq!(ai_status(["fresh", "none"]), "fresh");
    }
}
