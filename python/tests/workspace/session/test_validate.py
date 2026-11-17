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

import re

import pytest

from mirage import Workspace
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.policy.errors import PolicyError
from mirage.policy.types import (
    AdmissionRules,
    AllowFlags,
    CommandRule,
    Grammar,
)
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace.session.validate import check_cli_patterns, check_rules


def _rules(allow=None, ask=(), deny=()) -> AdmissionRules:
    return AdmissionRules(allow=allow, ask=tuple(ask), deny=tuple(deny))


def test_a_rule_on_a_builtin_the_allow_list_omits_is_refused():
    # The whole point of the check: `rm` reads as guarded in the
    # document and is not guarded at all, because the allow list
    # refuses it first, so nothing ever reaches the rule.
    with pytest.raises(PolicyError, match="never allows"):
        check_rules(
            _rules(
                allow=("ls", "cat"),
                deny=(CommandRule(reason="no", commands=("rm",)),),
            )
        )
    with pytest.raises(PolicyError, match="never allows"):
        check_rules(
            _rules(
                allow=("ls",),
                ask=(CommandRule(reason="sign-off", commands=("rm",)),),
            )
        )


def test_a_rule_on_an_installed_builtin_passes():
    check_rules(
        _rules(
            allow=("ls", "rm"),
            deny=(CommandRule(reason="no", commands=("rm",)),),
        )
    )
    # No allow list installs everything, so nothing is dead.
    check_rules(_rules(deny=(CommandRule(reason="no", commands=("rm",)),)))


def test_a_word_that_is_not_a_builtin_is_left_alone():
    # It may be a CLI the host registers after the workspace is built,
    # which is what check_cli_patterns covers at create_session.
    check_rules(
        _rules(
            allow=("ls",),
            deny=(CommandRule(reason="no", commands=("mycli run",)),),
        )
    )


def test_an_ask_an_outranking_deny_covers_is_refused():
    with pytest.raises(PolicyError, match="can never fire"):
        check_rules(
            _rules(
                ask=(CommandRule(reason="sign-off", commands=("rm",)),),
                deny=(CommandRule(reason="no", commands=("rm",)),),
            )
        )
    # A shorter deny pattern covers a longer ask: `git` refuses every
    # `git push` line before the ask is reached.
    with pytest.raises(PolicyError, match="can never fire"):
        check_rules(
            _rules(
                ask=(CommandRule(reason="sign-off", commands=("git push",)),),
                deny=(CommandRule(reason="no", commands=("git",)),),
            )
        )
    # A deny naming no commands refuses everything.
    with pytest.raises(PolicyError, match="can never fire"):
        check_rules(
            _rules(
                ask=(CommandRule(reason="sign-off", commands=("rm",)),),
                deny=(CommandRule(reason="no"),),
            )
        )


def test_a_deny_that_leaves_the_ask_work_is_allowed():
    # Path-scoped: the ask still fires on every operand the deny does
    # not name.
    check_rules(
        _rules(
            ask=(CommandRule(reason="sign-off", commands=("rm",)),),
            deny=(
                CommandRule(reason="no", commands=("rm",), paths=("/prod/*",)),
            ),
        )
    )
    # A longer deny does not cover a shorter ask: `git push` leaves
    # every other git line for the ask.
    check_rules(
        _rules(
            ask=(CommandRule(reason="sign-off", commands=("git",)),),
            deny=(CommandRule(reason="no", commands=("git push",)),),
        )
    )
    # A different command entirely.
    check_rules(
        _rules(
            ask=(CommandRule(reason="sign-off", commands=("rm",)),),
            deny=(CommandRule(reason="no", commands=("mv",)),),
        )
    )
    # An ask naming two commands the deny only half covers.
    check_rules(
        _rules(
            ask=(CommandRule(reason="sign-off", commands=("rm", "mv")),),
            deny=(CommandRule(reason="no", commands=("rm",)),),
        )
    )


def test_a_mount_scoped_deny_does_not_kill_a_rule_outside_it():
    # The deny only reaches lines working under /repo, so a top-level
    # ask still has work everywhere else.
    check_rules(
        _rules(
            ask=(CommandRule(reason="sign-off", commands=("rm",)),),
            deny=(CommandRule(reason="no", commands=("rm",), mount="/repo"),),
        )
    )
    # Written under the same mount, it does kill it.
    with pytest.raises(PolicyError, match="can never fire"):
        check_rules(
            _rules(
                ask=(
                    CommandRule(
                        reason="sign-off", commands=("rm",), mount="/repo"
                    ),
                ),
                deny=(
                    CommandRule(reason="no", commands=("rm",), mount="/repo"),
                ),
            )
        )


