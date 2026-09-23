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

from mirage.policy.match.rule import (RuleMatch, Subject, io_refusal, match_io,
                                      match_op, match_rule, op_refusal,
                                      rule_reach, rule_scope, subjects)
from mirage.policy.types import (AdmissionRules, CommandContext, CommandRule,
                                 OpsContext)
from mirage.types import PathSpec
from mirage.utils.hidden import classify_paths


class _Registry:

    def is_mount_root(self, path: str) -> bool:
        return False


def _path(virtual: str, raw: str = "") -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    vfs_path=virtual,
                    resolved=True,
                    raw_path=raw)


def _ctx(command: str,
         paths: tuple[PathSpec, ...] = (),
         cwd: str = "/",
         tokens: tuple[str, ...] = (),
         walks: bool = False) -> CommandContext:
    return CommandContext(command=command,
                          paths=paths,
                          argv=(),
                          cwd=cwd,
                          registry=_Registry(),
                          tokens=tokens,
                          walks=walks)


def test_match_rule_by_command_pattern_operand_and_mount():
    whole = CommandRule(reason="no", commands=("git push", ))
    assert match_rule(whole, None,
                      _ctx("git",
                           tokens=("git", "push",
                                   "origin"))) == RuleMatch(operand=None)
    assert match_rule(whole, None, _ctx("git", tokens=("git", "pull"))) is None
    scoped = CommandRule(reason="no", commands=("rm", ), paths=("/repo/*", ))
    scope = classify_paths(scoped.paths)
    hit = match_rule(
        scoped, scope,
        _ctx("rm", paths=(_path("/repo/x", raw="x"), ), cwd="/repo"))
    # The depth is the matched entry's, which is what the path axis
    # orders by.
    assert hit == RuleMatch(operand="x", depth=1)
    assert match_rule(scoped, scope,
                      _ctx("rm", paths=(_path("/scratch/x"), ))) is None
    # A mount-tier rule applies to a line whose cwd or paths lie under
    # the mount, and to nothing else.
    mount = CommandRule(reason="ro", commands=("git push", ), mount="/repo")
    assert match_rule(mount, None,
                      _ctx("git", tokens=("git", "push"),
                           cwd="/repo/sub")) is not None
    assert match_rule(
        mount, None,
        _ctx("git",
             tokens=("git", "push"),
             cwd="/scratch",
             paths=(_path("/repo"), ))) is not None
    assert match_rule(mount, None,
                      _ctx("git", tokens=("git", "push"),
                           cwd="/scratch")) is None
    assert match_rule(mount, None,
                      _ctx("git", tokens=("git", "push"),
                           cwd="/repository")) is None
    # An every-command rule (no patterns) matches whatever line.
    assert match_rule(CommandRule(reason="locked"), None,
                      _ctx("ls")) is not None


def test_a_walking_command_touches_the_mounts_under_its_operands():
    # `grep -r x /scratch` enters `/scratch/child`: the fan-out reruns
    # the traversal inside each descendant mount and no admission fires
    # again there, so the ancestor operand is where the mount's rule
    # speaks. A command that does not walk, or an operand that is not
    # above the root, stays untouched.
    mount = CommandRule(reason="boxed", mount="/scratch/child")
    assert match_rule(mount, None,
                      _ctx("grep", paths=(_path("/scratch"), ),
                           walks=True)) == RuleMatch(operand=None)
    assert match_rule(mount, None, _ctx("grep",
                                        paths=(_path("/scratch"), ))) is None
    assert match_rule(
        mount, None,
        _ctx("grep", paths=(_path("/scratch/file.txt"), ), walks=True)) is None


def test_match_op_only_for_pure_path_rules():
    rule = CommandRule(reason="frozen", paths=("/data/locked/*", ))
    scope = classify_paths(rule.paths)
    op = OpsContext(op="write",
                    path=_path("/data/locked/a"),
                    write=True,
                    prefix="/data/")
    assert match_op(rule, scope, op)
    assert not match_op(
        rule, scope,
        OpsContext(op="write",
                   path=_path("/data/open/a"),
                   write=True,
                   prefix="/data/"))
    named = CommandRule(reason="x", commands=("rm", ), paths=("/data/*", ))
    assert not match_op(named, classify_paths(named.paths), op)
    assert not match_op(CommandRule(reason="x", commands=("rm", )), None, op)


