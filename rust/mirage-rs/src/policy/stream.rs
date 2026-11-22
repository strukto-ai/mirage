use serde::{Deserialize, Serialize};

use super::judge::{Trees, Walked};
use super::{
    AdmissionMatcher, CommandFacts, LinkCandidate, LinkStep, Mode, Profile, Reading, Text,
    Visibility, VisibilityMatcher, classify_paths, compile_profile, is_glob, restrict_profile,
    show_head,
};
use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default)]
    rules: Trees,
    #[serde(default)]
    visibility: Visibility,
}

/// One question for the compiled rules, as the JSON a host feeds; `finish`
/// writes its answer as JSON.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    Approvals {
        query: super::approvals::Query,
    },
    PathVisible {
        path: Text,
    },
    MoveReveals {
        src: Text,
        dst: Text,
    },
    HidesIntersect {
        path: Text,
    },
    VarHidden {
        name: Text,
    },
    LinkTraceHidden {
        trace: Vec<LinkStep>,
    },
    VisibleLinks {
        candidates: Vec<LinkCandidate>,
    },
    EffectiveMode {
        path: Text,
        prefix: Text,
        configured: Mode,
        cap: Option<Mode>,
    },
    StrongestMode {
        prefix: Text,
        configured: Mode,
        cap: Option<Mode>,
    },
    ReadonlyBelow {
        path: Text,
        prefix: Text,
        configured: Mode,
        cap: Option<Mode>,
    },
    Rules,
    HasRules,
    Runs {
        name: Text,
    },
    ReadsArgs {
        name: Text,
    },
    ScopesPaths {
        name: Text,
    },
    Decide {
        facts: CommandFacts,
    },
    Redirect {
        paths: Vec<Text>,
    },
    NamingRules {
        tokens: Vec<Text>,
        #[serde(default)]
        line: Option<Reading>,
        #[serde(default = "tool")]
        tool: bool,
    },
    IoReach {
        walked: Vec<Walked>,
        path: Text,
        #[serde(default)]
        granted: Vec<usize>,
    },
    IoRefusal {
        walked: Vec<Walked>,
        path: Text,
        granted: Vec<usize>,
    },
    Compile {
        profile: Profile,
    },
    Restrict {
        base: Option<Profile>,
        inline: Option<Profile>,
    },
    ClassifyPaths {
        entries: Vec<Text>,
    },
    IsGlob {
        entry: Text,
    },
    ShowHead {
        entry: Text,
    },
}

fn tool() -> bool {
    true
}

/// A profile's rules and visibility compiled once: each request is fed as
/// JSON, in as many chunks as the host likes, and `finish` answers it.
struct Policy {
    admission: AdmissionMatcher,
    visibility: VisibilityMatcher,
    request: Vec<u8>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(Box::new(Policy {
        admission: AdmissionMatcher::new(config.rules),
        visibility: VisibilityMatcher::new(config.visibility),
        request: Vec::new(),
    }))
}

fn in_range(
    walked: &[Walked],
    ids: &[usize],
    trees: usize,
    rules: usize,
) -> Result<(), StreamError> {
    let leaves = walked.iter().flat_map(|w| {
        w.branches.iter().flat_map(|branch| {
            branch
                .steps
                .iter()
                .chain(&branch.groups)
                .flat_map(|group| group.first.iter().chain(&group.then))
        })
    });
    if walked.iter().any(|w| w.tree >= trees) || leaves.chain(ids).any(|&id| id >= rules) {
        return Err(StreamError::new("policy rule index is out of range"));
    }
    Ok(())
}

fn reply(out: &mut Vec<u8>, value: impl Serialize) -> Result<(), StreamError> {
    serde_json::to_writer(out, &value)
        .map_err(|err| StreamError::new(format!("policy answer: {err}")))
}

