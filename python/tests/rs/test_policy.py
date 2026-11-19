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
from types import MappingProxyType

import pytest

from mirage.commands.spec.types import WordKind
from mirage.policy.match.decide import decide
from mirage.policy.profile import command_tree
from mirage.policy.types import (
    AdmissionRules,
    CommandContext,
    CommandNode,
    CommandWord,
    ScopedTree,
)
from mirage.rs.document import units
from mirage.rs.errors import StreamRefusal
from mirage.rs.policy import (
    Encoded,
    admission_matcher,
    request,
    visibility_matcher,
)
from mirage.rs.stream import open_stream
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


def test_shared_matching_corpus():
    corpus = json.loads(CORPUS.read_text())
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
        rules = AdmissionRules(
            tuple(
                ScopedTree(command_tree(tree["commands"]), tree["mount"] or "")
                for tree in case["trees"]
            )
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
            subtree=facts["subtree"],
            words=tuple(
                CommandWord(kind=WordKind.OPERAND, path=_path(v), text=v)
                for v in facts["operands"]
            ),
        )
        result = decide(ctx, rules)
        expected = case["expected"]
        name = case["name"]
        assert result.outcome.value == expected["outcome"], name
        assert (None if result.rule is None else result.rule.at) == expected[
            "at"
        ], name
        assert result.matched_path == expected["matched_path"], name
        assert result.source == expected["source"], name
        assert [a.at for a in result.asks] == expected["asks"], name


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
        admission_matcher(None).ask(
            "io_refusal",
            walked=[{"tree": 0, "branches": []}],
            path=units("/x"),
            granted=[],
        )


def test_shared_composition_transcripts():
    corpus = json.loads(CORPUS.with_name("composition.json").read_text())
    for case in corpus["cases"]:
        stream = open_stream("policy_compose", {})
        try:
            assert stream.feed(json.dumps(case["input"]).encode()) == b""
            assert stream.finish() == b""
            for index, effect in enumerate(case["effects"], start=1):
                request = stream.request()
                assert request is not None, case["name"]
                header, data = request
                assert header == {
                    **effect["request"],
                    "evaluation": case["input"]["evaluation"],
                    "effect": index,
                }, case["name"]
                assert data == b""
                assert stream.request() is None
                assert (
                    stream.respond(
                        {
                            **effect["reply"],
                            "evaluation": header["evaluation"],
                            "effect": header["effect"],
                        },
                        b"",
                    )
                    == b""
                )
            assert stream.request() is None
            output = stream.finish()
            assert json.loads(output) == case["expected"], case["name"]
        finally:
            stream.cancel()


def test_a_request_places_an_encoded_field_as_written():
    reads = Encoded('[{"pattern": [114], "read": null}]')
    sent = json.loads(request("decide", {"facts": {"reads": reads}, "n": 1}))
    assert sent == {
        "op": "decide",
        "facts": {"reads": [{"pattern": [114], "read": None}]},
        "n": 1,
    }
    with pytest.raises(TypeError, match="not JSON"):
        request("decide", {"facts": Path("/x")})


def test_a_tree_node_refuses_a_change_in_place():
    tree = command_tree({"rm": "deny"})
    rules = AdmissionRules((ScopedTree(tree),))
    matcher = admission_matcher(rules)
    with pytest.raises(TypeError):
        tree.subcommands["cat"] = tree  # type: ignore[index]
    with pytest.raises(TypeError):
        tree.subcommands["rm"].operands["x"] = tree  # type: ignore[index]
    assert admission_matcher(rules) is matcher
    assert matcher.ask("runs", name=units("rm")) is False


def test_a_tree_node_copies_a_mapping_proxy_it_is_given():
    backing = dict(command_tree({"rm": "deny"}).subcommands)
    node = CommandNode(subcommands=MappingProxyType(backing))
    held = hash(node)
    backing.clear()
    assert list(node.subcommands) == ["rm"]
    assert hash(node) == held
