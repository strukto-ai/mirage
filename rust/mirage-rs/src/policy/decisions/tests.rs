use super::*;
use serde_json::{Value, json};

fn initialized(input: &Value) -> Box<dyn Stream> {
    let mut engine = open(b"{}").unwrap();
    for chunk in serde_json::to_vec(input).unwrap().chunks(7) {
        engine.feed(chunk, &mut Vec::new()).unwrap();
    }
    engine.finish(&mut Vec::new()).unwrap();
    engine
}

#[test]
fn shared_approval_lifecycle_transcripts() {
    let corpus: Value =
        serde_json::from_str(include_str!("../../../../../integ/policy/approvals.json")).unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let mut ledger = json!({"version":1,"incarnation":"test-session","revision":0,"records":[],"claims":[],"receipts":[]});
        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let transition = step["transition"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("event-{index}"));
            let mut engine = initialized(
                &json!({"evaluation":"evaluation","transition":transition,"ledger":ledger,"event":step["event"]}),
            );
            if let Some(request) = engine.request(&mut Vec::new()) {
                let request: Value = serde_json::from_slice(&request).unwrap();
                assert!(engine.request(&mut Vec::new()).is_none());
                assert!(!engine.done());
                let status = step["storage"].as_str().unwrap_or("committed");
                let reply = json!({"evaluation":"evaluation","effect":1,"transition":transition,"status":status,"revision":request["ledger"]["revision"]});
                engine
                    .respond(&serde_json::to_vec(&reply).unwrap(), &[], &mut Vec::new())
                    .unwrap();
                if status == "committed" || step["stored"] == true {
                    ledger = request["ledger"].clone();
                }
            }
            assert!(engine.done());
            let mut out = Vec::new();
            engine.finish(&mut out).unwrap();
            let result: Value = serde_json::from_slice(&out).unwrap();
            assert_eq!(
                result["kind"], step["kind"],
                "{} step {index}: {result}",
                case["name"]
            );
            for field in ["fresh", "status", "matched"] {
                if !step[field].is_null() {
                    assert_eq!(result[field], step[field], "{} step {index}", case["name"]);
                }
            }
            if !step["record_id"].is_null() {
                assert_eq!(
                    result["record"]["id"], step["record_id"],
                    "{} step {index}",
                    case["name"]
                );
            }
            for field in ["records", "claims", "pending_claims"] {
                if !step[field].is_null() {
                    assert_eq!(
                        ledger[field].as_array().unwrap().len(),
                        step[field].as_u64().unwrap() as usize,
                        "{} step {index} {field}",
                        case["name"]
                    );
                }
            }
        }
    }
}

fn resolving() -> Value {
    let corpus: Value =
        serde_json::from_str(include_str!("../../../../../integ/policy/approvals.json")).unwrap();
    json!({
        "evaluation":"a","transition":"event",
        "ledger":{"version":1,"incarnation":"s","revision":0,"records":[],"claims":[],"receipts":[]},
        "event":corpus["cases"][0]["steps"][0]["event"]
    })
}

fn commit(input: &Value) -> (Value, Value) {
    let mut engine = initialized(input);
    let mut ledger = input["ledger"].clone();
    if let Some(request) = engine.request(&mut Vec::new()) {
        let request: Value = serde_json::from_slice(&request).unwrap();
        ledger = request["ledger"].clone();
        engine
            .respond(
                &serde_json::to_vec(&json!({
                    "evaluation":input["evaluation"], "transition":input["transition"],
                    "effect":1, "status":"committed", "revision":ledger["revision"]
                }))
                .unwrap(),
                &[],
                &mut Vec::new(),
            )
            .unwrap();
    }
    let mut out = Vec::new();
    engine.finish(&mut out).unwrap();
    (serde_json::from_slice(&out).unwrap(), ledger)
}

#[test]
fn stale_policy_facts_never_create_or_authorize_a_question() {
    let mut input = resolving();
    input["facts"] =
        json!({"expected":{"commands":{"deny":[]}},"current":{"commands":{"deny":["all"]}}});
    let mut engine = initialized(&input);
    assert!(engine.request(&mut Vec::new()).is_none());
    let mut out = Vec::new();
    engine.finish(&mut out).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&out).unwrap(),
        json!({"kind":"blocked","status":"stale_facts"})
    );
}

