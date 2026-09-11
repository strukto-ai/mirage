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

import pytest

from mirage.policy import (AdmissionRules, Ask, CommandContext, CommandRule,
                           Deny, DenyScope, OpsContext, PermissionsPolicy,
                           Policies)
from mirage.types import PathSpec


class _Registry:

    def is_mount_root(self, path: str) -> bool:
        return False


class _Sessions:
    """A SessionCommandsQuery: one compiled document per session id."""

    def __init__(self, rules: dict[str, AdmissionRules]) -> None:
        self.rules = rules

    def commands_of(self, session_id: str) -> AdmissionRules | None:
        return self.rules.get(session_id)


def _path(virtual: str, raw: str = "") -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path=virtual,
                    resolved=True,
                    raw_path=raw)


def _ctx(command: str,
         *args: str,
         paths: tuple[PathSpec, ...] = (),
         cwd: str = "/",
         session_id: str = "s",
         program: tuple[str, ...] = (),
         tool: bool = True) -> CommandContext:
    return CommandContext(command=command,
                          paths=paths,
                          argv=tuple(args),
                          cwd=cwd,
                          registry=_Registry(),
                          session_id=session_id,
                          tokens=(command, *args),
                          program=program or (command, ),
                          tool=tool)


# One profile, compiled: its own rules plus the ones its `mounts./repo`
# section carries, which the compiler stamped with that root.
MOUNT_DENY = CommandRule(reason="history is read-only here",
                         commands=("git push", ),
                         mount="/repo")
ASK_PUSH = CommandRule(reason="sign-off", commands=("git push", ))
FULL = AdmissionRules(
    allow=("ls", "cat", "rm", "git", "python3"),
    deny=(MOUNT_DENY,
          CommandRule(reason="no deletes in the repo",
                      commands=("rm", ),
                      paths=("/repo/*", )),
          CommandRule(reason="frozen", paths=("/repo/locked/*", ))),
    ask=(ASK_PUSH, ),
)
REVIEWER = AdmissionRules(allow=("ls", "cat", "git log", "git status"))


def _policy() -> PermissionsPolicy:
    return PermissionsPolicy(_Sessions({"s": FULL, "rev": REVIEWER}))


@pytest.mark.asyncio
async def test_no_rules_means_no_opinion():
    policy = PermissionsPolicy(_Sessions({}))
    assert await policy.pre_command(_ctx("rm", "-rf", "/")) is None
    assert await policy.pre_ops(
        OpsContext(op="unlink", path=_path("/x"), write=True,
                   prefix="/")) is None


@pytest.mark.asyncio
async def test_the_allow_list_refuses_a_visible_head_it_does_not_cover():
    policy = _policy()
    assert await policy.pre_command(_ctx("ls", "-la",
                                         session_id="rev")) is None
    assert await policy.pre_command(
        _ctx("git", "log", "-1", session_id="rev",
             program=("git", "log"))) is None
    # `git` is visible in the reviewer session (some git lines are
    # allowed) but `git push` matches nothing there: a whole-command
    # refusal naming the program, not "command not found".
    deny = await policy.pre_command(
        _ctx("git", "push", session_id="rev", program=("git", "push")))
    assert deny == Deny("git push is not allowed")
    # A word that is not a tool is never refused by an allow list.
    assert await policy.pre_command(
        _ctx("cd", "/x", session_id="rev", tool=False)) is None
    assert await policy.pre_command(_ctx("python3", "-c", "1")) is None


