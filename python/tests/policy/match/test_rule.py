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

import random
from typing import Any

import pytest

from mirage.policy.match.decide import decide
from mirage.policy.match.rule import (
    io_reach,
    io_refusal,
    naming_rules,
    skipped_at_dispatch,
)
from mirage.policy.types import AdmissionRules, CommandContext, Outcome
from tests.fixtures.command_trees import line, trees


def _verdict(
    rules: AdmissionRules, ctx: CommandContext
) -> tuple[Outcome, str | None]:
    ruling = decide(ctx, rules)
    return ruling.outcome, ruling.matched_path


def _refusal(
    rules: AdmissionRules | None, ctx: CommandContext, virtual: str, granted=()
) -> str | None:
    return io_refusal(rules, naming_rules(rules, ctx), virtual, granted)


def _reach(
    rules: AdmissionRules | None, ctx: CommandContext, virtual: str, granted=()
) -> bool:
    return io_reach(rules, naming_rules(rules, ctx), virtual, granted)


def test_a_mount_tree_reaches_a_line_by_its_cwd_or_its_paths():
    rules = trees(mounts={"/repo": {"rm": {"--force": "deny"}}})
    assert _verdict(rules, line("rm", "-f", "x", cwd="/repo/sub"))[0] is (
        Outcome.DENY
    )
    assert _verdict(rules, line("rm", "-f", "/repo/x", cwd="/s"))[0] is (
        Outcome.DENY
    )
    assert _verdict(rules, line("rm", "-f", "x", cwd="/s"))[0] is (
        Outcome.ALLOW
    )
    assert _verdict(rules, line("rm", "-f", "x", cwd="/repository"))[0] is (
        Outcome.ALLOW
    )


def test_a_walking_command_touches_the_mounts_under_its_operands():
    rules = trees(mounts={"/scratch/child": {"grep": "deny"}})
    assert _verdict(rules, line("grep", "-r", "x", "/scratch"))[0] is (
        Outcome.DENY
    )
    assert _verdict(rules, line("grep", "x", "/scratch"))[0] is Outcome.ALLOW
    assert _verdict(rules, line("grep", "-r", "x", "/scratch/f"))[0] is (
        Outcome.ALLOW
    )


def test_a_leafs_paths_read_the_one_path_grammar():
    prod = trees({"rm": {"decision": "deny", "paths": ["/data/prod"]}})
    for virtual in ("/data/prod", "/data/prod/x"):
        assert _verdict(prod, line("rm", virtual)) == (Outcome.DENY, virtual)
    assert _verdict(prod, line("rm", "/data/production"))[0] is Outcome.ALLOW
    keys = trees({"*": {"decision": "deny", "paths": ["*.key"]}})
    assert _verdict(keys, line("cat", "/a/b.key/c"))[0] is Outcome.DENY
    assert _verdict(keys, line("cat", "/a/b.keyx"))[0] is Outcome.ALLOW
    one = trees(
        {"*": {"decision": "deny", "paths": ["/d/?.txt", "/d/[ab].c"]}}
    )
    assert _verdict(one, line("cat", "/d/a.txt"))[0] is Outcome.DENY
    assert _verdict(one, line("cat", "/d/ab.txt"))[0] is Outcome.ALLOW
    assert _verdict(one, line("cat", "/d/b.c"))[0] is Outcome.DENY
    assert _verdict(one, line("cat", "/d/c.c"))[0] is Outcome.ALLOW


def test_a_subtree_command_on_the_directory_holding_the_scope_matches():
    rules = trees({"*": {"decision": "deny", "paths": ["/x/locked/*"]}})
    for words in (("rm", "-r"), ("rmdir",)):
        for operand in ("/x/locked", "/x"):
            assert _verdict(rules, line(*words, operand)) == (
                Outcome.DENY,
                operand,
            )
        assert _verdict(rules, line(*words, "/x/other"))[0] is Outcome.ALLOW
    assert _verdict(rules, line("mv", "/x", "/y")) == (Outcome.DENY, "/x")
    assert _verdict(rules, line("mv", "/z", "/x/locked")) == (
        Outcome.DENY,
        "/x/locked",
    )
    assert _verdict(rules, line("mv", "/z", "/x"))[0] is Outcome.ALLOW
    assert _verdict(rules, line("cat", "/x/locked"))[0] is Outcome.ALLOW
    assert _verdict(rules, line("cp", "-r", "/x", "/y"))[0] is Outcome.ALLOW


def test_io_refusal_judges_a_reached_file_as_one_more_path():
    rules = trees(
        {
            "rm": [
                {"decision": "deny", "reason": "keys", "paths": ["*.key"]},
                {"decision": "ask", "reason": "nod", "paths": ["/d/*"]},
            ]
        }
    )
    ctx = line("rm", "-r", "/d")
    nod = decide(ctx, rules).asks
    assert [a.reason for a in nod] == ["nod"]
    assert _refusal(rules, ctx, "/d/x.key", nod) == "keys"
    assert _refusal(rules, ctx, "/d/a") == "nod"
    assert _refusal(rules, ctx, "/d/a", nod) is None
    assert _refusal(rules, ctx, "/open/a") is None
    whole = trees({"rm": {"--recursive": "deny"}})
    assert _refusal(whole, line("rm", "/x"), "/x/y") is None
    assert _refusal(None, ctx, "/d/a") is None


def test_io_reach_reads_each_start_point_on_its_own():
    rules = trees(
        {
            "*": {"decision": "deny", "paths": ["/repo/.env"]},
            "rm": {"decision": "ask", "paths": ["/data/*"]},
        }
    )
    find = line("find", "/repo", "/s3", "/data")
    assert _reach(rules, find, "/repo")
    assert _reach(rules, find, "/repo/.env")
    assert not _reach(rules, find, "/s3")
    assert not _reach(rules, find, "/data")
    assert _reach(rules, line("rm", "-r", "/data"), "/data")
    whole = trees({"rm": "deny"})
    assert not _reach(whole, line("rm", "-r", "/data"), "/data")
    assert not _reach(None, find, "/repo")