impl Policy {
    fn answer(&self, request: Request, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let vis = &self.visibility;
        let rules = &self.admission;
        match request {
            Request::Approvals { query } => reply(out, super::approvals::answer(query)?),
            Request::PathVisible { path } => reply(out, vis.path_visible(&path)),
            Request::MoveReveals { src, dst } => reply(out, vis.move_reveals(&src, &dst)),
            Request::HidesIntersect { path } => reply(out, vis.hides_intersect(&path)),
            Request::VarHidden { name } => reply(out, vis.var_hidden(&name)),
            Request::LinkTraceHidden { trace } => reply(out, vis.link_trace_hidden(&trace)),
            Request::VisibleLinks { candidates } => reply(out, vis.visible_links(&candidates)),
            Request::EffectiveMode {
                path,
                prefix,
                configured,
                cap,
            } => reply(out, vis.effective_mode(&path, &prefix, configured, cap)),
            Request::StrongestMode {
                prefix,
                configured,
                cap,
            } => reply(out, vis.strongest_mode(&prefix, configured, cap)),
            Request::ReadonlyBelow {
                path,
                prefix,
                configured,
                cap,
            } => reply(out, vis.readonly_below(&path, &prefix, configured, cap)),
            Request::Rules => reply(out, rules.rules()),
            Request::HasRules => reply(out, rules.has_rules()),
            Request::Runs { name } => reply(out, rules.runs(&name)),
            Request::ReadsArgs { name } => reply(out, rules.reads_args(&name)),
            Request::ScopesPaths { name } => reply(out, rules.scopes_paths(&name)),
            Request::Decide { facts } => reply(out, rules.decide(&facts)),
            Request::Redirect { paths } => reply(out, rules.redirect(&paths)),
            Request::NamingRules { tokens, line, tool } => {
                reply(out, rules.naming(&tokens, line.as_ref(), tool))
            }
            Request::IoReach {
                walked,
                path,
                granted,
            } => {
                in_range(&walked, &granted, rules.tree_count(), rules.rules().len())?;
                reply(out, rules.io_reach(&walked, &path, &granted))
            }
            Request::IoRefusal {
                walked,
                path,
                granted,
            } => {
                in_range(&walked, &granted, rules.tree_count(), rules.rules().len())?;
                reply(out, rules.io_refusal(&walked, &path, &granted))
            }
            Request::Compile { profile } => reply(out, compile_profile(&profile)),
            Request::Restrict { base, inline } => reply(
                out,
                restrict_profile(base.as_ref(), inline.as_ref()).map_err(StreamError::new)?,
            ),
            Request::ClassifyPaths { entries } => reply(out, classify_paths(&entries)),
            Request::IsGlob { entry } => reply(out, is_glob(&entry)),
            Request::ShowHead { entry } => reply(out, show_head(&entry)),
        }
    }
}

impl Stream for Policy {
    fn feed(&mut self, input: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        self.request.extend_from_slice(input);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let request = std::mem::take(&mut self.request);
        let request: Request = serde_json::from_slice(&request)
            .map_err(|err| StreamError::new(format!("bad policy request: {err}")))?;
        self.answer(request, out)
    }
}

#[cfg(test)]
mod tests {
    use crate::run;

