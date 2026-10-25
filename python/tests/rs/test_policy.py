# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import json
from pathlib import Path

import pytest

from mirage.commands.spec.types import WordKind
from mirage.policy.match.decide import decide
from mirage.policy.match.pattern import (
    pattern_matches,
    pattern_reaches,
    split_pattern,
)
from mirage.policy.types import (
    AdmissionRules,
    CommandContext,
    CommandRule,
    CommandWord,
)
from mirage.rs.errors import StreamRefusal
from mirage.rs.policy import admission_matcher, units, visibility_matcher
from mirage.types import (
    HiddenPaths,
    HiddenVars,
    MountMode,
    PathSpec,
    ShowEntry,
    ShownPaths,
    Visibility,
)
from mirage.utils.hidden import (
    classify_paths,
    hidden_under,
    is_glob,
    move_reveals,
    path_visible,
    var_hidden,
)
from mirage.workspace.session.session import SessionState

CORPUS = (
    Path(__file__).resolve().parents[3] / "integ" / "policy" / "matching.json"
)


def _path(value: str) -> PathSpec:
    return PathSpec(
        virtual=value,
        directory=value.rsplit("/", 1)[0] or "/",
        vfs_path=value,
        resolved=True,
        raw_path=value,
    )


def _rule(value) -> CommandRule:
    return CommandRule(
        **{k: tuple(v) if isinstance(v, list) else v for k, v in value.items()}
    )


def test_shared_matching_corpus():
    corpus = json.loads(CORPUS.read_text())
    for case in corpus["patterns"]:
        assert list(split_pattern(case["pattern"])) == case["split"]
        assert (
            pattern_matches(case["pattern"], case["tokens"]) == case["matches"]
        )
        assert (
            pattern_reaches(case["pattern"], case["tokens"]) == case["reaches"]
        )
    for case in corpus["visibility"]:
        shown = tuple(
            ShowEntry(
                path=v["path"],
                mode=MountMode(v["mode"]) if v["mode"] else None,
            )
            for v in case["show"]
        )
        vis = Visibility(
            paths=classify_paths(case["hide"]),
            shown=ShownPaths(entries=shown) if shown else None,
            vars=HiddenVars(
                names=tuple(v for v in case["vars"] if not is_glob(v)),
                patterns=tuple(v for v in case["vars"] if is_glob(v)),
            ),
        )
        for query in case["queries"]:
            path = query["path"]
            assert path_visible(vis, path) == query["visible"]
            assert hidden_under(vis, path) == query["hidden_under"]
        for move in case["moves"]:
            assert (
                move_reveals(vis, move["src"], move["dst"]) == move["reveals"]
            )
        for var in case["variables"]:
            assert var_hidden(vis, var["name"]) == var["hidden"]
    for case in corpus["admissions"]:
        rule_doc = case["rules"]
        deny = tuple(_rule(v) for v in rule_doc["deny"])
        ask = tuple(_rule(v) for v in rule_doc["ask"])
        rules = AdmissionRules(
            allow=None
            if rule_doc["allow"] is None
            else tuple(rule_doc["allow"]),
            deny=deny,
            ask=ask,
        )
        facts = case["facts"]
        ctx = CommandContext(
            command=facts["command"],
            paths=tuple(_path(v) for v in facts["paths"]),
            argv=tuple(facts["paths"]),
            cwd=facts["cwd"],
            tokens=tuple(facts["tokens"]),
            tool=facts["tool"],
            walks=facts["walks"],
            words=tuple(
                CommandWord(kind=WordKind.OPERAND, path=_path(v), text=v)
                for v in facts["operands"]
            ),
        )
        result = decide(ctx, rules)
        listed = (*deny, *ask)
        expected = case["expected"]
        assert result.outcome.value == expected["outcome"], case["name"]
        assert (
            next(
                (i for i, rule in enumerate(listed) if rule is result.rule),
                None,
            )
            == expected["rule"]
        )
        assert result.matched_path == expected["matched_path"]
        assert result.source == expected["source"]
        assert [
            next(i for i, rule in enumerate(listed) if rule is a)
            for a in result.asks
        ] == expected["asks"]


def test_answers_keep_the_hosts_own_rule_objects():
    rule = CommandRule(reason="review", paths=("/repo/*",))
    ctx = CommandContext(
        command="cat", paths=(_path("/repo/x"),), argv=(), cwd="/"
    )
    result = decide(ctx, AdmissionRules(ask=(rule,)))
    assert result.rule is rule
    assert result.asks[0] is rule


def test_restored_visibility_keeps_component_depth_and_surrogate_text():
    vis = Visibility(
        paths=HiddenPaths(patterns=("secret", "*.key")),
        shown=ShownPaths(entries=(ShowEntry("/secret"),)),
    )
    stored = SessionState(session_id="restored", visibility=vis).to_dict()
    restored = SessionState.from_dict(stored)
    assert restored.visibility is not None
    assert path_visible(restored.visibility, "/secret/x")
    assert not path_visible(restored.visibility, "/\ud800.key")
    assert not path_visible(restored.visibility, "/\U0001f600.key")


def test_link_trace_keeps_landing_nonterminal_and_hop_limit_terminal():
    matcher = visibility_matcher(
        Visibility(paths=HiddenPaths(paths=("/secret",)))
    )

    def hidden(*trace) -> bool:
        return matcher.ask("link_trace_hidden", trace=list(trace)) is True

    assert not hidden({"landing": units("/secret")})
    assert hidden(
        {"follow": units("/open")},
        {"landing": units("/open")},
        {"enter": {"path": units("/secret"), "next_is_parent": True}},
    )
    assert not hidden(
        {"follow": units("/open")}, "hop_limit", {"follow": units("/secret")}
    )
    assert hidden({"follow": units("/secret")}, "hop_limit")


def test_a_bad_request_is_a_stream_refusal():
    with pytest.raises(StreamRefusal, match="bad policy request"):
        admission_matcher(None).ask("no_such_op")
    with pytest.raises(StreamRefusal, match="rule index is out of range"):
        admission_matcher(None).ask("posix_level", rule=0)