def test_a_mount_trees_leaf_with_no_paths_reaches_its_mount():
    rules = trees(
        {"grep": "ask"},
        mounts={
            "/repo/private": {
                "git": {"decision": "deny", "reason": "private"}
            },
            "/repo/open": {"git": "allow"},
        },
    )
    git = line("git", "cat-file", "-p", "x", cwd="/repo")
    assert _reach(rules, git, "/repo")
    assert _reach(rules, git, "/repo/private/s.txt")
    assert not _reach(rules, git, "/repo/open")
    assert not _reach(rules, git, "/other")
    assert _refusal(rules, git, "/repo/private/s.txt") == "private"
    assert _refusal(rules, git, "/repo/pub.txt") is None
    assert not _reach(rules, line("grep", "-r", "x", "/repo"), "/repo")


def test_skipped_at_dispatch_names_every_tree():
    rules = trees({"rm": "deny"}, mounts={"/a": {"cp": "deny"}})
    assert skipped_at_dispatch(rules) == ("commands", "mounts./a.commands")
    assert skipped_at_dispatch(None) == ()


def test_io_reach_skips_an_ask_the_line_holds_a_grant_for():
    rules = trees({"rm": {"decision": "ask", "paths": ["/data/*"]}})
    rm = line("rm", "-rf", "/data")
    nod = decide(rm, rules).asks
    assert _reach(rules, rm, "/data")
    assert not _reach(rules, rm, "/data", nod)
    assert not _reach(rules, rm, "/data/sub", nod)
    kept = trees(
        {
            "rm": [
                {"decision": "ask", "paths": ["/data/*"]},
                {"decision": "deny", "paths": ["*.pem"]},
            ]
        }
    )
    nod = decide(rm, kept).asks
    assert nod
    assert _reach(kept, rm, "/data", nod)
    assert _reach(kept, rm, "/data/sub", nod)


_PATTERNS = (
    "/dir/*",
    "/dir/**",
    "/dir",
    "/dir/",
    "/dir/secret/*",
    "/dir/secret",
    "/dir/a/*",
    "/dir/a",
    "/dir2/*",
    "/*",
    "/",
    "*.pem",
    "secret",
    "/dir/*/x.pem",
    "/dir/a/x.pem",
    "/dir/s*",
    "*",
    "/dir/a/b/*",
    "/other/*",
    "k.*",
)
_UNIVERSE = (
    "/",
    "/dir",
    "/dir/a",
    "/dir/a/x.pem",
    "/dir/a/b",
    "/dir/a/b/c.txt",
    "/dir/secret",
    "/dir/secret/k.pem",
    "/dir/secret/deep",
    "/dir/secret/deep/k.txt",
    "/dir/s1",
    "/dir/s1/f",
    "/dir2",
    "/dir2/y.pem",
    "/dir2/secret",
    "/dir2/secret/z",
    "/other",
    "/other/z.txt",
    "/secret",
    "/x.pem",
)
_DECISIONS = ("allow", "deny", "ask")


def _random_leaf(rnd: random.Random) -> Any:
    decision = rnd.choice(_DECISIONS)
    if rnd.random() < 0.25:
        return decision
    return {
        "decision": decision,
        "paths": rnd.sample(_PATTERNS, rnd.choice([1, 1, 2])),
    }


def _random_entry(rnd: random.Random) -> Any:
    if rnd.random() < 0.55:
        return _random_leaf(rnd)
    leaves = [_random_leaf(rnd) for _ in range(rnd.choice([2, 2, 3]))]
    return [x for x in leaves if isinstance(x, dict)] or _random_leaf(rnd)


def _random_block(rnd: random.Random) -> dict[str, Any]:
    block: dict[str, Any] = {}
    if rnd.random() < 0.6:
        block["*"] = (
            _random_entry(rnd)
            if rnd.random() < 0.5
            else rnd.choice(_DECISIONS)
        )
    if rnd.random() < 0.9:
        block["grep"] = _random_entry(rnd)
    return block


def _at_or_under(virtual: str, root: str) -> bool:
    return (
        virtual == root
        or root == "/"
        or virtual.startswith(root.rstrip("/") + "/")
    )


@pytest.mark.parametrize("seed", [1, 2, 3, 4, 5])
def test_io_reach_covers_every_entry_io_refusal_refuses_below_it(seed):
    rnd = random.Random(seed)
    checks = 0
    violations = []
    for _ in range(300):
        commands = _random_block(rnd)
        mounts = {}
        if rnd.random() < 0.3:
            mounts[rnd.choice(["/dir", "/dir2", "/dir/secret"])] = (
                _random_block(rnd)
            )
        if not commands and not mounts:
            continue
        operand = rnd.choice(_UNIVERSE)
        rules = trees(commands or None, mounts or None)
        ctx = line("grep", "-r", "x", operand)
        verdict = decide(ctx, rules)
        if verdict.outcome is Outcome.DENY:
            continue
        granted = verdict.asks if verdict.outcome is Outcome.ASK else ()
        named = naming_rules(rules, ctx)
        refused = {
            p for p in _UNIVERSE if io_refusal(rules, named, p, granted)
        }
        for root in (u for u in _UNIVERSE if _at_or_under(u, operand)):
            checks += 1
            if io_reach(rules, named, root, granted):
                continue
            hit = [p for p in refused if _at_or_under(p, root)]
            if hit:
                violations.append((commands, mounts, operand, root, hit))
    assert checks > 0
    assert violations == []