def test_op_refusal_reads_depth_before_verb_and_honours_a_grant():
    broad = CommandRule(reason="repo is sealed", paths=("/repo/*", ))
    carve = CommandRule(reason="outbox nod", paths=("/repo/outbox/*", ))
    rules = AdmissionRules(deny=(broad, ), ask=(carve, ))
    inside = OpsContext(op="write",
                        path=_path("/repo/outbox/a"),
                        write=True,
                        prefix="/repo/")
    # The deeper ask wins where both reach, exactly as the command door
    # ranks them, so a broad deny cannot overrule an approved carve-out.
    assert op_refusal(rules, inside, ()) == "outbox nod"
    assert op_refusal(rules, inside, (carve, )) is None
    # Outside the carve-out the deny is what is left, and a grant for
    # the ask says nothing about it.
    outside = OpsContext(op="write",
                         path=_path("/repo/sealed/a"),
                         write=True,
                         prefix="/repo/")
    assert op_refusal(rules, outside, (carve, )) == "repo is sealed"
    # A metadata op is reached by neither: deny is present and refused.
    stat = OpsContext(op="stat",
                      path=_path("/repo/outbox/a"),
                      write=False,
                      prefix="/repo/")
    assert op_refusal(rules, stat, ()) is None
    # No rules at all, and a rule naming a command, are both silent.
    assert op_refusal(None, inside, ()) is None
    named = AdmissionRules(deny=(
        CommandRule(reason="x", commands=("rm", ), paths=("/repo/*", )), ))
    assert op_refusal(named, inside, ()) is None


def _subtree_ctx(command: str, *operands: str) -> CommandContext:
    paths = tuple(_path(o, raw=o) for o in operands)
    return CommandContext(command=command,
                          paths=paths,
                          operands=paths,
                          argv=operands,
                          cwd="/",
                          registry=_Registry(),
                          tokens=(command, *operands))


def test_a_subtree_command_on_the_directory_holding_the_scope_matches():
    # `/x/locked/*` protects the children; `rm -r /x/locked`, `rm -r /x`
    # and `mv /x/locked elsewhere` take them along, so for rm, rmdir and
    # mv the operand at or above the holding directory matches.
    rule = CommandRule(reason="frozen", paths=("/x/locked/*", ))
    scope = classify_paths(rule.paths)
    for command in ("rm", "rmdir"):
        for operand in ("/x/locked", "/x", "/"):
            assert match_rule(rule, scope, _subtree_ctx(
                command, operand)) == RuleMatch(operand=operand, depth=2)
        assert match_rule(rule, scope, _subtree_ctx(command,
                                                    "/x/other")) is None
    assert match_rule(rule, scope,
                      _subtree_ctx("mv", "/x/locked",
                                   "/y")) == RuleMatch(operand="/x/locked",
                                                       depth=2)
    assert match_rule(rule, scope,
                      _subtree_ctx("mv", "/x",
                                   "/y")) == RuleMatch(operand="/x", depth=2)
    # mv's destination matches only as the holding directory itself:
    # moving into it lands in the scope, moving into an ancestor does not.
    assert match_rule(rule, scope, _subtree_ctx(
        "mv", "/z", "/x/locked")) == RuleMatch(operand="/x/locked", depth=2)
    assert match_rule(rule, scope, _subtree_ctx("mv", "/z", "/x")) is None
    # A reader given the same operand is not a whole-line refusal: its
    # I/O under the scope is the command tier's to refuse, file by file.
    assert match_rule(rule, scope, _subtree_ctx("cat", "/x/locked")) is None
    assert match_rule(rule, scope, _subtree_ctx("cp", "/x", "/y")) is None
    # A command-scoped rule judges its own command the same way.
    named = CommandRule(reason="locked",
                        commands=("rm", ),
                        paths=("/x/locked/*", ))
    assert match_rule(named, classify_paths(named.paths),
                      _subtree_ctx("rm", "/x")) == RuleMatch(operand="/x",
                                                             depth=2)
    assert match_rule(named, classify_paths(named.paths),
                      _subtree_ctx("mv", "/x", "/y")) is None


