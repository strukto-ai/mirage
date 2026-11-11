use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::Text;
use crate::StreamError;

macro_rules! key {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
        #[serde(transparent)]
        pub(super) struct $name(usize);
    };
}

key!(RecordKey);
key!(HolderKey);
key!(ClaimKey);
key!(OccurrenceKey);
key!(RuleKey);
key!(SourceKey);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Answer {
    Allow,
    Deny,
    Ask,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Scope {
    Once,
    Session,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Record {
    keys: Vec<RecordKey>,
    rule: Option<RuleKey>,
    same_line: bool,
    outcome: Option<Answer>,
    scope: Scope,
}

#[derive(Debug, Deserialize)]
pub(super) struct AnswerRecord {
    key: RecordKey,
    id: Text,
    outcome: Option<Answer>,
}

#[derive(Debug, Deserialize)]
pub(super) struct Occurrence {
    key: OccurrenceKey,
    parent: Option<OccurrenceKey>,
    source: SourceKey,
    start: usize,
    end: usize,
}

#[derive(Debug, Deserialize)]
pub(super) struct Claim {
    key: ClaimKey,
    record: RecordKey,
    occurrence: OccurrenceKey,
}

#[derive(Debug, Deserialize)]
pub(super) struct Holder {
    key: HolderKey,
    parent: Option<HolderKey>,
    claims: Vec<ClaimKey>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct State {
    records: Vec<Record>,
    holders: Vec<Holder>,
    claims: Vec<Claim>,
    live: Vec<HolderKey>,
    occurrences: Vec<Occurrence>,
    sources: Vec<Text>,
}

#[derive(Debug, Deserialize)]
pub(super) struct Claimant {
    holder: HolderKey,
    occurrence: OccurrenceKey,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum Query {
    Covers {
        record: Record,
        rule: RuleKey,
    },

    Plan {
        state: State,
        rules: Vec<RuleKey>,
        claimant: Option<Claimant>,
    },

    Waiting {
        records: Vec<Record>,
        rule: RuleKey,
    },
    Answer {
        records: Vec<AnswerRecord>,
        id: Text,
        outcome: Answer,
    },

    Claim {
        state: State,
        holder: HolderKey,
        records: Vec<RecordKey>,
    },
    Split {
        state: State,
        holder: HolderKey,
        scope: OccurrenceKey,
    },
    HandUp {
        state: State,
        holder: HolderKey,
    },
    Revoke {
        state: State,
        holder: HolderKey,
    },
}

#[derive(Debug, Serialize)]
pub(super) struct Plan {
    answers: Vec<Option<RecordKey>>,
    denied: Option<usize>,
    missing: Vec<usize>,
    once: Vec<RecordKey>,
    waiting: Vec<Option<RecordKey>>,
    claim: Option<Claimed>,
}

#[derive(Debug, Serialize)]
pub(super) struct Claimed {
    records: Vec<RecordKey>,
    live: Vec<HolderKey>,
}

#[derive(Debug, Serialize)]
pub(super) struct HandedUp {
    parent: HolderKey,
    claims: Vec<ClaimKey>,
    live: Vec<HolderKey>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub(super) enum Reply {
    Bool(bool),
    Record(Option<RecordKey>),
    Records(Vec<RecordKey>),
    Claims(Vec<ClaimKey>),
    Plan(Plan),
    Claimed(Claimed),
    HandedUp(HandedUp),
}

fn covers(record: &Record, rule: RuleKey) -> bool {
    if record.outcome.is_none() || record.rule != Some(rule) {
        return false;
    }
    match record.scope {
        Scope::Session => record.outcome == Some(Answer::Allow),
        Scope::Once => record.same_line,
    }
}

impl State {
    fn source(&self, key: SourceKey) -> Result<&Text, StreamError> {
        self.sources
            .get(key.0)
            .ok_or_else(|| StreamError::new("unknown approval source"))
    }

    fn occurrence(&self, key: OccurrenceKey) -> Result<&Occurrence, StreamError> {
        self.occurrences
            .iter()
            .find(|node| node.key == key)
            .ok_or_else(|| StreamError::new("unknown approval occurrence"))
    }

    fn same_occurrence(
        &self,
        mut left: Option<OccurrenceKey>,
        mut right: Option<OccurrenceKey>,
    ) -> Result<bool, StreamError> {
        let mut visited = HashSet::new();
        while let (Some(a), Some(b)) = (left, right) {
            if !visited.insert((a, b)) {
                return Err(StreamError::new("cyclic approval occurrence lineage"));
            }
            let a = self.occurrence(a)?;
            let b = self.occurrence(b)?;
            if self.source(a.source)? != self.source(b.source)?
                || a.start != b.start
                || a.end != b.end
            {
                return Ok(false);
            }
            left = a.parent;
            right = b.parent;
        }
        Ok(left.is_none() && right.is_none())
    }

    fn encloses(
        &self,
        scope: OccurrenceKey,
        occurrence: OccurrenceKey,
    ) -> Result<bool, StreamError> {
        let scope = self.occurrence(scope)?;
        let mut within = Some(occurrence);
        let mut visited = HashSet::new();
        while let Some(key) = within {
            if !visited.insert(key) {
                return Err(StreamError::new("cyclic approval occurrence lineage"));
            }
            let node = self.occurrence(key)?;
            if self.source(node.source)? == self.source(scope.source)?
                && self.same_occurrence(node.parent, scope.parent)?
            {
                return Ok(scope.start <= node.start && node.end <= scope.end);
            }
            within = node.parent;
        }
        Ok(false)
    }

    fn holder(&self, key: HolderKey) -> Result<&Holder, StreamError> {
        self.holders
            .iter()
            .find(|holder| holder.key == key)
            .ok_or_else(|| StreamError::new("unknown approval holder"))
    }

    fn claim(&self, key: ClaimKey) -> Result<&Claim, StreamError> {
        self.claims
            .iter()
            .find(|claim| claim.key == key)
            .ok_or_else(|| StreamError::new("unknown approval claim"))
    }

    fn lineage(&self, key: HolderKey) -> Result<Vec<&Holder>, StreamError> {
        let mut line = Some(key);
        let mut found = HashSet::new();
        let mut holders = Vec::new();
        while let Some(key) = line {
            if !found.insert(key) {
                return Err(StreamError::new("cyclic approval holder lineage"));
            }
            let holder = self.holder(key)?;
            holders.push(holder);
            line = holder.parent;
        }
        Ok(holders)
    }

    fn claimed_by(&self, holders: &[&Holder]) -> Result<Vec<&Claim>, StreamError> {
        holders
            .iter()
            .flat_map(|holder| &holder.claims)
            .map(|&key| self.claim(key))
            .collect()
    }

    fn standing(
        &self,
        claimant: Option<&Claimant>,
    ) -> Result<Vec<(RecordKey, &Record)>, StreamError> {
        if self.live.is_empty() {
            return Ok(self
                .records
                .iter()
                .filter_map(|record| record.keys.first().map(|&key| (key, record)))
                .collect());
        }
        let mut offered = HashSet::new();
        if let Some(claimant) = claimant {
            for claim in self.claimed_by(&self.lineage(claimant.holder)?)? {
                if self.same_occurrence(Some(claim.occurrence), Some(claimant.occurrence))? {
                    offered.insert(claim.record);
                }
            }
        }
        let live = self
            .live
            .iter()
            .map(|&key| self.holder(key))
            .collect::<Result<Vec<_>, _>>()?;
        let taken: HashSet<RecordKey> = self
            .claimed_by(&live)?
            .into_iter()
            .map(|claim| claim.record)
            .filter(|key| !offered.contains(key))
            .collect();
        Ok(self
            .records
            .iter()
            .filter_map(|record| {
                record
                    .keys
                    .iter()
                    .find(|key| !taken.contains(key))
                    .map(|&key| (key, record))
            })
            .collect())
    }

    fn plan(&self, rules: &[RuleKey], claimant: Option<&Claimant>) -> Result<Plan, StreamError> {
        let records = self.standing(claimant)?;
        let found: Vec<Option<(RecordKey, &Record)>> = rules
            .iter()
            .map(|rule| {
                [Scope::Once, Scope::Session].iter().find_map(|scope| {
                    records
                        .iter()
                        .find(|(_, record)| record.scope == *scope && covers(record, *rule))
                        .copied()
                })
            })
            .collect();
        let denied = found.iter().position(|record| {
            record.is_some_and(|(_, record)| record.outcome == Some(Answer::Deny))
        });
        let missing: Vec<usize> = found
            .iter()
            .enumerate()
            .filter_map(|(index, record)| record.is_none().then_some(index))
            .collect();
        let once: Vec<RecordKey> = found
            .iter()
            .flatten()
            .filter(|(_, record)| record.scope == Scope::Once)
            .map(|(key, _)| *key)
            .collect();
        let waiting = rules
            .iter()
            .map(|rule| {
                self.records.iter().find_map(|record| {
                    if record.outcome.is_none() && record.rule == Some(*rule) && record.same_line {
                        record.keys.first().copied()
                    } else {
                        None
                    }
                })
            })
            .collect();
        let claim = claimant
            .filter(|_| !once.is_empty())
            .map(|reader| self.claim_changes(reader.holder, &once))
            .transpose()?;
        Ok(Plan {
            answers: found
                .iter()
                .map(|record| record.map(|(key, _)| key))
                .collect(),
            denied,
            missing,
            once,
            waiting,
            claim,
        })
    }

    fn claim_changes(
        &self,
        holder: HolderKey,
        records: &[RecordKey],
    ) -> Result<Claimed, StreamError> {
        let claimed: HashSet<RecordKey> = self
            .claimed_by(&self.lineage(holder)?)?
            .iter()
            .map(|claim| claim.record)
            .collect();
        let records: Vec<RecordKey> = records
            .iter()
            .copied()
            .filter(|key| !claimed.contains(key))
            .collect();
        let mut live = self.live.clone();
        if !records.is_empty() && !live.contains(&holder) {
            live.push(holder);
        }
        Ok(Claimed { records, live })
    }

    fn release(&self, holder: HolderKey) -> Vec<HolderKey> {
        self.live
            .iter()
            .copied()
            .filter(|key| *key != holder)
            .collect()
    }
}

pub(super) fn answer(query: Query) -> Result<Reply, StreamError> {
    Ok(match query {
        Query::Covers { record, rule } => Reply::Bool(covers(&record, rule)),

        Query::Plan {
            state,
            rules,
            claimant,
        } => Reply::Plan(state.plan(&rules, claimant.as_ref())?),

        Query::Waiting { records, rule } => Reply::Record(records.iter().find_map(|record| {
            if record.outcome.is_none() && record.rule == Some(rule) && record.same_line {
                record.keys.first().copied()
            } else {
                None
            }
        })),
        Query::Answer {
            records,
            id,
            outcome,
        } => {
            if outcome == Answer::Ask {
                return Err(StreamError::new("ASK is the question, not an answer"));
            }
            Reply::Record(
                records
                    .iter()
                    .find(|record| record.id == id && record.outcome.is_none())
                    .map(|record| record.key),
            )
        }

        Query::Claim {
            state,
            holder,
            records,
        } => Reply::Claimed(state.claim_changes(holder, &records)?),

        Query::Split {
            state,
            holder,
            scope,
        } => {
            let mut copied = HashSet::new();
            let mut claims = Vec::new();
            for claim in state.claimed_by(&state.lineage(holder)?)? {
                if state.encloses(scope, claim.occurrence)? && copied.insert(claim.record) {
                    claims.push(claim.key);
                }
            }
            Reply::Claims(claims)
        }
        Query::HandUp { state, holder } => {
            let handed = state.holder(holder)?;
            let parent = handed.parent.ok_or_else(|| {
                StreamError::new("a typed line's claims are spent, not handed up")
            })?;
            let parent_claims = state.claimed_by(&[state.holder(parent)?])?;
            let known: HashSet<RecordKey> =
                parent_claims.iter().map(|claim| claim.record).collect();
            let claims: Vec<ClaimKey> = state
                .claimed_by(&[handed])?
                .iter()
                .filter(|claim| !known.contains(&claim.record))
                .map(|claim| claim.key)
                .collect();
            let mut live = state.release(holder);
            if (!parent_claims.is_empty() || !claims.is_empty()) && !live.contains(&parent) {
                live.push(parent);
            }
            Reply::HandedUp(HandedUp {
                parent,
                claims,
                live,
            })
        }
        Query::Revoke { state, holder } => {
            let others = state
                .live
                .iter()
                .copied()
                .filter(|key| *key != holder)
                .map(|key| state.holder(key))
                .collect::<Result<Vec<_>, _>>()?;
            let elsewhere: HashSet<RecordKey> = state
                .claimed_by(&others)?
                .iter()
                .map(|claim| claim.record)
                .collect();
            let spent = state
                .claimed_by(&[state.holder(holder)?])?
                .iter()
                .filter(|claim| !elsewhere.contains(&claim.record))
                .map(|claim| claim.record)
                .collect();
            Reply::Records(spent)
        }
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    fn ask(mut query: Value) -> Value {
        if let Some(state) = query.get_mut("state") {
            if state.get("sources").is_none() {
                state["sources"] = json!([[99, 97, 116]]);
            }
        }
        let request = serde_json::to_vec(&json!({"op": "approvals", "query": query})).unwrap();
        let (bytes, error) = crate::run("policy", "{}", &[&request]);
        assert!(error.is_none(), "{:?}", error.map(|error| error.message));
        serde_json::from_slice(&bytes).unwrap()
    }

    fn rule(reason: u32) -> Value {
        json!(reason)
    }

    fn record(key: usize, outcome: Value, scope: &str, reason: u32) -> Value {
        json!({"keys": [key], "rule": rule(reason), "same_line": true,
            "outcome": outcome, "scope": scope})
    }

    fn node(key: usize, parent: Value, start: usize, end: usize) -> Value {
        json!({"key": key, "parent": parent, "source": 0, "start": start, "end": end})
    }

    fn encloses(occurrences: Value, sources: Value, scope: usize, occurrence: usize) -> bool {
        let state: super::State =
            serde_json::from_value(json!({"occurrences": occurrences, "sources": sources}))
                .unwrap();
        state
            .encloses(
                super::OccurrenceKey(scope),
                super::OccurrenceKey(occurrence),
            )
            .unwrap()
    }

    fn plan(state: Value, rules: Value, claimant: Value) -> Value {
        ask(json!({"kind": "plan", "state": state, "rules": rules,
            "claimant": claimant}))
    }

    #[test]
    fn public_ids_do_not_identify_records_or_answer_all_questions() {
        let records = json!([
            {"key":10,"id":[1],"outcome":"allow"},
            {"key":11,"id":[1],"outcome":null},
            {"key":12,"id":[1],"outcome":null}
        ]);
        assert_eq!(
            ask(json!({"kind":"answer", "records":records,
            "id":[1], "outcome":"allow"})),
            11
        );
    }

    #[test]
    fn once_answers_take_priority_and_session_denials_stay_inert() {
        let records = json!([
            record(10, json!("allow"), "session", 1),
            record(11, json!("deny"), "once", 1),
            record(12, json!("deny"), "session", 2)
        ]);
        assert_eq!(
            plan(
                json!({"records":records}),
                json!([rule(1), rule(2)]),
                Value::Null
            ),
            json!({"answers":[11,null], "denied":0, "missing":[1], "once":[11], "waiting":[null,null], "claim":null})
        );
    }

    #[test]
    fn ordered_rule_candidates_preserve_waiting_and_claim_plans() {
        let records = vec![
            record(10, Value::Null, "once", 1),
            record(11, json!("allow"), "once", 9),
            record(12, json!("allow"), "once", 2),
            record(13, Value::Null, "once", 1),
            record(14, json!("allow"), "session", 8),
        ];
        let state = json!({
            "records": records,
            "holders":[{"key":0,"parent":null,"claims":[0]},
                {"key":1,"parent":null,"claims":[]}],
            "claims":[{"key":0,"record":11,"occurrence":0}], "live":[0],
            "occurrences":[node(0,Value::Null,0,1)]
        });
        let rules = json!([rule(1), rule(2)]);
        let claimant = json!({"holder":1,"occurrence":0});
        let expected = plan(state.clone(), rules.clone(), claimant.clone());
        assert_eq!(expected["waiting"], json!([10, null]));
        assert_eq!(expected["missing"], json!([0]));
        assert_eq!(expected["claim"], json!({"records":[12], "live":[0,1]}));

        let mut filtered = state;
        filtered["records"] = json!([records[0], records[2], records[3]]);
        assert_eq!(plan(filtered, rules, claimant), expected);
    }

    #[test]
    fn another_rule_key_does_not_cover() {
        let right = rule(2);
        assert_eq!(
            ask(
                json!({"kind":"covers", "record":record(1,json!("allow"),"once",1),
            "rule":right})
            ),
            false
        );
    }

    #[test]
    fn waiting_requires_the_rule_key_and_exact_line_fact() {
        let records = json!([
            record(10, Value::Null, "once", 1),
            record(11, Value::Null, "once", 2)
        ]);
        let query = json!({"kind":"waiting", "records":records, "rule":rule(2)});
        assert_eq!(ask(query.clone()), 11);
        let mut moved = query;
        moved["records"][1]["same_line"] = json!(false);
        assert_eq!(ask(moved), Value::Null);
    }

    #[test]
    fn claimed_record_is_hidden_except_at_its_structural_occurrence() {
        let state = json!({
            "records":[record(10,json!("allow"),"once",1),record(11,json!("allow"),"session",2)],
            "holders":[{"key":0,"parent":null,"claims":[0]}, {"key":1,"parent":0,"claims":[]}],
            "claims":[{"key":0,"record":10,"occurrence":0}],"live":[0],
            "occurrences":[node(0,Value::Null,1,2),node(1,Value::Null,1,2),node(2,Value::Null,2,3)]
        });
        let rules = json!([rule(1), rule(2)]);
        assert_eq!(
            plan(state.clone(), rules.clone(), Value::Null)["answers"],
            json!([null, 11])
        );
        assert_eq!(
            plan(
                state.clone(),
                rules.clone(),
                json!({"holder":1,"occurrence":1})
            )["answers"],
            json!([10, 11])
        );
        assert_eq!(
            plan(state, rules, json!({"holder":1,"occurrence":2}))["answers"],
            json!([null, 11])
        );
    }

    #[test]
    fn split_copies_each_record_once_and_last_holder_spends_it() {
        let state = json!({"records":[record(10,json!("allow"),"once",1)],
            "holders":[{"key":0,"parent":null,"claims":[0,1,2]}, {"key":1,"parent":null,"claims":[0]}],
            "claims":[{"key":0,"record":10,"occurrence":1}, {"key":1,"record":10,"occurrence":1},
                {"key":2,"record":11,"occurrence":2}], "live":[0,1],
            "occurrences":[node(0,Value::Null,0,3),node(1,Value::Null,1,2),node(2,Value::Null,4,5)]});
        assert_eq!(
            ask(json!({"kind":"split", "state":state, "holder":0,"scope":0})),
            json!([0])
        );
        assert_eq!(
            ask(json!({"kind":"revoke", "state":state, "holder":1})),
            json!([])
        );
        let mut last = state;
        last["live"] = json!([1]);
        assert_eq!(
            ask(json!({"kind":"revoke", "state":last, "holder":1})),
            json!([10])
        );
    }

    #[test]
    fn claims_handoff_and_release_preserve_existing_object_keys() {
        let state = json!({
            "holders":[{"key":0,"parent":null,"claims":[0]}, {"key":1,"parent":0,"claims":[1,2]}],
            "claims":[{"key":0,"record":10,"occurrence":0}, {"key":1,"record":10,"occurrence":0},
                {"key":2,"record":11,"occurrence":0}], "live":[1],
            "occurrences":[node(0,Value::Null,0,1)]});
        assert_eq!(
            ask(json!({"kind":"hand_up", "state":state, "holder":1})),
            json!({"parent":0,"claims":[2],"live":[0]})
        );
        assert_eq!(
            ask(json!({"kind":"claim", "state":state, "holder":0,"records":[10,11,11]})),
            json!({"records":[11,11],"live":[1,0]})
        );
    }

    #[test]
    fn flat_ancestry_exceeds_json_nesting_without_changing_structural_comparison() {
        let mut occurrences = Vec::new();
        for offset in [0, 400] {
            for i in 0..300 {
                occurrences.push(node(
                    offset + i,
                    if i == 0 {
                        Value::Null
                    } else {
                        json!(offset + i - 1)
                    },
                    i,
                    i + 1,
                ));
            }
        }
        let occurrences = json!(occurrences);
        assert!(encloses(
            occurrences.clone(),
            json!([[99, 97, 116]]),
            299,
            699
        ));
        assert!(encloses(occurrences, json!([[99, 97, 116]]), 0, 699));
    }

    #[test]
    fn source_pool_compares_values_across_distinct_keys() {
        let mut other = node(1, Value::Null, 1, 2);
        other["source"] = json!(1);
        let occurrences = json!([node(0, Value::Null, 0, 3), other]);
        assert!(encloses(
            occurrences.clone(),
            json!([[99, 97, 116], [99, 97, 116]]),
            0,
            1
        ));
        assert!(!encloses(occurrences, json!([[99, 97, 116], [100]]), 0, 1));
    }

    #[test]
    fn equal_requested_rule_keys_keep_each_position_and_record_identity() {
        let result = plan(
            json!({"records":[record(10,json!("allow"),"once",1),
                record(11,Value::Null,"once",2)]}),
            json!([rule(1), rule(2), rule(1)]),
            Value::Null,
        );
        assert_eq!(result["answers"], json!([10, null, 10]));
        assert_eq!(result["missing"], json!([1]));
        assert_eq!(result["waiting"], json!([null, 11, null]));
        assert_eq!(result["once"], json!([10, 10]));
    }

    #[test]
    fn a_batch_selects_the_first_visible_key_and_keeps_aliases() {
        let mut batch = record(10, json!("allow"), "once", 1);
        batch["keys"] = json!([10, 11, 10]);
        let result = plan(
            json!({"records":[batch],
                "holders":[{"key":0,"parent":null,"claims":[0]}],
                "claims":[{"key":0,"record":10,"occurrence":0}], "live":[0],
                "occurrences":[node(0,Value::Null,0,1)]}),
            json!([rule(1), rule(1)]),
            Value::Null,
        );
        assert_eq!(result["answers"], json!([11, 11]));
        assert_eq!(result["once"], json!([11, 11]));
    }

    #[test]
    fn invalid_answers_and_cyclic_host_graphs_are_refused() {
        let query = json!({"op":"approvals", "query":{"kind":"answer", "records":[],"id":[],"outcome":"ask"}});
        let (_, error) = crate::run("policy", "{}", &[&serde_json::to_vec(&query).unwrap()]);
        assert_eq!(error.unwrap().message, "ASK is the question, not an answer");
        let query = json!({"op":"approvals", "query":{"kind":"claim", "holder":0, "records":[],
            "state":{"holders":[{"key":0,"parent":0,"claims":[]}]}}});
        let (_, error) = crate::run("policy", "{}", &[&serde_json::to_vec(&query).unwrap()]);
        assert_eq!(error.unwrap().message, "cyclic approval holder lineage");
    }
}
