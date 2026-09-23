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

from mirage.commands.cli.types import CLISpec
from mirage.io import IOResult
from mirage.policy.types import AdmissionRules
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.lookup import (SHELL_CONSUMERS, Consumer,
                                     command_visible, lookup, lookup_all,
                                     verb_visible)
from mirage.workspace.session import SessionState


def _fixture() -> tuple[SessionState, Workspace]:
    ws = Workspace(mounts={"/ram": (RAMVFS(), MountMode.WRITE)})
    return SessionState(session_id="t"), ws


async def _noop(config, paths, *texts, **flags):
    return None, IOResult()


def _cli_tree() -> CLISpec:
    return CLISpec(name="prog", subcommands=(CLISpec(name="run", fn=_noop), ))


def test_builtins_route_session():
    session, ws = _fixture()
    for name in ("cd", "echo", "export", "history", "test", "xargs"):
        assert lookup(name, session, ws._registry) is Consumer.SESSION


def test_unsupported_builtins_route_session():
    session, ws = _fixture()
    assert lookup("exec", session, ws._registry) is Consumer.SESSION


def test_namespace_commands():
    session, ws = _fixture()
    assert lookup("ln", session, ws._registry) is Consumer.NAMESPACE
    assert lookup("readlink", session, ws._registry) is Consumer.NAMESPACE


def test_function_routes_function():
    session, ws = _fixture()
    session.functions["greet"] = []
    assert lookup("greet", session, ws._registry) is Consumer.FUNCTION


def test_builtin_shadows_function():
    session, ws = _fixture()
    session.functions["echo"] = []
    assert lookup("echo", session, ws._registry) is Consumer.SESSION


def test_function_shadows_mount_command():
    session, ws = _fixture()
    session.functions["cat"] = []
    assert lookup("cat", session, ws._registry) is Consumer.FUNCTION


def test_mount_command_routes_mount():
    session, ws = _fixture()
    assert lookup("cat", session, ws._registry) is Consumer.MOUNT
    assert lookup("grep", session, ws._registry) is Consumer.MOUNT


def test_unregistered_name_routes_unknown():
    session, ws = _fixture()
    assert lookup("nosuchcmd", session, ws._registry) is Consumer.UNKNOWN


def test_installed_cli_routes_cli():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    assert lookup("prog", session, ws._registry) is Consumer.CLI


def test_function_shadows_installed_cli():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    session.functions["prog"] = []
    assert lookup("prog", session, ws._registry) is Consumer.FUNCTION


def test_unregistered_cli_routes_unknown():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    ws.unregister_cli("prog")
    assert lookup("prog", session, ws._registry) is Consumer.UNKNOWN


def test_shell_consumers_resolve_globs():
    assert Consumer.SESSION in SHELL_CONSUMERS
    assert Consumer.NAMESPACE in SHELL_CONSUMERS
    assert Consumer.FUNCTION in SHELL_CONSUMERS
    # A CLI is a program: bash hands programs glob matches, never
    # patterns.
    assert Consumer.CLI in SHELL_CONSUMERS
    assert Consumer.MOUNT not in SHELL_CONSUMERS
    assert Consumer.UNKNOWN not in SHELL_CONSUMERS


def test_route_all_reports_every_layer_winner_first():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    assert lookup_all("prog", session, ws._registry) == [Consumer.CLI]
    session.functions["prog"] = []
    assert lookup_all("prog", session,
                      ws._registry) == [Consumer.FUNCTION, Consumer.CLI]


def test_route_all_is_empty_where_route_says_unknown():
    session, ws = _fixture()
    assert lookup_all("bogus", session, ws._registry) == []
    assert lookup("bogus", session, ws._registry) is Consumer.UNKNOWN


def test_route_agrees_with_the_first_layer_route_all_reports():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    session.functions["greet"] = []
    for name in ("cd", "ln", "greet", "prog", "cat", "bogus"):
        layers = lookup_all(name, session, ws._registry)
        winner = layers[0] if layers else Consumer.UNKNOWN
        assert lookup(name, session, ws._registry) is winner


def test_verb_visible_answers_below_the_head_word_command_visible_answers():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    session.commands = AdmissionRules(allow=("prog run", ))
    # Dispatch routes by the head word, which stays visible: one line of
    # the tree runs.
    assert command_visible("prog", session)
    assert lookup("prog", session, ws._registry) is Consumer.CLI
    assert verb_visible("prog", (), session)
    assert verb_visible("prog", ("run", ), session)
    # A verb the list does not reach is not this session's to discover,
    # though the head word it hangs off is.
    assert not verb_visible("prog", ("stop", ), session)
    # No list: every verb of every tree.
    session.commands = None
    assert verb_visible("prog", ("stop", ), session)


def test_allow_lists_filter_every_layer_and_spare_only_functions():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    session.commands = AdmissionRules(allow=("cat", "prog", "ln"))
    reg = ws._registry
    # Listed: visible in its layer, whichever layer that is.
    assert lookup("cat", session, reg) is Consumer.MOUNT
    assert lookup("prog", session, reg) is Consumer.CLI
    assert lookup("ln", session, reg) is Consumer.NAMESPACE
    # Unlisted: not a command for the session (sleep is a tool-tier
    # builtin, rm a mount command).
    assert lookup("sleep", session, reg) is Consumer.UNKNOWN
    assert lookup("rm", session, reg) is Consumer.UNKNOWN
    assert lookup_all("rm", session, reg) == []
    assert not command_visible("rm", session)
    # Builtins are subjects like everything else: an allow list stating
    # cat leaves no cd and no echo.
    assert lookup("cd", session, reg) is Consumer.UNKNOWN
    assert lookup("echo", session, reg) is Consumer.UNKNOWN
    assert not command_visible("cd", session)
    session.commands = AdmissionRules(allow=("cat", "prog", "ln", "cd"))
    assert lookup("cd", session, reg) is Consumer.SESSION
    assert command_visible("cd", session)
    session.commands = AdmissionRules(allow=("cat", "prog", "ln"))
    # A function is the session's own state, visible where it is what
    # runs; named after a hidden builtin it is as unreachable as the
    # builtin, since builtins shadow functions here.
    session.functions["deploy"] = []
    assert lookup("deploy", session, reg) is Consumer.FUNCTION
    assert command_visible("deploy", session)
    session.functions["sleep"] = []
    assert lookup("sleep", session, reg) is Consumer.UNKNOWN
    assert not command_visible("sleep", session)
    # A function shadowing a hidden CLI or mount command runs, and the
    # hidden layer stays out of `type -a`.
    session.functions["rm"] = []
    assert lookup_all("rm", session, reg) == [Consumer.FUNCTION]
    # No allow list at all: nothing filtered (the function still
    # shadows).
    session.commands = None
    assert lookup_all("rm", session,
                      reg) == [Consumer.FUNCTION, Consumer.MOUNT]
    assert lookup("sleep", session, reg) is Consumer.SESSION
