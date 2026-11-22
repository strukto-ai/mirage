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

import dataclasses

from mirage.policy.match.decide import decide, redirect_ruling, source_of
from mirage.policy.types import AdmissionRules, Outcome, Ruling
from tests.fixtures.command_trees import line, path, trees


def test_no_tree_allows_every_line():
    assert decide(line("ls"), None) == Ruling(Outcome.ALLOW)
    assert decide(line("ls"), AdmissionRules()) == Ruling(Outcome.ALLOW)


def test_a_closed_root_denies_what_it_names_no_allow_for():
    rules = trees({"*": "deny", "cat": "allow"})
    assert decide(line("cat", "/x"), rules).outcome is Outcome.ALLOW
    refused = decide(line("rm", "/x"), rules)
    assert refused.outcome is Outcome.DENY
    assert refused.rule is not None and refused.rule.at == "/*"
    assert refused.source == "top"


def test_an_option_tightens_its_command():
    rules = trees({"rm": {"-r": {"decision": "deny", "reason": "no trees"}}})
    assert decide(line("rm", "/x"), rules).outcome is Outcome.ALLOW
    for words in (("rm", "-r", "/x"), ("rm", "-rf", "/x"), ("rm", "-R", "/x")):
        ruling = decide(line(*words), rules)
        assert ruling.outcome is Outcome.DENY
        assert ruling.rule is not None
        assert ruling.rule.reason == "no trees"
        assert ruling.rule.at == "/rm/--recursive/*"


def test_a_mount_tree_reports_where_it_was_written():
    rules = trees(
        mounts={"/a": {"rm": {"decision": "deny", "paths": ["b/*"]}}}
    )
    ruling = decide(line("rm", "/a/b/x"), rules)
    assert ruling.outcome is Outcome.DENY
    assert ruling.rule is not None and ruling.rule.paths == ("/a/b/*",)
    assert ruling.source == "mounts./a"
    assert decide(line("rm", "/c/x"), rules).outcome is Outcome.ALLOW


def test_the_top_tree_and_inline_tree_are_judged_apart():
    rules = trees({"rm": "allow"}, inline={"rm": "deny"})
    assert decide(line("rm", "/x"), rules).outcome is Outcome.DENY


def test_source_of_names_the_section():
    rules = trees({"rm": "deny"}, mounts={"/a": {"cp": "deny"}})
    top = decide(line("rm"), rules).rule
    inside = decide(line("cp", "/a/x"), rules).rule
    assert top is not None and source_of(top) == "top"
    assert inside is not None and source_of(inside) == "mounts./a"


def test_a_redirect_inside_a_folder_meets_the_folders_star():
    rules = trees({"*": "allow"}, mounts={"/d/keep": {"*": "deny"}})
    ruling = redirect_ruling([path("/d/out"), path("/d/keep/f.txt")], rules)
    assert ruling.outcome is Outcome.DENY
    assert ruling.matched_path == "/d/keep/f.txt"
    assert ruling.source == "mounts./d/keep"
    assert redirect_ruling([path("/d/out")], rules).outcome is Outcome.ALLOW
    asks = trees(mounts={"/d/keep": {"*": "ask"}})
    asked = redirect_ruling([path("/d/keep/f.txt")], asks)
    assert asked.outcome is Outcome.ASK
    assert len(asked.asks) == 1


def test_a_redirect_meets_no_named_command_of_a_folder():
    rules = trees(mounts={"/d/keep": {"cat": "deny", "echo": "deny"}})
    ruling = redirect_ruling([path("/d/keep/f.txt")], rules)
    assert ruling.outcome is Outcome.ALLOW


def test_a_walk_over_a_folder_leaves_it_to_its_entries():
    rules = trees({"*": "allow"}, mounts={"/d/w/keep": {"*": "deny"}})
    walk = line("grep", "-r", "x", "/d")
    assert walk.walks and walk.walks_into == ()
    assert decide(walk, rules).outcome is Outcome.ALLOW
    into = dataclasses.replace(walk, walks_into=("/d/w",))
    assert decide(into, rules).outcome is Outcome.DENY
    inside = line("grep", "-r", "x", "/d/w/keep/a")
    assert decide(inside, rules).outcome is Outcome.DENY
    assert decide(line("rm", "-r", "/d"), rules).outcome is Outcome.DENY