#[test]
fn session_writes_preserve_newer_restrictions_and_invalidate_explicit_changes() {
    let (pending, mut ledger) = commit(&resolving());
    assert_eq!(pending["kind"], "pending");
    let mut input = resolving();
    input["ledger"] = ledger.clone();
    input["transition"] = json!("answer");
    input["event"] = json!({"op":"answer","id":input["event"]["question"]["id"],"outcome":"allow","scope":"session","note":[],"claimant":null});
    (_, ledger) = commit(&input);
    let older = json!({"commands":{"allow":null,"deny":[],"ask":[]}});
    let newer = json!({"commands":{"allow":[],"deny":[],"ask":[]}});
    input["ledger"] = ledger;
    input["transition"] = json!("stale-normal-flush");
    input["facts"] = json!({"expected":older,"current":newer});
    input["event"] = json!({"op":"session_write","baseline":older,"local":older});
    let (result, ledger) = commit(&input);
    assert_eq!(result["kind"], "rebased");
    assert_eq!(result["authority"]["commands"], newer["commands"]);
    assert_eq!(ledger["records"].as_array().unwrap().len(), 1);
    input["ledger"] = ledger;
    input["transition"] = json!("explicit-profile-replacement");
    input["event"]["local"] = json!({"commands":{"allow":["cat"],"deny":[],"ask":[]}});
    let (result, ledger) = commit(&input);
    assert_eq!(result["authority"]["commands"]["allow"], json!(["cat"]));
    assert!(ledger["records"].as_array().unwrap().is_empty());
    assert!(ledger["claims"].as_array().unwrap().is_empty());
    assert_eq!(ledger["retired"].as_array().unwrap().len(), 1);
}

#[test]
fn storage_acknowledgement_is_required_and_bound_to_the_transition() {
    for change in [
        "undelivered",
        "evaluation",
        "effect",
        "transition",
        "revision",
        "status",
        "data",
        "duplicate",
        "cancel",
    ] {
        let mut engine = initialized(&resolving());
        let mut reply = json!({"evaluation":"a","effect":1,"transition":"event","status":"committed","revision":1});
        if change != "undelivered" {
            engine.request(&mut Vec::new()).unwrap();
        }
        match change {
            "evaluation" | "transition" => reply[change] = json!("stale"),
            "effect" | "revision" => reply[change] = json!(0),
            "status" => reply[change] = json!("success"),
            "cancel" => {
                assert!(engine.cancel());
                assert!(engine.cancel());
            }
            "duplicate" => {
                engine
                    .respond(&serde_json::to_vec(&reply).unwrap(), &[], &mut Vec::new())
                    .unwrap();
            }
            _ => {}
        }
        let data: &[u8] = if change == "data" { b"unexpected" } else { &[] };
        assert!(
            engine
                .respond(&serde_json::to_vec(&reply).unwrap(), data, &mut Vec::new())
                .is_err(),
            "{change}"
        );
        assert!(engine.done());
        assert!(engine.request(&mut Vec::new()).is_none());
        assert!(engine.finish(&mut Vec::new()).is_err());
    }
    let mut engine = initialized(&resolving());
    assert!(engine.finish(&mut Vec::new()).is_err());
    assert!(engine.done());
}

#[test]
fn malformed_or_oversized_state_cannot_authorize() {
    for field in ["version", "incarnation", "revision"] {
        let mut input = resolving();
        input["ledger"][field] = match field {
            "version" => json!(9),
            "incarnation" => json!(""),
            _ => json!(u64::MAX),
        };
        let mut engine = open(b"{}").unwrap();
        engine
            .feed(&serde_json::to_vec(&input).unwrap(), &mut Vec::new())
            .unwrap();
        assert!(engine.finish(&mut Vec::new()).is_err());
        assert!(engine.done());
    }
    let mut engine = open(b"{}").unwrap();
    assert!(
        engine
            .feed(&vec![b' '; PACKET_BYTES + 1], &mut Vec::new())
            .is_err()
    );
    assert!(engine.done());
}