def test_subjects_are_the_lines_paths_then_its_subtree_operands():
    # A reader is asked one question per path: does it lie inside a
    # scope. A subtree command is asked a second, per operand: does it
    # hold one. `mv`'s destination is the operand where an ancestor of
    # the scope does not count.
    read = subjects(_subtree_ctx("cat", "/a", "/b"))
    assert [(s.path.virtual, s.holds) for s in read] == [("/a", False),
                                                         ("/b", False)]
    moved = subjects(_subtree_ctx("mv", "/a", "/b"))
    assert [(s.path.virtual, s.holds, s.ancestors) for s in moved] == [
        ("/a", False, True),
        ("/b", False, True),
        ("/a", True, True),
        ("/b", True, False),
    ]
    # A line naming no path is one subject, itself.
    bare = subjects(_ctx("git", tokens=("git", "push")))
    assert len(bare) == 1 and bare[0].path is None


def test_rule_reach_scores_the_entry_that_reached_and_no_other():
    inside = CommandRule(reason="x", paths=("/a/*", "/deep/b/c/*"))
    scope = rule_scope(inside)
    assert rule_reach(inside, scope, Subject(_path("/a/x"))) == 1
    assert rule_reach(inside, scope, Subject(_path("/deep/b/c/x"))) == 3
    assert rule_reach(inside, scope, Subject(_path("/elsewhere"))) is None
    # A rule naming no paths reaches every subject at depth 0, which is
    # off the path axis, and a line's own subject only through one.
    pathless = CommandRule(reason="x")
    assert rule_reach(pathless, None, Subject(_path("/a/x"))) == 0
    assert rule_reach(pathless, None, Subject(None)) == 0
    assert rule_reach(inside, scope, Subject(None)) is None
    # Holding the scope is the subtree operand's question alone.
    assert rule_reach(inside, scope, Subject(_path("/"))) is None
    assert rule_reach(inside, scope, Subject(_path("/"), holds=True)) == 3


def test_match_op_refuses_a_subtree_op_on_the_directory_holding_the_scope():
    rule = CommandRule(reason="frozen", paths=("/data/locked/*", ))
    scope = classify_paths(rule.paths)
    for op, virtual in (("rename", "/data/locked"), ("rename", "/data"),
                        ("rmdir", "/data/locked"), ("rm_r", "/data")):
        assert match_op(
            rule, scope,
            OpsContext(op=op, path=_path(virtual), write=True,
                       prefix="/data/"))
    # A read or write of the directory itself is not in the scope, and a
    # subtree op beside the scope is not either.
    assert not match_op(
        rule, scope,
        OpsContext(op="readdir",
                   path=_path("/data/locked"),
                   write=False,
                   prefix="/data/"))
    assert not match_op(
        rule, scope,
        OpsContext(op="rename",
                   path=_path("/data/other"),
                   write=True,
                   prefix="/data/"))


def test_match_op_lets_a_metadata_op_through():
    # Deny is present and refused: the entry stats, the read is refused.
    rule = CommandRule(reason="frozen", paths=("/data/locked/*", ))
    scope = classify_paths(rule.paths)
    for op in ("stat", "exists"):
        assert not match_op(
            rule, scope,
            OpsContext(op=op,
                       path=_path("/data/locked/a"),
                       write=False,
                       prefix="/data/"))
    assert match_op(
        rule, scope,
        OpsContext(op="read",
                   path=_path("/data/locked/a"),
                   write=False,
                   prefix="/data/"))


