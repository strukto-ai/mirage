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
            for field in ["fresh", "status"] {
                if !step[field].is_null() {
                    assert_eq!(result[field], step[field], "{} step {index}", case["name"]);
                }
            }
            for field in ["records", "claims"] {
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
