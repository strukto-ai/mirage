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
import sys
from pathlib import Path
from threading import Event, Thread

import pytest

from mirage._rs import PolicyAdmission, PolicyVisibility
from mirage.commands.spec.types import WordKind
from mirage.policy.match.allow import line_allowed
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
from mirage.rs.policy import (
    _short_units,
    admission_matcher,
    units,
    visibility_matcher,
)
from mirage.types import (
    HiddenPaths,
    MountMode,
    PathSpec,
    ShowEntry,
    ShownPaths,
    Visibility,
)
from mirage.utils.hidden import (
    classify_paths,
    classify_shows,
    classify_vars,
    hidden_under,
    hide_depth,
    move_reveals,
    path_visible,
    show_depth,
    shown_mode,
    var_hidden,
)
from mirage.workspace.session.session import SessionState

CORPUS = (
    Path(__file__).resolve().parents[3] / "integ" / "policy" / "matching.json"
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
        vis = Visibility(
            paths=classify_paths(case["hide"]),
            shown=classify_shows(
                ShowEntry(
                    path=v["path"],
                    mode=MountMode(v["mode"]) if v["mode"] else None,
                )
                for v in case["show"]
            ),
            vars=classify_vars(case["vars"]),
        )
        for query in case["queries"]:
            path = query["path"]
            assert path_visible(vis, path) == query["visible"]
            assert hide_depth(vis.paths, path) == query["hide_depth"]
            assert show_depth(vis.shown, path) == query["show_depth"]
            mode = shown_mode(vis.shown, path)
            assert (
                None if mode is None else [mode[0], mode[1].value]
            ) == query["mode"]
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
        paths = tuple(_path(v) for v in facts["paths"])
        ctx = CommandContext(
            command=facts["command"],
            paths=paths,
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


def test_native_boundaries_reject_invalid_units_modes_and_rule_indices():
    with pytest.raises(ValueError, match="past U\\+10FFFF"):
        PolicyAdmission((None, (((), (), (), (0x110000,)),), ()), False)
    with pytest.raises(ValueError, match="invalid policy mode"):
        PolicyVisibility((((), ()), (((47,), 9),), ((), ())))
    matcher = PolicyAdmission((None, (), ()), False)
    with pytest.raises(ValueError, match="invalid policy rule index"):
        matcher.posix_level(0)


def test_native_answers_keep_original_rule_objects_and_cached_plan_lifetimes():
    rule = CommandRule(reason="review", paths=("/repo/*",))
    rules = AdmissionRules(ask=(rule,))
    ctx = CommandContext(
        command="cat", paths=(_path("/repo/x"),), argv=(), cwd="/"
    )
    result = decide(ctx, rules)
    assert result.rule is rule
    assert result.asks[0] is rule
    retained = admission_matcher(rules)
    admission_matcher.cache_clear()
    assert retained.head_allowed((99, 97, 116))
    assert decide(ctx, rules).rule is rule


def test_restored_visibility_retains_component_depth_and_surrogate_text():
    vis = Visibility(
        paths=HiddenPaths(patterns=("secret", "*.key")),
        shown=ShownPaths(entries=(ShowEntry("/secret"),)),
    )
    stored = SessionState(session_id="restored", visibility=vis).to_dict()
    restored = SessionState.from_dict(stored)
    assert restored.visibility is not None
    assert hide_depth(restored.visibility.paths, "/secret/x") == 0
    assert path_visible(restored.visibility, "/secret/x")
    assert not path_visible(restored.visibility, "/\ud800.key")
    assert not path_visible(restored.visibility, "/\U0001f600.key")
    retained = visibility_matcher(restored.visibility)
    visibility_matcher.cache_clear()
    assert retained.path_visible((47, 111, 112, 101, 110))


@pytest.mark.parametrize("kind", ("visibility", "admission"))
def test_native_matching_allows_another_python_thread_to_run(kind):
    patterns = ((42, 122),) * 1000
    if kind == "visibility":
        matcher = PolicyVisibility((((), patterns), (), ((), ())))
        evaluate = matcher.path_visible
        expected = True
    else:
        matcher = PolicyAdmission((patterns, (), ()), False)
        evaluate = matcher.head_allowed
        expected = False
    path = (47, *((97,) * 10000))
    ready = Event()
    start = Event()
    progressed = Event()

    def worker():
        ready.set()
        if start.wait(5):
            progressed.set()

    previous = sys.getswitchinterval()
    thread = Thread(target=worker)
    try:
        sys.setswitchinterval(1000)
        thread.start()
        assert ready.wait(5)
        start.set()
        assert evaluate(path) == expected
        assert progressed.is_set()
    finally:
        sys.setswitchinterval(previous)
        start.set()
        thread.join(5)
    assert not thread.is_alive()


@pytest.mark.parametrize("length", (255, 256, 257))
def test_text_cache_retains_only_short_queries(length):
    _short_units.cache_clear()
    value = "x" * length
    first = units(value)
    assert first == (120,) * length
    before = _short_units.cache_info()
    second = units(value)
    assert second == first
    after = _short_units.cache_info()
    if length <= 256:
        assert second is first
        assert after.currsize == 1
        assert after.hits == before.hits + 1
    else:
        assert after == before
        assert after.currsize == 0
    _short_units.cache_clear()


def test_large_inline_query_keeps_surrogates_without_retaining_text():
    _short_units.cache_clear()
    value = "x" * 100000 + "\U0001f600\ud800"
    expected = (120,) * 100000 + (0x1F600, 0xD800)
    assert units(value) == expected
    assert units(value) == expected
    assert _short_units.cache_info().currsize == 0
    rules = AdmissionRules(allow=("cat *",))
    context = CommandContext(command="cat", argv=(value,), paths=(), cwd="/")
    assert line_allowed(context, rules)
    before = _short_units.cache_info()
    assert line_allowed(context, rules)
    after = _short_units.cache_info()
    assert after.currsize == before.currsize
    assert after.misses == before.misses
    _short_units.cache_clear()
