use std::collections::{HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::Text;
use crate::{Stream, StreamError, parse_config};

const PACKET_BYTES: usize = 8 * 1024 * 1024;
const EVALUATION_BYTES: usize = 32 * 1024 * 1024;
const ENTRY_LIMIT: usize = 65536;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Hook {
    PreCommand,
    PostCommand,
    PreExecute,
    PostExecute,
    PreVfs,
    PostVfs,
    PreSession,
    PostSession,
}

impl Hook {
    fn legal(self) -> Vec<&'static str> {
        match self {
            Self::PreExecute => vec!["ask", "deny", "route"],
            Self::PostExecute => vec!["ask", "deny", "limit"],
            _ => vec!["ask", "deny"],
        }
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Role {
    Registered,
    Permissions,
    Placement,
    MountMode,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    slot: u32,
    role: Role,
    hooks: Vec<Hook>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Input {
    Evaluate {
        evaluation: String,
        hook: Hook,
        #[serde(default)]
        every: bool,
        #[serde(default)]
        placed: bool,
        #[serde(default)]
        rules_only: bool,
        policies: Vec<Policy>,
        #[serde(default)]
        projection: Projection,
    },
    Settle {
        mode: SettleMode,
        evaluation: String,
        count: usize,
    },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SettleMode {
    Settled,
    Agreed,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Projection {
    Answers,
    #[default]
    Fire,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    evaluation: String,
    effect: u32,
    #[serde(default)]
    actions: Vec<Value>,
    #[serde(default)]
    more: bool,
    #[serde(default)]
    first_rules: Vec<u32>,
    #[serde(default)]
    next_rules: Vec<u32>,
    #[serde(default)]
    same_ask: bool,
    #[serde(default)]
    routes: Vec<RouteValue>,
    #[serde(default)]
    limits: Vec<LimitValue>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteValue {
    action: u32,
    runtime: Text,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LimitValue {
    action: u32,
    value: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Action {
    kind: String,
    action: u32,
}

#[derive(Default, Serialize)]
struct ResultValue {
    answers: Vec<u32>,
    action: Option<u32>,
    ask_rules: Option<Vec<u32>>,
    route: Option<u32>,
    conflict: Vec<u32>,
    limit: Option<Map<String, Value>>,
    invalid: Option<Invalid>,
}

#[derive(Serialize)]
struct Invalid {
    action: u32,
    slot: u32,
    legal: Vec<&'static str>,
}

#[derive(Default)]
struct Fold {
    answers: Vec<u32>,
    deny: Option<u32>,
    ask: Option<u32>,
    action_count: usize,
    seen_actions: HashSet<u32>,
    routes: Vec<u32>,
    limits: Vec<u32>,
    invalid: Option<Invalid>,
}

impl Fold {
    fn add(&mut self, action: &Action) -> Result<(), StreamError> {
        self.action_count += 1;
        if self.action_count > ENTRY_LIMIT {
            return Err(error("too many actions"));
        }
        if !self.seen_actions.insert(action.action) {
            return Err(error("duplicate action reference"));
        }
        match action.kind.as_str() {
            "deny" => {
                self.answers.push(action.action);
                self.deny.get_or_insert(action.action);
            }
            "ask" => {
                self.answers.push(action.action);
                self.ask.get_or_insert(action.action);
            }
            "route" => {
                self.answers.push(action.action);
                self.routes.push(action.action);
            }
            "limit" => self.limits.push(action.action),
            _ => return Err(error("invalid settlement action")),
        }
        Ok(())
    }

    fn result(&mut self) -> ResultValue {
        ResultValue {
            answers: std::mem::take(&mut self.answers),
            action: self.deny.or(self.ask),
            invalid: self.invalid.take(),
            ..ResultValue::default()
        }
    }
}

fn merge_limit(
    into: &mut Map<String, Value>,
    values: Map<String, Value>,
) -> Result<(), StreamError> {
    for (field, value) in values {
        let valid = match field.as_str() {
            "max_bytes" | "max_lines" => value.is_null() || integer(&value, false).is_some(),
            "timeout_seconds" => {
                value.is_null() || value.as_f64().is_some_and(|v| v >= 0.0 && v.is_finite())
            }
            "walk_limit" => value.is_null() || integer(&value, true).is_some(),
            "on_exceed" => value == "error" || value == "truncate",
            _ => false,
        };
        if !valid {
            return Err(error("invalid limit field"));
        }
        let value = if field == "timeout_seconds" && value.as_f64() == Some(0.0) {
            Value::Null
        } else {
            value
        };
        let old = into.get(&field).cloned().unwrap_or(Value::Null);
        let merged = if field == "on_exceed" {
            if old == "error" || value == "error" {
                Value::from("error")
            } else {
                Value::from("truncate")
            }
        } else if value.is_null() {
            old
        } else if old.is_null() {
            value
        } else if field == "timeout_seconds" {
            let a = old.as_f64().unwrap();
            let b = value.as_f64().unwrap();
            if a == 0.0 || (b > 0.0 && b < a) {
                value
            } else {
                old
            }
        } else {
            let walk = field == "walk_limit";
            let a = integer(&old, walk).unwrap();
            let b = integer(&value, walk).unwrap();
            if a == "-1" || (b != "-1" && (b.len(), &b) < (a.len(), &a)) {
                value
            } else {
                old
            }
        };
        into.insert(field, merged);
    }
    Ok(())
}

fn integer(value: &Value, walk: bool) -> Option<String> {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Number(number) if number.as_u64().is_some() => number.to_string(),
        Value::Number(number) if walk && number.as_i64() == Some(-1) => "-1".to_owned(),
        _ => return None,
    };
    if text == "0"
        || (walk && text == "-1")
        || (!text.starts_with('0')
            && !text.is_empty()
            && text.bytes().all(|byte| byte.is_ascii_digit()))
    {
        Some(text)
    } else {
        None
    }
}

enum Pending {
    Policy { slot: u32, read: bool },
    Ask { first: u32, next: u32 },
    Replace { first: u32, rules: Vec<u32> },
    Final { routes: Vec<u32>, limits: Vec<u32> },
    Settlement { index: usize },
}

struct Evaluation {
    token: String,
    hook: Option<Hook>,
    every: bool,
    placed: bool,
    projection: Projection,
    settle: Option<SettleMode>,
    settlement_count: usize,
    settlement_index: usize,
    slots: VecDeque<u32>,
    effect: u32,
    delivered: bool,
    continuing: bool,
    queued: VecDeque<Value>,
    pending: Option<Pending>,
    fold: Fold,
}

impl Evaluation {
    fn advance(&mut self) -> Result<Option<ResultValue>, StreamError> {
        while let Some(value) = self.queued.pop_front() {
            let action: Action =
                serde_json::from_value(value).map_err(|_| error("invalid action descriptor"))?;
            if let Some(hook) = self.hook {
                let legal = hook.legal();
                if !legal.contains(&action.kind.as_str()) {
                    self.fold.invalid = Some(Invalid {
                        action: action.action,
                        slot: *self.slots.front().ok_or_else(|| error("no policy slot"))?,
                        legal,
                    });
                    return Ok(Some(self.fold.result()));
                }
            }
            let first = self.fold.ask;
            self.fold.add(&action)?;
            if action.kind == "deny" && (!self.every || self.settle.is_some()) {
                return Ok(Some(self.fold.result()));
            }
            if action.kind == "ask" && self.settle.is_none() {
                if let Some(first) = first {
                    self.pending = Some(Pending::Ask {
                        first,
                        next: action.action,
                    });
                    return Ok(None);
                }
            }
        }
        if self.settle.is_some() && self.settlement_index < self.settlement_count {
            self.pending = Some(Pending::Settlement {
                index: self.settlement_index,
            });
            return Ok(None);
        }
        if self.settle.is_none() {
            if !self.continuing {
                self.slots.pop_front();
            }
            if let Some(slot) = self.slots.front() {
                self.pending = Some(Pending::Policy {
                    slot: *slot,
                    read: self.continuing,
                });
                return Ok(None);
            }
        }
        let settled_ask =
            matches!(self.settle, Some(SettleMode::Settled)) && self.fold.ask.is_some();
        let routes = if self.fold.deny.is_none()
            && !settled_ask
            && !self.placed
            && (self.settle.is_some() || self.projection == Projection::Fire)
        {
            self.fold.routes.clone()
        } else {
            Vec::new()
        };
        let limits = if self.fold.deny.is_none()
            && self.projection == Projection::Fire
            && self.hook == Some(Hook::PostExecute)
        {
            self.fold.limits.clone()
        } else {
            Vec::new()
        };
        if routes.is_empty() && limits.is_empty() {
            Ok(Some(self.fold.result()))
        } else {
            self.pending = Some(Pending::Final { routes, limits });
            Ok(None)
        }
    }
}

enum State {
    Receiving(Vec<u8>),
    Running(Evaluation),
    Complete(ResultValue),
    Finished,
    Cancelled,
}

struct Composition {
    state: State,
    bytes: usize,
}

fn error(message: &str) -> StreamError {
    StreamError::new(format!("policy composition: {message}"))
}

impl Composition {
    fn fail(&mut self, message: &str) -> StreamError {
        self.state = State::Cancelled;
        error(message)
    }

    fn account(&mut self, bytes: usize) -> Result<(), StreamError> {
        self.bytes = self.bytes.saturating_add(bytes);
        if bytes > PACKET_BYTES || self.bytes > EVALUATION_BYTES {
            return Err(self.fail("evaluation byte limit exceeded"));
        }
        Ok(())
    }

    fn start(&mut self, data: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        let input: Input =
            serde_json::from_slice(data).map_err(|_| error("invalid initial request"))?;
        match input {
            Input::Evaluate {
                evaluation,
                hook,
                every,
                placed,
                rules_only,
                policies,
                projection,
            } => {
                if evaluation.is_empty() || !evaluation.is_ascii() || evaluation.len() > 128 {
                    return Err(error("invalid evaluation identity"));
                }
                if policies.len() > ENTRY_LIMIT {
                    return Err(error("too many policies"));
                }
                let mut seen = HashSet::new();
                let mut placement = VecDeque::new();
                let mut registered = VecDeque::new();
                let mut mode = VecDeque::new();
                for policy in policies {
                    if !seen.insert(policy.slot) {
                        return Err(error("duplicate policy slot"));
                    }
                    if !policy.hooks.contains(&hook) {
                        continue;
                    }
                    match policy.role {
                        Role::Placement if hook == Hook::PreExecute && !placed => {
                            placement.push_back(policy.slot)
                        }
                        Role::MountMode if hook == Hook::PreVfs => mode.push_back(policy.slot),
                        Role::Permissions => registered.push_back(policy.slot),
                        Role::Registered if !rules_only => registered.push_back(policy.slot),
                        _ => (),
                    }
                }
                placement.append(&mut registered);
                placement.append(&mut mode);
                let mut evaluation = Evaluation {
                    token: evaluation,
                    hook: Some(hook),
                    every,
                    projection,
                    settle: None,
                    settlement_count: 0,
                    settlement_index: 0,
                    placed,
                    pending: placement.front().map(|slot| Pending::Policy {
                        slot: *slot,
                        read: false,
                    }),
                    slots: placement,
                    queued: VecDeque::new(),
                    effect: 1,
                    delivered: false,
                    continuing: false,
                    fold: Fold::default(),
                };
                self.state = if evaluation.slots.is_empty() {
                    State::Complete(evaluation.fold.result())
                } else {
                    State::Running(evaluation)
                };
                Ok(())
            }
            Input::Settle {
                mode,
                evaluation,
                count,
            } => {
                if evaluation.is_empty()
                    || !evaluation.is_ascii()
                    || evaluation.len() > 128
                    || count > ENTRY_LIMIT
                {
                    return Err(error("invalid settlement request"));
                }
                let agreed = matches!(mode, SettleMode::Agreed);
                let mut evaluation = Evaluation {
                    token: evaluation,
                    hook: None,
                    every: false,
                    placed: false,
                    projection: Projection::Fire,
                    settle: Some(mode),
                    settlement_count: count,
                    settlement_index: if agreed { count } else { 0 },
                    slots: VecDeque::new(),
                    effect: 1,
                    delivered: false,
                    continuing: false,
                    queued: VecDeque::new(),
                    pending: None,
                    fold: Fold::default(),
                };
                if agreed {
                    evaluation.fold.routes = (0..count as u32).collect();
                }
                self.state = match evaluation.advance()? {
                    Some(result) => State::Complete(result),
                    None => State::Running(evaluation),
                };
                Ok(())
            }
        }
    }

    fn emit(&mut self, result: ResultValue, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let encoded = serde_json::to_vec(&result).map_err(|_| error("cannot encode result"))?;
        if encoded.len() > PACKET_BYTES {
            return Err(error("result byte limit exceeded"));
        }
        out.extend_from_slice(&encoded);
        self.state = State::Finished;
        Ok(())
    }

    fn answer(&mut self, reply: &[u8], data: &[u8]) -> Result<(), StreamError> {
        if !data.is_empty() {
            return Err(error("unexpected response data"));
        }
        self.account(reply.len())?;
        let response: Response =
            serde_json::from_slice(reply).map_err(|_| error("invalid response"))?;
        let State::Running(evaluation) = &mut self.state else {
            return Err(error("no pending effect"));
        };
        if !evaluation.delivered
            || evaluation.token != response.evaluation
            || evaluation.effect != response.effect
        {
            return Err(error("response does not match pending effect"));
        }
        let pending = evaluation
            .pending
            .take()
            .ok_or_else(|| error("no pending effect"))?;
        let fields: Map<String, Value> =
            serde_json::from_slice(reply).map_err(|_| error("invalid response"))?;
        let allowed: &[&str] = match &pending {
            Pending::Policy { .. } => &["actions", "more"],
            Pending::Settlement { .. } => &["actions"],
            Pending::Ask { .. } => &["first_rules", "next_rules", "same_ask"],
            Pending::Replace { .. } => &[],
            Pending::Final { .. } => &["routes", "limits"],
        };
        if fields
            .keys()
            .any(|key| key != "evaluation" && key != "effect" && !allowed.contains(&key.as_str()))
            || allowed
                .iter()
                .any(|key| *key != "more" && !fields.contains_key(*key))
        {
            return Err(error("response fields do not match pending effect"));
        }
        let result = match pending {
            Pending::Policy { .. } => {
                if response.actions.len() > ENTRY_LIMIT {
                    return Err(error("too many response actions"));
                }
                evaluation.queued = response.actions.into();
                evaluation.continuing = response.more;
                evaluation.advance()?
            }
            Pending::Settlement { index } => {
                if response.more || response.actions.len() != 1 {
                    return Err(error("invalid settlement response"));
                }
                let action: Action = serde_json::from_value(response.actions[0].clone())
                    .map_err(|_| error("invalid settlement action"))?;
                if action.action != index as u32
                    || !["deny", "ask", "route"].contains(&action.kind.as_str())
                {
                    return Err(error("invalid settlement action"));
                }
                evaluation.settlement_index += 1;
                evaluation.queued = response.actions.into();
                evaluation.advance()?
            }
            Pending::Ask { first, .. } => {
                if response
                    .first_rules
                    .len()
                    .saturating_add(response.next_rules.len())
                    > ENTRY_LIMIT
                {
                    return Err(error("too many rule references"));
                }
                if response.same_ask {
                    evaluation.advance()?
                } else {
                    let mut seen = HashSet::new();
                    let rules = response
                        .first_rules
                        .into_iter()
                        .chain(response.next_rules)
                        .filter(|rule| seen.insert(*rule))
                        .collect();
                    evaluation.pending = Some(Pending::Replace { first, rules });
                    None
                }
            }
            Pending::Replace { .. } => evaluation.advance()?,
            Pending::Final { routes, limits } => {
                if routes
                    .iter()
                    .copied()
                    .ne(response.routes.iter().map(|r| r.action))
                    || limits
                        .iter()
                        .copied()
                        .ne(response.limits.iter().map(|l| l.action))
                {
                    return Err(error("materialized references do not match request"));
                }
                let mut result = evaluation.fold.result();
                for route in &response.routes {
                    if route.runtime.iter().any(|point| *point > 0x10ffff) {
                        return Err(error("invalid route text"));
                    }
                }
                if let Some(first) = response.routes.first() {
                    if response
                        .routes
                        .iter()
                        .any(|route| route.runtime != first.runtime)
                    {
                        result.conflict = routes;
                        result.action = None;
                    } else {
                        result.route = Some(first.action);
                        if evaluation.settle.is_some() {
                            result.action = Some(first.action);
                        }
                    }
                }
                for limit in response.limits {
                    merge_limit(result.limit.get_or_insert_with(Map::new), limit.value)?;
                }
                Some(result)
            }
        };
        evaluation.effect = evaluation
            .effect
            .checked_add(1)
            .ok_or_else(|| error("too many effects"))?;
        evaluation.delivered = false;
        if let Some(result) = result {
            self.state = State::Complete(result);
        }
        Ok(())
    }
}

impl Stream for Composition {
    fn feed(&mut self, input: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        self.account(input.len())?;
        match &mut self.state {
            State::Receiving(bytes) if bytes.len().saturating_add(input.len()) <= PACKET_BYTES => {
                bytes.extend_from_slice(input);
                Ok(())
            }
            State::Receiving(_) => Err(self.fail("initial packet byte limit exceeded")),
            _ => Err(self.fail("input already received")),
        }
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let state = std::mem::replace(&mut self.state, State::Cancelled);
        match state {
            State::Receiving(bytes) => self.start(&bytes, out),
            State::Complete(result) => self.emit(result, out),
            State::Running(_) => Err(error("evaluation is waiting for a response")),
            State::Finished => Err(error("result already emitted")),
            State::Cancelled => Err(error("evaluation is cancelled")),
        }
    }

    fn request(&mut self, _: &mut Vec<u8>) -> Option<Vec<u8>> {
        let State::Running(evaluation) = &mut self.state else {
            return None;
        };
        if evaluation.delivered {
            return None;
        }
        let mut request = match evaluation.pending.as_ref()? {
            Pending::Policy { slot, read } => {
                serde_json::json!({"op":if *read {"read_action"} else {"run_policy"},"slot":slot})
            }
            Pending::Ask { first, next } => {
                serde_json::json!({"op":"read_ask_rules","first":first,"next":next})
            }
            Pending::Replace { first, rules } => {
                serde_json::json!({"op":"replace_ask_rules","action":first,"rules":rules})
            }
            Pending::Final { routes, limits } => {
                serde_json::json!({"op":"read_final_values","routes":routes,"limits":limits})
            }
            Pending::Settlement { index } => {
                serde_json::json!({"op":"read_settlement_action","slot":index})
            }
        };
        request["evaluation"] = Value::from(evaluation.token.clone());
        request["effect"] = Value::from(evaluation.effect);
        evaluation.delivered = true;
        Some(serde_json::to_vec(&request).expect("effect contains serializable values"))
    }

    fn respond(&mut self, reply: &[u8], data: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        match self.answer(reply, data) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.state = State::Cancelled;
                Err(error)
            }
        }
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
    Ok(Box::new(Composition {
        state: State::Receiving(Vec::new()),
        bytes: 0,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn stream(input: Value) -> Box<dyn Stream> {
        let mut stream = open(b"{}").unwrap();
        stream
            .feed(&serde_json::to_vec(&input).unwrap(), &mut Vec::new())
            .unwrap();
        stream.finish(&mut Vec::new()).unwrap();
        stream
    }

    fn initial() -> Value {
        json!({"op":"evaluate", "evaluation":"a", "hook":"pre_command", "policies":[
            {"slot":0,"role":"registered","hooks":["pre_command"]},
            {"slot":1,"role":"registered","hooks":["pre_command"]}
        ]})
    }

    fn response(effect: u32, actions: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({"evaluation":"a", "effect":effect,"actions":actions})).unwrap()
    }

    #[test]
    fn shared_transcripts() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../../../integ/policy/composition.json"))
                .unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            let name = &case["name"];
            let mut engine = open(b"{}").unwrap();
            let input = serde_json::to_vec(&case["input"]).unwrap();
            for chunk in input.chunks(7) {
                engine.feed(chunk, &mut Vec::new()).unwrap();
            }
            let mut out = Vec::new();
            engine.finish(&mut out).unwrap();
            for (i, effect) in case["effects"].as_array().unwrap().iter().enumerate() {
                let request: Value =
                    serde_json::from_slice(&engine.request(&mut Vec::new()).unwrap()).unwrap();
                let mut expected_request = effect["request"].clone();
                expected_request["effect"] = json!(i + 1);
                expected_request["evaluation"] = case["input"]["evaluation"].clone();
                assert_eq!(request, expected_request, "{name}");
                assert!(engine.request(&mut Vec::new()).is_none());
                let mut reply = effect["reply"].clone();
                reply["evaluation"] = request["evaluation"].clone();
                reply["effect"] = request["effect"].clone();
                engine
                    .respond(&serde_json::to_vec(&reply).unwrap(), &[], &mut out)
                    .unwrap();
            }
            assert!(engine.request(&mut Vec::new()).is_none(), "{name}");
            {
                assert!(out.is_empty(), "{name}");
                assert!(engine.done(), "{name}");
                engine.finish(&mut out).unwrap();
            }
            assert_eq!(
                serde_json::from_slice::<Value>(&out).unwrap(),
                case["expected"],
                "{name}"
            );
        }
    }

    #[test]
    fn response_requires_delivery_and_matching_identities() {
        for (delivered, token, effect) in [(false, "a", 1), (true, "other", 1), (true, "a", 2)] {
            let mut engine = stream(initial());
            if delivered {
                engine.request(&mut Vec::new()).unwrap();
            }
            let reply =
                serde_json::to_vec(&json!({"evaluation":token,"effect":effect,"actions":[]}))
                    .unwrap();
            assert!(engine.respond(&reply, &[], &mut Vec::new()).is_err());
            assert!(engine.done());
            assert!(engine.request(&mut Vec::new()).is_none());
            assert!(engine.finish(&mut Vec::new()).is_err());
        }
    }

    #[test]
    fn duplicate_response_cannot_advance_next_policy() {
        let mut engine = stream(initial());
        engine.request(&mut Vec::new()).unwrap();
        let reply = response(1, json!([]));
        engine.respond(&reply, &[], &mut Vec::new()).unwrap();
        engine.request(&mut Vec::new()).unwrap();
        assert!(engine.respond(&reply, &[], &mut Vec::new()).is_err());
        assert!(engine.request(&mut Vec::new()).is_none());
    }

    #[test]
    fn waiting_finish_and_cancel_never_authorize() {
        let mut engine = stream(initial());
        assert!(!engine.done());
        assert!(!engine.busy());
        assert!(engine.finish(&mut Vec::new()).is_err());
        assert!(engine.request(&mut Vec::new()).is_none());
        let mut engine = stream(initial());
        engine.request(&mut Vec::new()).unwrap();
        assert!(engine.cancel());
        assert!(engine.cancel());
        assert!(engine.done());
        assert!(
            engine
                .respond(&response(1, json!([])), &[], &mut Vec::new())
                .is_err()
        );
        assert!(engine.finish(&mut Vec::new()).is_err());
    }

    #[test]
    fn streams_do_not_share_continuations() {
        let mut a = stream(initial());
        let mut input = initial();
        input["evaluation"] = json!("b");
        let mut b = stream(input);
        let request = a.request(&mut Vec::new()).unwrap();
        b.request(&mut Vec::new()).unwrap();
        let mut reply: Value = serde_json::from_slice(&request).unwrap();
        reply.as_object_mut().unwrap().remove("op");
        reply.as_object_mut().unwrap().remove("slot");
        reply["actions"] = json!([]);
        assert!(
            b.respond(&serde_json::to_vec(&reply).unwrap(), &[], &mut Vec::new())
                .is_err()
        );
        a.respond(&response(1, json!([])), &[], &mut Vec::new())
            .unwrap();
        let next: Value = serde_json::from_slice(&a.request(&mut Vec::new()).unwrap()).unwrap();
        assert_eq!(next["slot"], 1);
    }

    #[test]
    fn packet_and_entry_bounds_refuse_and_release() {
        let mut engine = open(b"{}").unwrap();
        engine
            .feed(&vec![b' '; PACKET_BYTES], &mut Vec::new())
            .unwrap();
        assert!(engine.feed(b" ", &mut Vec::new()).is_err());
        assert!(engine.done());
        let mut engine = stream(initial());
        engine.request(&mut Vec::new()).unwrap();
        assert!(
            engine
                .respond(&vec![b' '; PACKET_BYTES + 1], &[], &mut Vec::new())
                .is_err()
        );
        assert!(engine.done());
        let mut engine = stream(initial());
        engine.request(&mut Vec::new()).unwrap();
        let actions = vec![json!({"kind":"ask","action":0}); ENTRY_LIMIT + 1];
        assert!(
            engine
                .respond(&response(1, json!(actions)), &[], &mut Vec::new())
                .is_err()
        );
        assert!(engine.done());
        let mut engine = stream(initial());
        engine.request(&mut Vec::new()).unwrap();
        engine
            .respond(
                &response(
                    1,
                    json!([{"kind":"ask","action":0},{"kind":"ask","action":1}]),
                ),
                &[],
                &mut Vec::new(),
            )
            .unwrap();
        engine.request(&mut Vec::new()).unwrap();
        let rules = vec![0; ENTRY_LIMIT + 1];
        assert!(
            engine
                .respond(
                    &serde_json::to_vec(&json!({"evaluation":"a","effect":2,"first_rules":rules,"next_rules":[],"same_ask":false}))
                        .unwrap(),
                    &[],
                    &mut Vec::new()
                )
                .is_err()
        );
    }

    #[test]
    fn materialized_rule_batch_accepts_boundary_and_refuses_combined_overflow() {
        for next_rules in [vec![], vec![ENTRY_LIMIT as u32]] {
            let mut engine = stream(initial());
            engine.request(&mut Vec::new()).unwrap();
            engine
                .respond(
                    &response(
                        1,
                        json!([{"kind":"ask","action":0},{"kind":"ask","action":1}]),
                    ),
                    &[],
                    &mut Vec::new(),
                )
                .unwrap();
            engine.request(&mut Vec::new()).unwrap();
            let reply = json!({
                "evaluation":"a", "effect":2,
                "first_rules":(0..ENTRY_LIMIT as u32).collect::<Vec<_>>(),
                "next_rules":next_rules, "same_ask":false
            });
            let result = engine.respond(&serde_json::to_vec(&reply).unwrap(), &[], &mut Vec::new());
            if next_rules.is_empty() {
                result.unwrap();
                let request: Value =
                    serde_json::from_slice(&engine.request(&mut Vec::new()).unwrap()).unwrap();
                assert_eq!(request["op"], "replace_ask_rules");
                assert_eq!(request["rules"].as_array().unwrap().len(), ENTRY_LIMIT);
            } else {
                assert_eq!(
                    result.unwrap_err().message,
                    "policy composition: too many rule references"
                );
                assert!(engine.done());
            }
        }
    }

    #[test]
    fn entry_limits_include_exact_boundary_and_cumulative_replies() {
        let mut input = initial();
        input["policies"] = json!(
            (0..ENTRY_LIMIT)
                .map(|slot| json!({
                    "slot":slot,"role":"registered","hooks":[]
                }))
                .collect::<Vec<_>>()
        );
        let mut engine = stream(input.clone());
        assert!(engine.done());
        let mut out = Vec::new();
        engine.finish(&mut out).unwrap();
        input["policies"].as_array_mut().unwrap().push(json!({
            "slot":ENTRY_LIMIT,"role":"registered","hooks":[]
        }));
        let mut engine = open(b"{}").unwrap();
        engine
            .feed(&serde_json::to_vec(&input).unwrap(), &mut Vec::new())
            .unwrap();
        assert!(engine.finish(&mut Vec::new()).is_err());
        assert!(engine.done());

        let mut input = initial();
        input["every"] = json!(true);
        let mut engine = stream(input);
        engine.request(&mut Vec::new()).unwrap();
        let actions = (0..ENTRY_LIMIT)
            .map(|i| json!({"kind":"deny","action":i}))
            .collect::<Vec<_>>();
        engine
            .respond(&response(1, json!(actions)), &[], &mut Vec::new())
            .unwrap();
        engine.request(&mut Vec::new()).unwrap();
        assert!(
            engine
                .respond(
                    &response(2, json!([{"kind":"deny","action":65536}])),
                    &[],
                    &mut Vec::new()
                )
                .is_err()
        );
        assert!(engine.done());
    }

    #[test]
    fn duplicate_actions_and_materialized_reference_mismatches_poison() {
        let mut input = initial();
        input["every"] = json!(true);
        let mut engine = stream(input);
        engine.request(&mut Vec::new()).unwrap();
        engine
            .respond(
                &response(1, json!([{"kind":"ask","action":0}])),
                &[],
                &mut Vec::new(),
            )
            .unwrap();
        engine.request(&mut Vec::new()).unwrap();
        assert!(
            engine
                .respond(
                    &response(2, json!([{"kind":"ask","action":0}])),
                    &[],
                    &mut Vec::new()
                )
                .is_err()
        );
        assert!(engine.done());
        assert!(engine.request(&mut Vec::new()).is_none());

        for references in [vec![0, 0], vec![1, 0], vec![0], vec![0, 1, 2]] {
            let mut engine =
                stream(json!({"op":"settle","mode":"agreed","evaluation":"a","count":2}));
            engine.request(&mut Vec::new()).unwrap();
            let routes = references
                .into_iter()
                .map(|action| json!({"action":action,"runtime":[97]}))
                .collect::<Vec<_>>();
            let reply = json!({"evaluation":"a","effect":1,"routes":routes,"limits":[]});
            assert!(
                engine
                    .respond(&serde_json::to_vec(&reply).unwrap(), &[], &mut Vec::new())
                    .is_err()
            );
            assert!(engine.done());
            assert!(engine.finish(&mut Vec::new()).is_err());
        }
    }

    #[test]
    fn semantic_effects_preserve_lifecycle_guards() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../../../integ/policy/composition.json"))
                .unwrap();
        for operation in [
            "read_ask_rules",
            "replace_ask_rules",
            "read_final_values",
            "read_settlement_action",
        ] {
            let case = corpus["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|case| {
                    case["effects"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|effect| effect["request"]["op"] == operation)
                })
                .unwrap();
            for failure in ["cancel", "stale", "finish", "wrong_payload"] {
                let mut engine = stream(case["input"].clone());
                for effect in case["effects"].as_array().unwrap() {
                    let request: Value =
                        serde_json::from_slice(&engine.request(&mut Vec::new()).unwrap()).unwrap();
                    if request["op"] == operation {
                        match failure {
                            "cancel" => {
                                assert!(engine.cancel());
                                assert!(engine.cancel());
                            }
                            "finish" => assert!(engine.finish(&mut Vec::new()).is_err()),
                            _ => {
                                let mut reply = if failure == "stale" {
                                    effect["reply"].clone()
                                } else {
                                    json!({"unrelated":[]})
                                };
                                reply["evaluation"] = request["evaluation"].clone();
                                reply["effect"] = if failure == "stale" {
                                    json!(0)
                                } else {
                                    request["effect"].clone()
                                };
                                assert!(
                                    engine
                                        .respond(
                                            &serde_json::to_vec(&reply).unwrap(),
                                            &[],
                                            &mut Vec::new()
                                        )
                                        .is_err(),
                                    "{operation} {failure}"
                                );
                            }
                        }
                        assert!(engine.done());
                        assert!(engine.request(&mut Vec::new()).is_none());
                        assert!(engine.finish(&mut Vec::new()).is_err());
                        break;
                    }
                    let mut reply = effect["reply"].clone();
                    reply["evaluation"] = request["evaluation"].clone();
                    reply["effect"] = request["effect"].clone();
                    engine
                        .respond(&serde_json::to_vec(&reply).unwrap(), &[], &mut Vec::new())
                        .unwrap();
                }
            }
        }
    }

    #[test]
    fn cumulative_budget_is_not_just_a_packet_budget() {
        let mut engine = Composition {
            state: State::Receiving(Vec::new()),
            bytes: EVALUATION_BYTES - PACKET_BYTES,
        };
        assert!(engine.account(PACKET_BYTES).is_ok());
        assert!(engine.account(1).is_err());
        assert!(engine.done());
    }
}
