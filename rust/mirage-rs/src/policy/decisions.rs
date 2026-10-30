use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{Rule, Text};
use crate::{Stream, StreamError, parse_config};

const PACKET_BYTES: usize = 8 * 1024 * 1024;
const ENTRY_LIMIT: usize = 65536;
const AUTHORITY_FIELDS: &[&str] = &[
    "commands",
    "scripts",
    "profile",
    "mount_modes",
    "hidden_paths",
    "shown_paths",
    "hide_reasons",
    "hidden_vars",
    "processes",
    "command_limits",
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
struct Ticket(String);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(transparent)]
struct Owner(String);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(transparent)]
struct Holder(String);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(transparent)]
struct EvaluationId(String);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(transparent)]
struct TransitionId(String);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(transparent)]
struct Incarnation(String);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Allow,
    Deny,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Scope {
    #[default]
    Once,
    Session,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Record {
    id: Ticket,
    session_id: String,
    command: Text,
    argv: Vec<Text>,
    cwd: Text,
    paths: Vec<Text>,
    reason: Text,
    rule: Rule,
    #[serde(default)]
    outcome: Option<Outcome>,
    #[serde(default)]
    scope: Scope,
    #[serde(default)]
    note: Text,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Occurrence {
    parent: Option<Box<Occurrence>>,
    source: Text,
    start: u64,
    end: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Claimant {
    owner: Owner,
    holder: Holder,
    lineage: Vec<Holder>,
    occurrence: Occurrence,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Claim {
    owner: Owner,
    holder: Holder,
    decision: Ticket,
    occurrence: Occurrence,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ResultValue {
    Allow,
    Pending {
        record: Record,
        fresh: bool,
    },
    Deny {
        reason: Text,
    },
    Answered {
        record: Record,
    },
    Applied,
    Missing,
    Blocked {
        status: String,
    },
    Rebased {
        authority: serde_json::Map<String, serde_json::Value>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Receipt {
    id: TransitionId,
    revision: u64,
    digest: Vec<u8>,
    result: ResultValue,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Ledger {
    version: u32,
    incarnation: Incarnation,
    revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    closed: Option<String>,
    #[serde(default)]
    protected: bool,
    #[serde(default)]
    records: Vec<Record>,
    #[serde(default)]
    claims: Vec<Claim>,
    #[serde(default)]
    receipts: Vec<Receipt>,
    #[serde(default)]
    retired: Vec<Ticket>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Event {
    Resolve {
        question: Box<Record>,
        rules: Vec<Rule>,
        claimant: Option<Claimant>,
        #[serde(default)]
        explain: bool,
    },
    Answer {
        id: Ticket,
        outcome: Outcome,
        scope: Scope,
        note: Text,
        claimant: Option<Claimant>,
    },
    Release {
        owner: Owner,
        holder: Holder,
    },
    Revoke {
        owner: Owner,
        holder: Holder,
    },
    HandUp {
        owner: Owner,
        holder: Holder,
        parent: Holder,
    },
    Split {
        owner: Owner,
        lineage: Vec<Holder>,
        job: Holder,
        scope: Occurrence,
    },
    Recover {
        owner: Owner,
    },
    Invalidate,
    SessionWrite {
        baseline: serde_json::Map<String, serde_json::Value>,
        local: serde_json::Map<String, serde_json::Value>,
    },
    Reset {
        incarnation: Incarnation,
        closed: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    evaluation: EvaluationId,
    transition: TransitionId,
    ledger: Ledger,
    event: Event,
    #[serde(default)]
    facts: Option<Facts>,
    #[serde(default)]
    expected_incarnation: Option<Incarnation>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Facts {
    expected: serde_json::Value,
    current: serde_json::Value,
}

fn error(message: &str) -> StreamError {
    StreamError::new(format!("policy decisions: {message}"))
}

fn same_line(record: &Record, question: &Record) -> bool {
    record.command == question.command && record.argv == question.argv && record.cwd == question.cwd
}

fn covers(record: &Record, rule: &Rule, question: &Record) -> bool {
    record.rule == *rule
        && match (&record.outcome, &record.scope) {
            (Some(Outcome::Allow), Scope::Session) => true,
            (Some(_), Scope::Once) => same_line(record, question),
            _ => false,
        }
}

fn available(ledger: &Ledger, record: &Record, claimant: Option<&Claimant>) -> bool {
    let claims: Vec<_> = ledger
        .claims
        .iter()
        .filter(|c| c.decision == record.id)
        .collect();
    claims.is_empty()
        || claimant.is_some_and(|reader| {
            claims.iter().any(|c| {
                c.owner == reader.owner
                    && (c.holder == reader.holder || reader.lineage.contains(&c.holder))
                    && c.occurrence == reader.occurrence
            })
        })
}

fn settled(
    ledger: &Ledger,
    rule: &Rule,
    question: &Record,
    claimant: Option<&Claimant>,
) -> Option<Record> {
    for scope in [Scope::Once, Scope::Session] {
        if let Some(record) = ledger.records.iter().find(|r| {
            r.session_id == question.session_id
                && r.scope == scope
                && covers(r, rule, question)
                && available(ledger, r, claimant)
        }) {
            return Some(record.clone());
        }
    }
    None
}

fn claim(ledger: &mut Ledger, reader: &Claimant, record: &Record) {
    if !ledger.claims.iter().any(|c| {
        c.decision == record.id
            && c.owner == reader.owner
            && (c.holder == reader.holder || reader.lineage.contains(&c.holder))
    }) {
        ledger.claims.push(Claim {
            owner: reader.owner.clone(),
            holder: reader.holder.clone(),
            decision: record.id.clone(),
            occurrence: reader.occurrence.clone(),
        });
    }
}

fn encloses(scope: &Occurrence, occurrence: &Occurrence) -> bool {
    let mut within = Some(occurrence);
    while let Some(at) = within {
        if at.parent == scope.parent && at.source == scope.source {
            return scope.start <= at.start && at.end <= scope.end;
        }
        within = at.parent.as_deref();
    }
    false
}

fn retire(ledger: &mut Ledger, ids: &[Ticket]) {
    let removed: Vec<_> = ledger
        .records
        .iter()
        .filter(|r| ids.contains(&r.id) && !ledger.claims.iter().any(|c| c.decision == r.id))
        .map(|r| r.id.clone())
        .collect();
    ledger.records.retain(|r| !removed.contains(&r.id));
    ledger.retired.extend(removed);
}

fn invalidate(ledger: &mut Ledger) {
    ledger
        .retired
        .extend(ledger.records.iter().map(|r| r.id.clone()));
    ledger.records.clear();
    ledger.claims.clear();
}

fn apply(
    ledger: &mut Ledger,
    event: &Event,
    current_facts: Option<&serde_json::Value>,
) -> Result<ResultValue, StreamError> {
    match event {
        Event::Resolve {
            question,
            rules,
            claimant,
            explain,
        } => {
            if rules.is_empty() {
                return Err(error("a resolution requires at least one rule"));
            }
            let answered: Vec<_> = rules
                .iter()
                .map(|rule| settled(ledger, rule, question, claimant.as_ref()))
                .collect();
            if let Some(denied) = answered
                .iter()
                .flatten()
                .find(|r| r.outcome == Some(Outcome::Deny))
            {
                let reason = denied.reason.clone();
                if !explain {
                    let once: Vec<_> = answered
                        .iter()
                        .flatten()
                        .filter(|r| r.scope == Scope::Once)
                        .map(|r| r.id.clone())
                        .collect();
                    retire(ledger, &once);
                }
                return Ok(ResultValue::Deny { reason });
            }
            if let Some(index) = answered.iter().position(Option::is_none) {
                let rule = &rules[index];
                if let Some(record) = ledger.records.iter().find(|r| {
                    r.session_id == question.session_id
                        && r.outcome.is_none()
                        && r.rule == *rule
                        && same_line(r, question)
                }) {
                    return Ok(ResultValue::Pending {
                        record: record.clone(),
                        fresh: false,
                    });
                }
                let mut record = question.as_ref().clone();
                record.rule = rule.clone();
                record.reason = rule.reason.clone();
                record.outcome = None;
                record.scope = Scope::Once;
                record.note.clear();
                if !explain {
                    if ledger.records.iter().any(|r| r.id == record.id)
                        || ledger.retired.contains(&record.id)
                    {
                        return Err(error("request ticket already exists"));
                    }
                    ledger.records.push(record.clone());
                }
                return Ok(ResultValue::Pending {
                    record,
                    fresh: !explain,
                });
            }
            if !explain {
                let once: Vec<_> = answered
                    .into_iter()
                    .flatten()
                    .filter(|r| r.scope == Scope::Once)
                    .collect();
                if let Some(reader) = claimant {
                    for record in once {
                        claim(ledger, reader, &record);
                    }
                } else {
                    retire(ledger, &once.into_iter().map(|r| r.id).collect::<Vec<_>>());
                }
            }
            Ok(ResultValue::Allow)
        }
        Event::Answer {
            id,
            outcome,
            scope,
            note,
            claimant,
        } => {
            let Some(index) = ledger
                .records
                .iter()
                .position(|r| r.id == *id && r.outcome.is_none())
            else {
                return Ok(ResultValue::Missing);
            };
            let record = &mut ledger.records[index];
            record.outcome = Some(outcome.clone());
            record.scope = if *outcome == Outcome::Deny {
                Scope::Once
            } else {
                scope.clone()
            };
            record.note = note.clone();
            let record = record.clone();
            if record.outcome == Some(Outcome::Allow) && record.scope == Scope::Once {
                if let Some(reader) = claimant {
                    claim(ledger, reader, &record);
                }
            }
            Ok(ResultValue::Answered { record })
        }
        Event::Release { owner, holder } | Event::Revoke { owner, holder } => {
            let ids: Vec<_> = ledger
                .claims
                .iter()
                .filter(|c| c.owner == *owner && c.holder == *holder)
                .map(|c| c.decision.clone())
                .collect();
            ledger
                .claims
                .retain(|c| c.owner != *owner || c.holder != *holder);
            if matches!(event, Event::Revoke { .. }) {
                retire(ledger, &ids);
            }
            Ok(ResultValue::Applied)
        }
        Event::HandUp {
            owner,
            holder,
            parent,
        } => {
            if holder == parent {
                return Err(error("a holder cannot be its own parent"));
            }
            let claims: Vec<_> = ledger
                .claims
                .iter()
                .filter(|c| c.owner == *owner && c.holder == *holder)
                .cloned()
                .collect();
            for mut item in claims {
                if !ledger.claims.iter().any(|c| {
                    c.owner == *owner && c.holder == *parent && c.decision == item.decision
                }) {
                    item.holder = parent.clone();
                    ledger.claims.push(item);
                }
            }
            ledger
                .claims
                .retain(|c| c.owner != *owner || c.holder != *holder);
            Ok(ResultValue::Applied)
        }
        Event::Split {
            owner,
            lineage,
            job,
            scope,
        } => {
            let claims: Vec<_> = ledger
                .claims
                .iter()
                .filter(|c| {
                    c.owner == *owner
                        && lineage.contains(&c.holder)
                        && encloses(scope, &c.occurrence)
                })
                .cloned()
                .collect();
            for mut item in claims {
                if !ledger
                    .claims
                    .iter()
                    .any(|c| c.owner == *owner && c.holder == *job && c.decision == item.decision)
                {
                    item.holder = job.clone();
                    ledger.claims.push(item);
                }
            }
            Ok(ResultValue::Applied)
        }
        Event::Recover { owner } => {
            let ids: Vec<_> = ledger
                .claims
                .iter()
                .filter(|c| c.owner == *owner)
                .map(|c| c.decision.clone())
                .collect();
            ledger.claims.retain(|c| !ids.contains(&c.decision));
            retire(ledger, &ids);
            Ok(ResultValue::Applied)
        }
        Event::Invalidate => {
            invalidate(ledger);
            Ok(ResultValue::Applied)
        }
        Event::Reset {
            incarnation,
            closed,
        } => {
            if incarnation.0.is_empty() || *incarnation == ledger.incarnation {
                return Err(error("replacement requires a new incarnation"));
            }
            *ledger = Ledger {
                version: 1,
                incarnation: incarnation.clone(),
                revision: 0,
                closed: closed.clone(),
                protected: ledger.protected,
                records: Vec::new(),
                claims: Vec::new(),
                receipts: Vec::new(),
                retired: Vec::new(),
            };
            Ok(ResultValue::Applied)
        }
        Event::SessionWrite { baseline, local } => {
            let current = current_facts
                .and_then(serde_json::Value::as_object)
                .ok_or_else(|| error("session write requires current policy facts"))?;
            if baseline
                .keys()
                .chain(local.keys())
                .chain(current.keys())
                .any(|key| !AUTHORITY_FIELDS.contains(&key.as_str()))
            {
                return Err(error("unknown session authority field"));
            }
            let mut authority = serde_json::Map::new();
            for key in AUTHORITY_FIELDS {
                let previous = baseline.get(*key).unwrap_or(&serde_json::Value::Null);
                let proposed = local.get(*key).unwrap_or(&serde_json::Value::Null);
                let stored = current.get(*key).unwrap_or(&serde_json::Value::Null);
                authority.insert(
                    (*key).to_owned(),
                    if previous == proposed {
                        stored
                    } else {
                        proposed
                    }
                    .clone(),
                );
            }
            if AUTHORITY_FIELDS.iter().any(|key| {
                authority.get(*key) != Some(current.get(*key).unwrap_or(&serde_json::Value::Null))
            }) {
                invalidate(ledger);
            }
            Ok(ResultValue::Rebased { authority })
        }
    }
}

fn validate(ledger: &Ledger) -> Result<(), StreamError> {
    if ledger.version != 1 || ledger.incarnation.0.is_empty() {
        return Err(error("unsupported ledger incarnation or schema"));
    }
    if ledger.records.len() > ENTRY_LIMIT
        || ledger.claims.len() > ENTRY_LIMIT
        || ledger.receipts.len() >= ENTRY_LIMIT
        || ledger.retired.len() > ENTRY_LIMIT
    {
        return Err(error("ledger entry limit exceeded"));
    }
    let mut ids = std::collections::HashSet::new();
    for record in &ledger.records {
        if record.id.0.is_empty() || ledger.retired.contains(&record.id) || !ids.insert(&record.id)
        {
            return Err(error("duplicate or empty request ticket"));
        }
    }
    if ledger
        .claims
        .iter()
        .any(|c| !ids.contains(&c.decision) || c.owner.0.is_empty() || c.holder.0.is_empty())
    {
        return Err(error("invalid claim reference"));
    }
    Ok(())
}

enum State {
    Receiving(Vec<u8>),
    Waiting {
        evaluation: EvaluationId,
        transition: TransitionId,
        ledger: Box<Ledger>,
        result: ResultValue,
        delivered: bool,
    },
    Complete(ResultValue),
    Finished,
    Cancelled,
}

struct Decisions {
    state: State,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    evaluation: EvaluationId,
    effect: u32,
    transition: TransitionId,
    status: String,
    revision: u64,
}

impl Decisions {
    fn prepare(&mut self, bytes: &[u8]) -> Result<(), StreamError> {
        let Input {
            evaluation,
            transition,
            mut ledger,
            event,
            facts,
            expected_incarnation,
        } = serde_json::from_slice(bytes).map_err(|_| error("invalid event"))?;
        validate(&ledger)?;
        ledger.protected |=
            !ledger.records.is_empty() || !ledger.claims.is_empty() || !ledger.retired.is_empty();
        if matches!(&event, Event::Resolve { rules, explain: false, .. } if !rules.is_empty()) {
            ledger.protected = true;
        }
        if ledger.closed.is_some() && !matches!(event, Event::Reset { .. }) {
            self.state = State::Complete(ResultValue::Blocked {
                status: "session_closed".into(),
            });
            return Ok(());
        }
        if expected_incarnation.is_some_and(|expected| ledger.incarnation != expected) {
            self.state = State::Complete(ResultValue::Blocked {
                status: "stale_incarnation".into(),
            });
            return Ok(());
        }
        if matches!(event, Event::Resolve { .. })
            && facts
                .as_ref()
                .is_some_and(|facts| facts.expected != facts.current)
        {
            self.state = State::Complete(ResultValue::Blocked {
                status: "stale_facts".into(),
            });
            return Ok(());
        }
        if evaluation.0.is_empty() || transition.0.is_empty() {
            return Err(error("empty event identity"));
        }
        let digest =
            Sha256::digest(serde_json::to_vec(&event).map_err(|_| error("invalid event"))?)
                .to_vec();
        if let Some(receipt) = ledger.receipts.iter().find(|r| r.id == transition) {
            if receipt.digest != digest {
                return Err(error("transition identity reused for another event"));
            }
            self.state = if receipt.revision == ledger.revision {
                State::Waiting {
                    evaluation,
                    transition,
                    result: receipt.result.clone(),
                    ledger: Box::new(ledger),
                    delivered: false,
                }
            } else {
                State::Complete(ResultValue::Blocked {
                    status: "superseded".into(),
                })
            };
            return Ok(());
        }
        let result = apply(
            &mut ledger,
            &event,
            facts.as_ref().map(|facts| &facts.current),
        )?;
        if matches!(event, Event::Resolve { explain: true, .. }) {
            self.state = State::Complete(result);
            return Ok(());
        }
        ledger.revision = ledger
            .revision
            .checked_add(1)
            .ok_or_else(|| error("ledger revision exhausted"))?;
        ledger.receipts.push(Receipt {
            id: transition.clone(),
            revision: ledger.revision,
            digest,
            result: result.clone(),
        });
        validate(&ledger)?;
        if serde_json::to_vec(&ledger)
            .map_err(|_| error("invalid ledger"))?
            .len()
            > PACKET_BYTES / 2
        {
            return Err(error("ledger byte limit exceeded"));
        }
        self.state = State::Waiting {
            evaluation,
            transition,
            ledger: Box::new(ledger),
            result,
            delivered: false,
        };
        Ok(())
    }
}

impl Stream for Decisions {
    fn feed(&mut self, input: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        match &mut self.state {
            State::Receiving(bytes) if bytes.len().saturating_add(input.len()) <= PACKET_BYTES => {
                bytes.extend_from_slice(input);
                Ok(())
            }
            _ => {
                self.state = State::Cancelled;
                Err(error("input is closed or exceeds its bound"))
            }
        }
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let state = std::mem::replace(&mut self.state, State::Cancelled);
        match state {
            State::Receiving(bytes) => self.prepare(&bytes),
            State::Complete(result) => {
                serde_json::to_writer(out, &result).map_err(|_| error("invalid result"))?;
                self.state = State::Finished;
                Ok(())
            }
            _ => Err(error("cannot finish a waiting or closed transition")),
        }
    }

    fn request(&mut self, _: &mut Vec<u8>) -> Option<Vec<u8>> {
        let State::Waiting {
            evaluation,
            transition,
            ledger,
            delivered,
            result,
        } = &mut self.state
        else {
            return None;
        };
        if *delivered {
            return None;
        }
        *delivered = true;
        let authority = match result {
            ResultValue::Rebased { authority } => Some(authority),
            _ => None,
        };
        Some(
            serde_json::to_vec(&serde_json::json!({
                "op":"persist_approvals", "evaluation":evaluation, "effect":1,
                "transition":transition, "ledger":ledger, "authority":authority,
                "approval_required":ledger.protected
            }))
            .expect("serializable policy state"),
        )
    }

    fn respond(&mut self, reply: &[u8], data: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        let state = std::mem::replace(&mut self.state, State::Cancelled);
        if reply.len() > PACKET_BYTES {
            return Err(error("storage reply exceeds its bound"));
        }
        let State::Waiting {
            evaluation,
            transition,
            ledger,
            result,
            delivered: true,
        } = state
        else {
            return Err(error("no delivered storage effect"));
        };
        let response: Response =
            serde_json::from_slice(reply).map_err(|_| error("invalid storage reply"))?;
        if !data.is_empty()
            || response.evaluation != evaluation
            || response.effect != 1
            || response.transition != transition
        {
            return Err(error("stale storage reply"));
        }
        self.state = match response.status.as_str() {
            "committed" if response.revision == ledger.revision => State::Complete(result),
            "conflict" | "unknown" | "not_committed" => State::Complete(ResultValue::Blocked {
                status: response.status,
            }),
            _ => return Err(error("invalid storage acknowledgement")),
        };
        Ok(())
    }

    fn cancel(&mut self) -> bool {
        self.state = State::Cancelled;
        true
    }

    fn done(&self) -> bool {
        matches!(
            self.state,
            State::Complete(_) | State::Finished | State::Cancelled
        )
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let _: Config = parse_config(config)?;
    Ok(Box::new(Decisions {
        state: State::Receiving(Vec::new()),
    }))
}

#[cfg(test)]
mod tests;