def test_match_io_names_the_line_and_holds_the_entry():
    pure = CommandRule(reason="sealed", paths=("/data/sealed", ))
    scope = rule_scope(pure)
    assert match_io(pure, scope, ("grep", "-r", "x", "/data"),
                    "/data/sealed/deep/f")
    assert match_io(pure, scope, ("du", "/data"), "/data/sealed")
    assert not match_io(pure, scope, ("du", "/data"), "/data/open/f")
    # A command-scoped rule reads the line's tokens, so a pattern with a
    # token after the name applies only to the line that carries it.
    scoped = CommandRule(reason="no",
                         commands=("grep -r", ),
                         paths=("/data/private", ))
    assert match_io(scoped, rule_scope(scoped), ("grep", "-r", "k", "/data"),
                    "/data/private/k")
    assert not match_io(scoped, rule_scope(scoped),
                        ("grep", "k", "/data"), "/data/private/k")
    assert not match_io(scoped, rule_scope(scoped),
                        ("cat", "/data"), "/data/private/k")
    # A whole-line rule spoke at admission and says nothing at an entry;
    # the directory holding a children pattern is not in it.
    whole = CommandRule(reason="no", commands=("rm", ))
    assert not match_io(whole, rule_scope(whole), ("rm", "/data/x"), "/data/x")
    children = CommandRule(reason="frozen", paths=("/data/locked/*", ))
    assert not match_io(children, rule_scope(children),
                        ("ls", "/data"), "/data/locked")
    assert match_io(children, rule_scope(children), ("ls", "/data"),
                    "/data/locked/y")


def test_rule_scope_is_none_for_a_whole_line_rule_and_remembered():
    whole = CommandRule(reason="no", commands=("rm", ))
    assert rule_scope(whole) is None
    scoped = CommandRule(reason="no", paths=("/data/*", ))
    assert rule_scope(scoped) is rule_scope(
        CommandRule(reason="no", paths=("/data/*", )))


def test_io_refusal_applies_the_gate_precedence_to_an_entry():
    deny = CommandRule(reason="locked",
                       commands=("rm", ),
                       paths=("/data/both/locked/*", ))
    ask = CommandRule(reason="needs a nod",
                      commands=("rm", ),
                      paths=("/data/both/*", ))
    later = CommandRule(reason="a later nod",
                        commands=("rm", ),
                        paths=("/data/both/*", ))
    rules = AdmissionRules(ask=(ask, later), deny=(deny, ))
    tokens = ("rm", "-r", "/data/both")
    # deny > ask, wherever either was written.
    assert io_refusal(rules, tokens, "/data/both/locked/y",
                      (ask, )) == "locked"
    # The first matching ask rule speaks: refused without a grant under
    # it, passed with one, and the later rule never gets a say.
    assert io_refusal(rules, tokens, "/data/both/a", ()) == "needs a nod"
    assert io_refusal(rules, tokens, "/data/both/a", (ask, )) is None
    assert io_refusal(rules, tokens, "/data/both/a",
                      (later, )) == "needs a nod"
    # An entry no rule holds passes; so does one a whole-line rule names.
    assert io_refusal(rules, tokens, "/data/open/a", ()) is None
    whole = AdmissionRules(
        deny=(CommandRule(reason="no", commands=("rm", )), ))
    assert io_refusal(whole, tokens, "/data/x", ()) is None
    assert io_refusal(None, tokens, "/data/x", ()) is None


def test_io_refusal_orders_by_anchor_depth_like_the_admission_gate():
    # A broad deny with an approved ask carved out of it. The gate
    # admits `rm -r /repo` under the deeper ask, so the entry gate has
    # to read the same way: taking every deny before any ask would
    # refuse every entry the carve-out was written for, leaving a line
    # that was admitted unable to touch anything.
    deny = CommandRule(reason="ro repo",
                       commands=("rm", ),
                       paths=("/repo/*", ))
    ask = CommandRule(reason="sealed",
                      commands=("rm", ),
                      paths=("/repo/sealed/*", ))
    rules = AdmissionRules(ask=(ask, ), deny=(deny, ))
    tokens = ("rm", "-r", "/repo")
    assert io_refusal(rules, tokens, "/repo/sealed/secret", (ask, )) is None
    # Without the grant the deeper ask still wins, and asks.
    assert io_refusal(rules, tokens, "/repo/sealed/secret", ()) == "sealed"
    # Outside the carve-out the broad deny is what is left.
    assert io_refusal(rules, tokens, "/repo/other/x", (ask, )) == "ro repo"