@pytest.mark.asyncio
async def test_a_deny_rule_speaks_by_scope_and_by_where_it_was_written():
    policy = _policy()
    # Whole-command rule: reason only, the door renders `git: policy
    # denied: ...` at 126. A mount section's rule applies when the line
    # works inside that mount (here by cwd).
    assert await policy.pre_command(
        _ctx("git", "push", cwd="/repo/sub",
             program=("git", "push"))) == Deny("history is read-only here")
    # Off the mount, the same line falls through to the ask rule: the
    # deny rules ran first and had no opinion.
    assert await policy.pre_command(
        _ctx("git", "push", cwd="/scratch",
             program=("git", "push"))) == Ask("sign-off", ASK_PUSH,
                                              (ASK_PUSH, ))
    # Operand-scoped rule: the operand as typed, in the GNU voice.
    assert await policy.pre_command(
        _ctx("rm", "x", paths=(_path("/repo/x", raw="x"), ),
             cwd="/repo")) == Deny("x: no deletes in the repo",
                                   DenyScope.OPERAND)
    assert await policy.pre_command(
        _ctx("rm", "/scratch/x", paths=(_path("/scratch/x"), ))) is None
    # A pure path rule refuses any command that names the path.
    assert await policy.pre_command(
        _ctx("cat", "/repo/locked/a", paths=(_path("/repo/locked/a"), ))
    ) == Deny("/repo/locked/a: frozen", DenyScope.OPERAND)


@pytest.mark.asyncio
async def test_the_deeper_anchor_wins_and_deny_breaks_a_tie():
    # The path axis: two rules matching one operand are ordered by how
    # many literal components each anchors, deepest first, and only a
    # tie is broken by the verb.
    deep = CommandRule(reason="sealed",
                       commands=("rm", ),
                       paths=("/repo/sealed/*", ))
    shallow = CommandRule(reason="needs a nod",
                          commands=("rm", ),
                          paths=("/repo/*", ))
    policy = PermissionsPolicy(
        _Sessions({"s": AdmissionRules(ask=(shallow, ), deny=(deep, ))}))
    assert await policy.pre_command(
        _ctx("rm", "/repo/sealed/y", paths=(_path("/repo/sealed/y"), ))
    ) == Deny("/repo/sealed/y: sealed", DenyScope.OPERAND)
    # Outside the deeper rule's anchor the shallow one is what is left.
    assert await policy.pre_command(
        _ctx("rm", "/repo/x",
             paths=(_path("/repo/x"), ))) == Ask("needs a nod", shallow,
                                                 (shallow, ))
    # The other way round: an ask anchored deeper than a deny wins, so a
    # profile can carve an exception out of a broad refusal.
    flipped = PermissionsPolicy(
        _Sessions({
            "s":
            AdmissionRules(ask=(CommandRule(reason="nod here",
                                            commands=("rm", ),
                                            paths=("/repo/sealed/*", )), ),
                           deny=(CommandRule(reason="no deletes",
                                             commands=("rm", ),
                                             paths=("/repo/*", )), ))
        }))
    answer = await flipped.pre_command(
        _ctx("rm", "/repo/sealed/y", paths=(_path("/repo/sealed/y"), )))
    assert isinstance(answer, Ask) and answer.reason == "nod here"


@pytest.mark.asyncio
async def test_an_unrelated_entry_does_not_lend_a_rule_its_depth():
    # The rule is scored by the entry that covered this operand, not by
    # its deepest entry. Scoring the deepest would let `/else/very/deep/*`
    # -- which says nothing about /repo -- carry the ask past a deny
    # anchored right at /repo/private, and an approval would then reopen
    # exactly what the deny sealed.
    ask = CommandRule(reason="review",
                      commands=("cat", ),
                      paths=("/repo/*", "/else/very/deep/*"))
    deny = CommandRule(reason="private",
                       commands=("cat", ),
                       paths=("/repo/private/*", ))
    policy = PermissionsPolicy(
        _Sessions({"s": AdmissionRules(ask=(ask, ), deny=(deny, ))}))
    assert await policy.pre_command(
        _ctx("cat", "/repo/private/x", paths=(_path("/repo/private/x"), ))
    ) == Deny("/repo/private/x: private", DenyScope.OPERAND)
    # The unrelated entry still speaks where it does anchor.
    answer = await policy.pre_command(
        _ctx("cat", "/else/very/deep/x", paths=(_path("/else/very/deep/x"), )))
    assert isinstance(answer, Ask) and answer.reason == "review"