#[test]
fn close_and_restore_rotate_authority_and_keep_the_storage_requirement() {
    let (_, ledger) = commit(&resolving());
    let mut input = resolving();
    input["ledger"] = ledger;
    input["expected_incarnation"] = json!("s");
    input["transition"] = json!("close");
    input["event"] = json!({"op":"reset","incarnation":"closed-identity","closed":"closure-token"});
    let (_, closed) = commit(&input);
    assert_eq!(closed["incarnation"], "closed-identity");
    assert_eq!(closed["closed"], "closure-token");
    assert_eq!(closed["protected"], true);
    assert_eq!(closed["records"], json!([]));
    input["ledger"] = closed.clone();
    input["transition"] = json!("old-command");
    input["event"] = resolving()["event"].clone();
    let (result, _) = commit(&input);
    assert_eq!(result, json!({"kind":"blocked","status":"session_closed"}));
    input["event"] = json!({"op":"reset","incarnation":"restored-identity","closed":null});
    input["transition"] = json!("restore");
    let (result, _) = commit(&input);
    assert_eq!(
        result,
        json!({"kind":"blocked","status":"stale_incarnation"})
    );
    input["expected_incarnation"] = json!("closed-identity");
    let (result, restored) = commit(&input);
    assert_eq!(result["kind"], "applied");
    assert_eq!(restored["incarnation"], "restored-identity");
    assert!(restored["closed"].is_null());
    assert_eq!(restored["protected"], true);
    input["ledger"] = restored;
    input["event"] = resolving()["event"].clone();
    input["transition"] = json!("late-answer");
    let (result, _) = commit(&input);
    assert_eq!(
        result,
        json!({"kind":"blocked","status":"stale_incarnation"})
    );
}

#[test]
fn absent_and_empty_mount_anchors_are_the_same_approval_rule() {
    let (pending, ledger) = commit(&resolving());
    let mut input = resolving();
    input["ledger"] = ledger;
    input["transition"] = json!("other-host");
    input["event"]["question"]["rule"]["mount"] = Value::Null;
    input["event"]["rules"][0]["mount"] = Value::Null;
    let (same, ledger) = commit(&input);
    assert_eq!(same["kind"], "pending");
    assert_eq!(same["fresh"], false);
    assert_eq!(same["record"]["id"], pending["record"]["id"]);
    input["ledger"] = ledger;
    input["transition"] = json!("answer");
    input["event"] = json!({"op":"answer","id":pending["record"]["id"],"outcome":"allow","scope":"session","note":[],"claimant":null});
    let (_, ledger) = commit(&input);
    input["ledger"] = ledger;
    input["transition"] = json!("other-host-run");
    input["event"] = resolving()["event"].clone();
    input["event"]["rules"][0]["mount"] = Value::Null;
    let (allowed, _) = commit(&input);
    assert_eq!(allowed["kind"], "allow");
}

#[test]
fn session_grant_projections_require_and_register_a_live_caller() {
    let (pending, ledger) = commit(&resolving());
    let mut input = resolving();
    input["ledger"] = ledger;
    input["transition"] = json!("answer-session");
    input["event"] = json!({"op":"answer","id":pending["record"]["id"],"outcome":"allow","scope":"session","note":[],"claimant":null});
    let (_, ledger) = commit(&input);
    input["ledger"] = ledger.clone();
    input["transition"] = json!("unbound");
    input["event"] = json!({"op":"session_grants","claimant":null});
    let (blocked, _) = commit(&input);
    assert_eq!(blocked, json!({"kind":"blocked","status":"missing_caller"}));
    input["event"]["explain"] = json!(true);
    let mut inspection = initialized(&input);
    assert!(inspection.request(&mut Vec::new()).is_none());
    let mut bytes = Vec::new();
    inspection.finish(&mut bytes).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["rules"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    input["event"] = json!({"op":"session_grants","claimant":{
        "owner":"process","holder":"walker","lineage":[],
        "occurrence":{"parent":null,"source":[],"start":0,"end":0}
    }});
    input["transition"] = json!("walk");
    let (granted, ledger) = commit(&input);
    assert_eq!(granted["rules"].as_array().unwrap().len(), 1);
    assert_eq!(
        ledger["holders"],
        json!([{"owner":"process","holder":"walker","active":true}])
    );
    input["ledger"] = ledger;
    input["transition"] = json!("revoke-policy");
    input["event"] = json!({"op":"invalidate"});
    let (_, ledger) = commit(&input);
    input["ledger"] = ledger;
    input["transition"] = json!("later-file-read");
    input["event"] = json!({"op":"validate","owner":"process","holders":["walker"]});
    let (blocked, _) = commit(&input);
    assert_eq!(blocked, json!({"kind":"blocked","status":"stale_holder"}));
}
