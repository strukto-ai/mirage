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


from pathlib import Path
import json

from mirage.commands.spec.types import WordKind
from mirage.policy.match.decide import decide
from mirage.policy.match.pattern import pattern_matches, pattern_reaches, split_pattern
from mirage.policy.types import AdmissionRules, CommandContext, CommandRule, CommandWord
from mirage.types import MountMode, PathSpec, ShowEntry, Visibility
from mirage.utils.hidden import (
    classify_paths, classify_shows, classify_vars, hide_depth, hidden_under,
    move_reveals, path_visible, show_depth, shown_mode, var_hidden,
)

CORPUS = Path(__file__).resolve().parents[3] / "integ" / "policy" / "matching.json"


def test_shared_matching_corpus():
    corpus = json.loads(CORPUS.read_text())
    for case in corpus["patterns"]:
        assert list(split_pattern(case["pattern"])) == case["split"]
        assert pattern_matches(case["pattern"], case["tokens"]) == case["matches"]
        assert pattern_reaches(case["pattern"], case["tokens"]) == case["reaches"]
    for case in corpus["visibility"]:
        vis = Visibility(
            paths=classify_paths(case["hide"]),
            shown=classify_shows(ShowEntry(path=v["path"], mode=MountMode(v["mode"]) if v["mode"] else None) for v in case["show"]),
            vars=classify_vars(case["vars"]),
        )
        for query in case["queries"]:
            path = query["path"]
            assert path_visible(vis, path) == query["visible"]
            assert hide_depth(vis.paths, path) == query["hide_depth"]
            assert show_depth(vis.shown, path) == query["show_depth"]
            mode = shown_mode(vis.shown, path)
            assert (None if mode is None else [mode[0], mode[1].value]) == query["mode"]
            assert hidden_under(vis, path) == query["hidden_under"]
        for move in case["moves"]:
            assert move_reveals(vis, move["src"], move["dst"]) == move["reveals"]
        for var in case["variables"]:
            assert var_hidden(vis, var["name"]) == var["hidden"]
    for case in corpus["admissions"]:
        rule_doc = case["rules"]
        deny = tuple(_rule(v) for v in rule_doc["deny"])
        ask = tuple(_rule(v) for v in rule_doc["ask"])
        rules = AdmissionRules(allow=None if rule_doc["allow"] is None else tuple(rule_doc["allow"]), deny=deny, ask=ask)
        facts = case["facts"]
        paths = tuple(_path(v) for v in facts["paths"])
        ctx = CommandContext(
            command=facts["command"], paths=paths, argv=tuple(facts["paths"]),
            cwd=facts["cwd"], tokens=tuple(facts["tokens"]), tool=facts["tool"], walks=facts["walks"],
            words=tuple(CommandWord(kind=WordKind.OPERAND, path=_path(v), text=v) for v in facts["operands"]),
        )
        result = decide(ctx, rules)
        listed = (*deny, *ask)
        expected = case["expected"]
        assert result.outcome.value == expected["outcome"], case["name"]
        assert next((i for i, rule in enumerate(listed) if rule is result.rule), None) == expected["rule"]
        assert result.matched_path == expected["matched_path"]
        assert result.source == expected["source"]
        assert [next(i for i, rule in enumerate(listed) if rule is a) for a in result.asks] == expected["asks"]


def _path(value: str) -> PathSpec:
    return PathSpec(virtual=value, directory=value.rsplit("/", 1)[0] or "/", vfs_path=value, resolved=True, raw_path=value)


def _rule(value) -> CommandRule:
    return CommandRule(**{k: tuple(v) if isinstance(v, list) else v for k, v in value.items()})