@pytest.mark.asyncio
async def test_a_pathless_rule_is_read_by_verb_wherever_it_is_written():
    # The command axis, and the one thing it deliberately cannot say.
    # A rule naming no path scores nothing on the path axis even when a
    # mount section holds it, so "denied generally, asked inside one
    # mount" is inexpressible for a pathless rule: the deny wins. That
    # is correct for what such a rule covers in practice, an account CLI
    # that reaches a service and touches no mount at all.
    deny = CommandRule(reason="no branches", commands=("git branch", ))
    ask = CommandRule(reason="branches need a nod",
                      commands=("git branch", ),
                      mount="/repo")
    policy = PermissionsPolicy(
        _Sessions({"s": AdmissionRules(ask=(ask, ), deny=(deny, ))}))
    assert await policy.pre_command(
        _ctx("git", "branch", cwd="/repo",
             program=("git", "branch"))) == Deny("no branches")
    # Give the mount rule a path and it is on the other axis, where
    # being deeper is what lets it carve out the exception.
    scoped = CommandRule(reason="branches need a nod",
                         commands=("git branch", ),
                         paths=("/repo/wip/*", ),
                         mount="/repo")
    carved = PermissionsPolicy(
        _Sessions({"s": AdmissionRules(ask=(scoped, ), deny=(deny, ))}))
    answer = await carved.pre_command(
        _ctx("git",
             "branch",
             "/repo/wip/x",
             paths=(_path("/repo/wip/x"), ),
             cwd="/repo",
             program=("git", "branch")))
    assert isinstance(answer, Ask) and answer.reason == "branches need a nod"


@pytest.mark.asyncio
async def test_an_ask_rule_speaks_after_every_deny():
    policy = _policy()
    # A line an ask rule covers, refused by nothing: the Ask names the
    # rule so the door can key a session grant on it.
    assert await policy.pre_command(
        _ctx("git",
             "push",
             "origin",
             "main",
             cwd="/scratch",
             program=("git", "push"))) == Ask("sign-off", ASK_PUSH,
                                              (ASK_PUSH, ))
    # Deny runs first: on the mount the same line is refused, and a
    # grant could never re-open it because no Ask is raised.
    assert await policy.pre_command(
        _ctx("git", "push", cwd="/repo",
             program=("git", "push"))) == Deny("history is read-only here")
    # An operand-scoped ask rule asks only when the line names the path.
    shared = AdmissionRules(ask=(CommandRule(
        reason="shared", commands=("rm", ), paths=("/repo/shared/*", )), ))
    door = PermissionsPolicy(_Sessions({"s": shared}))
    assert await door.pre_command(
        _ctx("rm", "/repo/shared/a", paths=(_path("/repo/shared/a"), ))
    ) == Ask("shared", shared.ask[0], (shared.ask[0], ))
    assert await door.pre_command(
        _ctx("rm", "/repo/b", paths=(_path("/repo/b"), ))) is None


@pytest.mark.asyncio
async def test_pre_ops_holds_the_pure_path_rules():
    policy = _policy()
    locked = OpsContext(op="write",
                        path=_path("/repo/locked/a"),
                        write=True,
                        prefix="/repo/",
                        session_id="s")
    assert await policy.pre_ops(locked) == Deny("frozen")
    # Command-scoped rules do not reach the op door: an op does not
    # know which command issued it.
    assert await policy.pre_ops(
        OpsContext(op="unlink",
                   path=_path("/repo/x"),
                   write=True,
                   prefix="/repo/",
                   session_id="s")) is None


@pytest.mark.asyncio
async def test_seeded_in_a_policies_chain_after_the_builtins():
    policies = Policies([_policy()])
    deny = await policies.pre_command(
        _ctx("git", "push", cwd="/repo", program=("git", "push")))
    assert deny == Deny("history is read-only here",
                        policy="PermissionsPolicy")
    assert policies.wants("pre_ops")