def test_a_deny_at_a_different_anchor_is_left_to_the_run():
    # A top-level deny does shadow a mount-scoped ask on the same
    # command, but across anchors the deeper rule leads and which one
    # that is depends on the line, so this reports nothing rather than
    # guess. `conflict_a_later_tiers_deny_outranks_an_earlier_tiers_ask`
    # in integ/session/commands/conflicts.json is exactly that document.
    check_rules(
        _rules(
            ask=(
                CommandRule(
                    reason="log it", commands=("git branch",), mount="/repo"
                ),
            ),
            deny=(
                CommandRule(reason="no branches", commands=("git branch",)),
            ),
        )
    )


def test_a_wildcard_token_in_a_deny_covers_whatever_the_ask_names():
    with pytest.raises(PolicyError, match="can never fire"):
        check_rules(
            _rules(
                ask=(CommandRule(reason="sign-off", commands=("git push",)),),
                deny=(CommandRule(reason="no", commands=("git *",)),),
            )
        )


def test_nothing_to_check_passes():
    check_rules(None)
    check_rules(_rules())


GIT = Grammar(
    CommandSpec(
        name="git",
        subcommands=(
            CommandSpec(name="status"),
            CommandSpec(
                name="remote",
                subcommands=(
                    CommandSpec(
                        name="add",
                        arguments=(
                            Argument("-f", "--fetch", action="store_true"),
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="add",
                arguments=(
                    Argument("-f", "--force", action="store_true"),
                    Argument("--dry-run", action="store_true"),
                ),
            ),
        ),
    ),
    tree=True,
)


def _deny(*patterns: str) -> AdmissionRules:
    return _rules(deny=(CommandRule(reason="no", commands=patterns),))


@pytest.mark.parametrize(
    ("pattern", "says"),
    [
        ("git shove", "has no verb git shove"),
        ("git remote shove", "has no verb git remote shove"),
        ("git add --dry", "--dry is a prefix of an option"),
        ("git * -f", "write its long name"),
        ("git * --prune", "no git subcommand the * stands for has --prune"),
        ("git {status,shove}", "has no verb git shove"),
        ("git add --frobnicate", "git add does not read --frobnicate"),
    ],
)
def test_a_cli_pattern_its_tree_cannot_read_is_refused(pattern, says):
    with pytest.raises(PolicyError, match=re.escape(says)):
        check_cli_patterns(_deny(pattern), {"git": GIT})


@pytest.mark.parametrize(
    "pattern",
    [
        "git status",
        "git *",
        "git * --force",
        "git * * --fetch",
        "git add -f",
        "git",
        "slack send --now",
    ],
)
def test_a_cli_pattern_its_tree_reads_loads(pattern):
    check_cli_patterns(_deny(pattern), {"git": GIT})
    check_cli_patterns(None, {"git": GIT})


@pytest.mark.parametrize(
    ("pattern", "says"),
    [
        ("rm --no-such-flag", "rm has no option --no-such-flag"),
        ("rm --rec", "--rec is a prefix of an option"),
        ("rm -Z", "rm has no option -Z"),
    ],
)
def test_a_builtin_pattern_its_spec_cannot_read_is_refused(pattern, says):
    with pytest.raises(PolicyError, match=re.escape(says)):
        check_rules(_deny(pattern))
    with pytest.raises(PolicyError, match=re.escape(says)):
        check_rules(_rules(allow=(pattern,)))


def test_a_builtin_pattern_in_any_spelling_loads():
    check_rules(_deny("rm -rf", "rm --recursive --force", "head -n 1"))
    check_rules(_rules(allow=(AllowFlags("rm", ("-f", "-v")),)))
    with pytest.raises(PolicyError, match="rm has no option -Z"):
        check_rules(_rules(allow=(AllowFlags("rm", ("-Z",)),)))


def test_a_group_in_the_name_and_a_star_in_allow_are_warned(caplog):
    check_rules(
        _rules(allow=("*", "gh * view"), deny=_deny("{rm,mv} -f").deny)
    )
    said = caplog.text
    assert "{rm,mv} -f: a group in the command name" in said
    assert "gh * view: a * admits every subcommand" in said


def _noop(config, paths, texts, ctx):
    return 0


def test_create_session_reads_the_verbs_of_an_installed_cli():
    # Reached through the workspace, not the helper, because the wiring
    # is the part that broke: the TypeScript twin read the registry with
    # Object.entries over a Map and silently saw no CLIs at all, so the
    # check passed everything.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        ws.register_cli(
            "prog",
            CLI(
                spec=CommandSpec(
                    name="prog", subcommands=(CommandSpec(name="run"),)
                ),
                handlers={"run": CLIHandler(fn=_noop)},
            ),
        )
        doc = {
            "commands": {
                "deny": [
                    {
                        "reason": "no",
                        "commands": ["prog walk"],
                    }
                ]
            }
        }
        with pytest.raises(PolicyError, match="has no verb"):
            ws.create_session("bad", permissions=doc)
        ok = {
            "commands": {
                "deny": [
                    {
                        "reason": "no",
                        "commands": ["prog run"],
                    }
                ]
            }
        }
        ws.create_session("good", permissions=ok)
    finally:
        pass
