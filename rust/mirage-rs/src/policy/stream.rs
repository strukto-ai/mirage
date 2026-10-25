use serde::{Deserialize, Serialize};

use super::{
    AdmissionMatcher, CommandFacts, LinkCandidate, LinkStep, Mode, Profile, Rules, Text,
    Visibility, VisibilityMatcher, Whitespace, classify_paths, compile_profile, is_glob,
    pattern_matches, pattern_reaches, restrict_profile, show_head, split_pattern,
};
use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default)]
    rules: Rules,
    #[serde(default)]
    visibility: Visibility,
    #[serde(default)]
    dialect: Whitespace,
}

/// One question for the compiled rules, as the JSON a host feeds; `finish`
/// writes its answer as JSON.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
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
    HeadAllowed {
        name: Text,
    },
    LineAllowed {
        tokens: Vec<Text>,
        tool: bool,
    },
    HasRules,
    ReadsArgs {
        name: Text,
    },
    ScopesPaths {
        name: Text,
    },
    Decide {
        facts: CommandFacts,
    },
    IoReach {
        tokens: Vec<Text>,
        path: Text,
    },
    IoRefusal {
        tokens: Vec<Text>,
        path: Text,
        granted: Vec<usize>,
    },
    OpRuling {
        subtree: bool,
        path: Text,
        granted: Vec<usize>,
    },
    PosixLevel {
        rule: usize,
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
    SplitPattern {
        pattern: Text,
    },
    PatternMatches {
        pattern: Text,
        tokens: Vec<Text>,
    },
    PatternReaches {
        pattern: Text,
        tokens: Vec<Text>,
    },
}

/// A profile's rules and visibility compiled once: each request is fed as
/// JSON, in as many chunks as the host likes, and `finish` answers it.
struct Policy {
    admission: AdmissionMatcher,
    visibility: VisibilityMatcher,
    dialect: Whitespace,
    request: Vec<u8>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(Box::new(Policy {
        admission: AdmissionMatcher::new(config.rules, config.dialect),
        visibility: VisibilityMatcher::new(config.visibility),
        dialect: config.dialect,
        request: Vec::new(),
    }))
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
            Request::HeadAllowed { name } => reply(out, rules.head_allowed(&name)),
            Request::LineAllowed { tokens, tool } => reply(out, rules.line_allowed(&tokens, tool)),
            Request::HasRules => reply(out, rules.has_rules()),
            Request::ReadsArgs { name } => reply(out, rules.reads_args(&name)),
            Request::ScopesPaths { name } => reply(out, rules.scopes_paths(&name)),
            Request::Decide { facts } => reply(out, rules.decide(&facts)),
            Request::IoReach { tokens, path } => reply(out, rules.io_reach(&tokens, &path)),
            Request::IoRefusal {
                tokens,
                path,
                granted,
            } => reply(out, rules.io_refusal(&tokens, &path, &granted)),
            Request::OpRuling {
                subtree,
                path,
                granted,
            } => reply(out, rules.op_ruling(subtree, &path, &granted)),
            Request::PosixLevel { rule } => {
                if rule >= rules.rule_count() {
                    return Err(StreamError::new("policy rule index is out of range"));
                }
                reply(out, rules.posix_level(rule))
            }
            Request::Compile { profile } => reply(out, compile_profile(&profile)),
            Request::Restrict { base, inline } => reply(
                out,
                restrict_profile(base.as_ref(), inline.as_ref()).map_err(StreamError::new)?,
            ),
            Request::ClassifyPaths { entries } => reply(out, classify_paths(&entries)),
            Request::IsGlob { entry } => reply(out, is_glob(&entry)),
            Request::ShowHead { entry } => reply(out, show_head(&entry)),
            Request::SplitPattern { pattern } => reply(out, split_pattern(&pattern, self.dialect)),
            Request::PatternMatches { pattern, tokens } => {
                reply(out, pattern_matches(&pattern, &tokens, self.dialect))
            }
            Request::PatternReaches { pattern, tokens } => {
                reply(out, pattern_reaches(&pattern, &tokens, self.dialect))
            }
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

    #[test]
    fn decides_with_host_supplied_subtree_facts() {
        let config = r#"{"rules": {"deny": [{"reason": [110,111], "paths": [[47,114,47,42]]}]}}"#;
        let facts = |subtree: bool| {
            format!(
                r#"{{"op": "decide", "facts": {{"tokens": [[114,109],[47,114]], "tool": true,
                "cwd": [47], "paths": [{{"virtual_path": [47,114], "display_path": [47,114]}}],
                "operands": [{{"virtual_path": [47,114], "display_path": [47,114]}}],
                "walks": false, "subtree": {subtree}, "moves": false, "move_target": null}}}}"#
            )
        };
        assert!(ask(config, &facts(true)).contains(r#""outcome":"deny""#));
        assert!(ask(config, &facts(false)).contains(r#""outcome":"allow""#));
    }

    #[test]
    fn refuses_a_bad_request_or_rule_index() {
        let (_, err) = crate::run("policy", "{}", &[b"{\"op\": \"nope\"}"]);
        assert!(err.unwrap().message.starts_with("bad policy request"));
        let (_, err) = crate::run("policy", "{}", &[b"{\"op\": \"posix_level\", \"rule\": 0}"]);
        assert_eq!(err.unwrap().message, "policy rule index is out of range");
        let refused = crate::open("policy", br#"{"bogus": 1}"#).err().unwrap();
        assert!(refused.message.starts_with("bad stream config"));
    }
}
