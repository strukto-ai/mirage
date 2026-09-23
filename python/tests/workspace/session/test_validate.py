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

from mirage import Workspace
from mirage.commands.cli.types import CLISpec
from mirage.policy.errors import PolicyError
from mirage.policy.types import AdmissionRules, CommandRule
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace.session.validate import check_cli_verbs, check_rules


def _rules(allow=None, ask=(), deny=()) -> AdmissionRules:
    return AdmissionRules(allow=allow, ask=tuple(ask), deny=tuple(deny))


def test_a_rule_on_a_builtin_the_allow_list_omits_is_refused():
    # The whole point of the check: `rm` reads as guarded in the
    # document and is not guarded at all, because it was never
    # installed, so nothing ever reaches the rule.
    with pytest.raises(PolicyError, match="never installs"):
        check_rules(
            _rules(allow=("ls", "cat"),
                   deny=(CommandRule(reason="no", commands=("rm", )), )))
    with pytest.raises(PolicyError, match="never installs"):
        check_rules(
            _rules(allow=("ls", ),
                   ask=(CommandRule(reason="sign-off", commands=("rm", )), )))


def test_a_rule_on_an_installed_builtin_passes():
    check_rules(
        _rules(allow=("ls", "rm"),
               deny=(CommandRule(reason="no", commands=("rm", )), )))
    # No allow list installs everything, so nothing is dead.
    check_rules(_rules(deny=(CommandRule(reason="no", commands=("rm", )), )))


def test_a_word_that_is_not_a_builtin_is_left_alone():
    # It may be a CLI the host registers after the workspace is built,
    # which is what check_cli_verbs covers at create_session.
    check_rules(
        _rules(allow=("ls", ),
               deny=(CommandRule(reason="no", commands=("mycli run", )), )))


def test_an_ask_an_outranking_deny_covers_is_refused():
    with pytest.raises(PolicyError, match="can never fire"):
        check_rules(
            _rules(ask=(CommandRule(reason="sign-off", commands=("rm", )), ),
                   deny=(CommandRule(reason="no", commands=("rm", )), )))
    # A shorter deny pattern covers a longer ask: `git` refuses every
    # `git push` line before the ask is reached.
    with pytest.raises(PolicyError, match="can never fire"):
        check_rules(
            _rules(ask=(CommandRule(reason="sign-off",
                                    commands=("git push", )), ),
                   deny=(CommandRule(reason="no", commands=("git", )), )))
    # A deny naming no commands refuses everything.
    with pytest.raises(PolicyError, match="can never fire"):
        check_rules(
            _rules(ask=(CommandRule(reason="sign-off", commands=("rm", )), ),
                   deny=(CommandRule(reason="no"), )))


def test_a_deny_that_leaves_the_ask_work_is_allowed():
    # Path-scoped: the ask still fires on every operand the deny does
    # not name.
    check_rules(
        _rules(ask=(CommandRule(reason="sign-off", commands=("rm", )), ),
               deny=(CommandRule(reason="no",
                                 commands=("rm", ),
                                 paths=("/prod/*", )), )))
    # A longer deny does not cover a shorter ask: `git push` leaves
    # every other git line for the ask.
    check_rules(
        _rules(ask=(CommandRule(reason="sign-off", commands=("git", )), ),
               deny=(CommandRule(reason="no", commands=("git push", )), )))
    # A different command entirely.
    check_rules(
        _rules(ask=(CommandRule(reason="sign-off", commands=("rm", )), ),
               deny=(CommandRule(reason="no", commands=("mv", )), )))
    # An ask naming two commands the deny only half covers.
    check_rules(
        _rules(ask=(CommandRule(reason="sign-off", commands=("rm", "mv")), ),
               deny=(CommandRule(reason="no", commands=("rm", )), )))


def test_a_mount_scoped_deny_does_not_kill_a_rule_outside_it():
    # The deny only reaches lines working under /repo, so a top-level
    # ask still has work everywhere else.
    check_rules(
        _rules(ask=(CommandRule(reason="sign-off", commands=("rm", )), ),
               deny=(CommandRule(reason="no", commands=("rm", ),
                                 mount="/repo"), )))
    # Written under the same mount, it does kill it.
    with pytest.raises(PolicyError, match="can never fire"):
        check_rules(
            _rules(ask=(CommandRule(reason="sign-off",
                                    commands=("rm", ),
                                    mount="/repo"), ),
                   deny=(CommandRule(reason="no",
                                     commands=("rm", ),
                                     mount="/repo"), )))


def test_a_deny_at_a_different_anchor_is_left_to_the_run():
    # A top-level deny does shadow a mount-scoped ask on the same
    # command, but across anchors the deeper rule leads and which one
    # that is depends on the line, so this reports nothing rather than
    # guess. `conflict_a_later_tiers_deny_outranks_an_earlier_tiers_ask`
    # in integ/session/commands/conflicts.json is exactly that document.
    check_rules(
        _rules(ask=(CommandRule(reason="log it",
                                commands=("git branch", ),
                                mount="/repo"), ),
               deny=(CommandRule(reason="no branches",
                                 commands=("git branch", )), )))


def test_a_wildcard_token_in_a_deny_covers_whatever_the_ask_names():
    with pytest.raises(PolicyError, match="can never fire"):
        check_rules(
            _rules(ask=(CommandRule(reason="sign-off",
                                    commands=("git push", )), ),
                   deny=(CommandRule(reason="no", commands=("git *", )), )))


def test_nothing_to_check_passes():
    check_rules(None)
    check_rules(_rules())


def test_a_rule_naming_a_verb_its_cli_does_not_have_is_refused():
    verbs = {"git": frozenset({"status", "push"})}
    with pytest.raises(PolicyError, match="no verb for"):
        check_cli_verbs(
            _rules(
                deny=(CommandRule(reason="no", commands=("git shove", )), )),
            verbs)
    # A verb it does have, a wildcard, and a head word no CLI claims all
    # pass: the last may be a command, a function, or a later install.
    check_cli_verbs(
        _rules(deny=(CommandRule(reason="no", commands=("git push", )), )),
        verbs)
    check_cli_verbs(
        _rules(deny=(CommandRule(reason="no", commands=("git *", )), )), verbs)
    check_cli_verbs(
        _rules(deny=(CommandRule(reason="no", commands=("slack send", )), )),
        verbs)
    # A bare head word names no verb, so there is nothing to check.
    check_cli_verbs(
        _rules(deny=(CommandRule(reason="no", commands=("git", )), )), verbs)
    check_cli_verbs(None, verbs)


def _noop(inv):
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
            CLISpec(name="prog", subcommands=(CLISpec(name="run",
                                                      fn=_noop), )))
        doc = {
            "commands": {
                "deny": [{
                    "reason": "no",
                    "commands": ["prog walk"],
                }]
            }
        }
        with pytest.raises(PolicyError, match="no verb for"):
            ws.create_session("bad", permissions=doc)
        ok = {
            "commands": {
                "deny": [{
                    "reason": "no",
                    "commands": ["prog run"],
                }]
            }
        }
        ws.create_session("good", permissions=ok)
    finally:
        pass