    fn ask(config: &str, request: &str) -> String {
        let (out, err) = run("policy", config, &[request.as_bytes()]);
        assert!(err.is_none(), "{:?}", err.map(|e| e.message));
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn answers_each_request_and_takes_chunked_input() {
        let config = r#"{"visibility": {"hidden": {"paths": [[47,115]]}}}"#;
        assert_eq!(
            ask(config, r#"{"op": "path_visible", "path": [47,115,47,120]}"#),
            "false"
        );
        assert_eq!(
            ask(config, r#"{"op": "path_visible", "path": [47,111]}"#),
            "true"
        );
        let (out, err) = crate::run(
            "policy",
            config,
            &[br#"{"op": "path_vis"#, br#"ible", "path": [47,111]}"#],
        );
        assert!(err.is_none());
        assert_eq!(out, b"true");
    }

    fn tree(mount: &str, commands: &str) -> String {
        let root = crate::document::tree_of(&serde_json::from_str(commands).unwrap()).unwrap();
        let mount: Vec<u32> = mount.chars().map(u32::from).collect();
        serde_json::to_string(
            &serde_json::json!({"rules": {"trees": [{"mount": mount, "root": root}]}}),
        )
        .unwrap()
    }

    #[test]
    fn a_leaf_is_one_mapping_with_its_decision() {
        let config = |root: &str| format!(r#"{{"rules": {{"trees": [{{"root": {root}}}]}}}}"#);
        let refused = |root: &str| {
            super::open(config(root).as_bytes())
                .err()
                .map(|e| e.message)
                .unwrap_or_default()
        };
        for root in [
            r#"{"decision": []}"#,
            r#"{"decision": [{"decision": "deny", "reason": []}]}"#,
            r#"{"decision": {"reason": []}}"#,
            r#"{"decision": {"decision": "deny", "reason": [], "paths": [[47]]}}"#,
            r#"{"subcommands": [[[114,109], {"decision": {"decision": "deny", "paths": [[47]]}}]]}"#,
            r#"{"other_options": []}"#,
        ] {
            assert!(!refused(root).is_empty(), "{root} was accepted");
        }
        for root in [
            r#"{"decision": null}"#,
            r#"{"decision": {"decision": "deny"}}"#,
            r#"{"decision": {"decision": "ask", "reason": [110,111]}, "other_options": null}"#,
        ] {
            assert_eq!(refused(root), "", "{root} was refused");
        }
    }

    #[test]
    fn decides_with_host_supplied_subtree_facts() {
        let config = tree("/r/k", r#"{"rm": {"decision": "deny", "reason": "no"}}"#);
        let facts = |subtree: bool| {
            format!(
                r#"{{"op": "decide", "facts": {{"tokens": [[114,109],[47,114]], "tool": true,
                "cwd": [47], "paths": [{{"virtual_path": [47,114]}}],
                "operands": [{{"virtual_path": [47,114]}}],
                "walks": false, "subtree": {subtree}, "moves": false, "move_target": null}}}}"#
            )
        };
        assert!(ask(&config, &facts(true)).contains(r#""outcome":"deny""#));
        assert!(ask(&config, &facts(false)).contains(r#""outcome":"allow""#));
    }

    #[test]
    fn judges_a_reached_file_under_the_line_walk() {
        let config = tree(
            "/r",
            r#"{"cp": {"decision": "ask", "reason": "no"},
                "rm": {"decision": "deny", "reason": "no"}}"#,
        );
        let walked = ask(
            &config,
            r#"{"op": "naming_rules", "tokens": [[114,109],[47,114]]}"#,
        );
        let entry = format!(
            r#"{{"op": "io_refusal", "walked": {walked}, "path": [47,114,47,120], "granted": []}}"#
        );
        assert_eq!(ask(&config, &entry), "1");
        let reach = format!(r#"{{"op": "io_reach", "walked": {walked}, "path": [47,114]}}"#);
        assert_eq!(ask(&config, &reach), "true");
        let cp = ask(
            &config,
            r#"{"op": "naming_rules", "tokens": [[99,112],[47,114]]}"#,
        );
        let granted =
            format!(r#"{{"op": "io_reach", "walked": {cp}, "path": [47,114], "granted": [0]}}"#);
        assert_eq!(ask(&config, &granted), "false");
        let held = format!(r#"{{"op": "io_reach", "walked": {cp}, "path": [47,114]}}"#);
        assert_eq!(ask(&config, &held), "true");
        assert!(ask(&config, r#"{"op": "rules"}"#).contains(r#""at":[47,114,109,47,42]"#));
    }

    #[test]
    fn refuses_a_bad_request_or_rule_index() {
        let (_, err) = crate::run("policy", "{}", &[b"{\"op\": \"nope\"}"]);
        assert!(err.unwrap().message.starts_with("bad policy request"));
        let entry = br#"{"op": "io_refusal", "walked": [], "path": [47], "granted": [0]}"#;
        let (_, err) = crate::run("policy", "{}", &[entry]);
        assert_eq!(err.unwrap().message, "policy rule index is out of range");
        let reach = br#"{"op": "io_reach", "walked": [], "path": [47], "granted": [0]}"#;
        let (_, err) = crate::run("policy", "{}", &[reach]);
        assert_eq!(err.unwrap().message, "policy rule index is out of range");
        let refused = crate::open("policy", br#"{"bogus": 1}"#).err().unwrap();
        assert!(refused.message.starts_with("bad stream config"));
    }
}
