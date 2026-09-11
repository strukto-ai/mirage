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

import os
from pathlib import Path

import pytest
from pydantic import BaseModel

from mirage import CLIInvocation, CLISpec, Workspace
from mirage.commands.cli.specs import register_cli_spec, unregister_cli_spec
from mirage.commands.spec.types import Operand, Option
from mirage.config import load_config
from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.policy.match import Outcome
from mirage.resource.ram import RAMResource
from mirage.runtime.js.quickjs import QUICKJS_HOME_ENV
from mirage.runtime.types import ScriptSource
from mirage.types import MountMode


class TokenConfig(BaseModel):
    token: str


async def send(inv: CLIInvocation[TokenConfig]):
    body = " ".join(inv.texts)
    to = inv.flags.get("to")
    return f"sent[{inv.config.token}] to={to}: {body}\n".encode(), IOResult()


def make_tree() -> CLISpec:
    return CLISpec(
        name="slackish",
        config_model=TokenConfig,
        subcommands=(CLISpec(name="message",
                             subcommands=(CLISpec(
                                 name="send",
                                 fn=send,
                                 write=True,
                                 options=(Option(short="-t",
                                                 long="--to",
                                                 type="str",
                                                 required=True), ),
                                 rest=Operand(type="str")), )), ),
    )


@pytest.fixture
def ws():
    workspace = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                          mode=MountMode.WRITE)
    yield workspace


async def run(ws, line):
    io = await ws.execute(line)
    out = await materialize(io.stdout) if io.stdout else b""
    err = await materialize(io.stderr) if io.stderr else b""
    return io.exit_code, out, err


@pytest.mark.asyncio
async def test_two_accounts_dispatch_by_installed_name(ws):
    tree = make_tree()
    ws.register_cli("slackish", tree, {"token": "eng"})
    ws.register_cli("slackish-sup", tree, {"token": "sup"})
    code, out, _ = await run(ws, "slackish message send -t '#e' hi")
    assert (code, out) == (0, b"sent[eng] to=#e: hi\n")
    code, out, _ = await run(ws, "slackish-sup message send -t '#s' yo")
    assert (code, out) == (0, b"sent[sup] to=#s: yo\n")


@pytest.mark.asyncio
async def test_renamed_install_attributes_to_its_own_head(ws):
    ws.register_cli("sl", make_tree(), {"token": "t"})
    code, _, err = await run(ws, "sl bogus")
    assert code == 1
    assert err == b"sl: 'bogus' is not a sl command. See 'sl --help'.\n"
    code, out, _ = await run(ws, "sl message send --help")
    assert code == 0
    assert out.startswith(b"sl message send\n")


@pytest.mark.asyncio
async def test_command_tiers_key_on_the_installed_name():
    # Two installs of one spec are two subjects: allow installs one head
    # word and not the other, deny and ask rules name one install and
    # leave its twin alone, and a grant runs the line under the granted
    # install's own config.
    ws = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   profiles={
                       "crew": {
                           "commands": {
                               "allow": ["h1", "h2", "type"],
                               "ask": [{
                                   "reason": "outbound needs a nod",
                                   "commands": ["h1 message send"]
                               }],
                               "deny": [{
                                   "reason": "beta is read-only",
                                   "commands": ["h2 message send"]
                               }],
                           }
                       },
                       "solo": {
                           "commands": {
                               "allow": ["h1", "type"]
                           }
                       },
                   })
    tree = make_tree()
    ws.register_cli("h1", tree, {"token": "one"})
    ws.register_cli("h2", tree, {"token": "two"})
    ws.create_session("c", profile="crew")
    ws.create_session("s", profile="solo")
    try:
        io = await ws.execute("h2 message send -t x hi", session_id="c")
        err = await materialize(io.stderr) if io.stderr else b""
        assert io.exit_code == 126
        assert err == b"h2: Permission denied\n"
        assert io.refusal is not None
        assert io.refusal.reason == "beta is read-only"
        io = await ws.execute("h1 message send -t x hi", session_id="c")
        err = await materialize(io.stderr) if io.stderr else b""
        assert io.exit_code == 126
        assert err == b"h1: Permission denied\n"
        assert io.refusal is not None and io.refusal.kind == "pending"
        assert io.refusal.reason.startswith("outbound needs a nod")
        (request, ) = ws.decisions.pending()
        assert request.command == "h1"
        await ws.decisions.answer(request.id, Outcome.ALLOW)
        io = await ws.execute("h1 message send -t x hi", session_id="c")
        out = await materialize(io.stdout) if io.stdout else b""
        assert (io.exit_code, out) == (0, b"sent[one] to=x: hi\n")
        io = await ws.execute("h2 message send -t x hi", session_id="s")
        err = await materialize(io.stderr) if io.stderr else b""
        assert io.exit_code == 127
        assert b"h2: command not found" in err
        io = await ws.execute("type -t h1; type -t h2", session_id="s")
        out = await materialize(io.stdout) if io.stdout else b""
        assert (io.exit_code, out) == (1, b"cli\n")
        io = await ws.execute("h1 message send -t x hi", session_id="s")
        out = await materialize(io.stdout) if io.stdout else b""
        assert (io.exit_code, out) == (0, b"sent[one] to=x: hi\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_leaf_usage_error_exits_2(ws):
    ws.register_cli("sl", make_tree(), {"token": "t"})
    code, _, err = await run(ws, "sl message send hi")
    assert code == 2
    assert err.startswith(b"sl message send: option '--to' is required")


@pytest.mark.asyncio
async def test_unregister_returns_the_name_to_127(ws):
    ws.register_cli("sl", make_tree(), {"token": "t"})
    ws.unregister_cli("sl")
    code, _, err = await run(ws, "sl message send -t x hi")
    assert code == 127
    assert b"sl: command not found" in err


@pytest.mark.asyncio
async def test_cli_head_never_resolves_a_mount(ws):
    # A CLI line whose words look like mount paths still dispatches by
    # name; the mount stays untouched and the words arrive as text.
    ws.register_cli("sl", make_tree(), {"token": "t"})
    code, out, _ = await run(ws, "sl message send -t x /data/a.txt")
    assert code == 0
    assert out == b"sent[t] to=x: /data/a.txt\n"


@pytest.mark.asyncio
async def test_yaml_clis_section_installs_through_load_config():
    register_cli_spec(make_tree())
    try:
        cfg = load_config({
            "mounts": {
                "/data": {
                    "resource": "ram"
                }
            },
            "clis": {
                "sl": {
                    "cli": "slackish",
                    "config": {
                        "token": "yaml"
                    }
                }
            },
        })
        ws = Workspace(**cfg.to_workspace_kwargs())
        code, out, _ = await run(ws, "sl message send -t x hi")
        assert (code, out) == (0, b"sent[yaml] to=x: hi\n")
        await ws.close()
    finally:
        unregister_cli_spec("slackish")


@pytest.mark.asyncio
async def test_yaml_cli_reference_form_installs(tmp_path):
    # `cli:` points at code like `resource:` does: a ./file.py:ATTR
    # reference loads the CLISpec straight from the script.
    script = tmp_path / "slackish.py"
    script.write_text(
        "from mirage import CLIInvocation, CLISpec\n"
        "from mirage.io import IOResult\n"
        "from pydantic import BaseModel\n\n\n"
        "class TokenConfig(BaseModel):\n"
        "    token: str\n\n\n"
        "async def send(inv: CLIInvocation[TokenConfig]):\n"
        "    return f'sent[{inv.config.token}]\\n'.encode(), IOResult()\n\n\n"
        "TREE = CLISpec(name='slackish', config_model=TokenConfig,\n"
        "               subcommands=(CLISpec(name='send', fn=send), ))\n")
    cfg = load_config({
        "mounts": {
            "/data": {
                "resource": "ram"
            }
        },
        "clis": {
            "sl": {
                "cli": f"{script}:TREE",
                "config": {
                    "token": "ref"
                }
            }
        },
    })
    ws = Workspace(**cfg.to_workspace_kwargs())
    code, out, _ = await run(ws, "sl send")
    assert (code, out) == (0, b"sent[ref]\n")
    await ws.close()


@pytest.mark.asyncio
async def test_yaml_unknown_cli_key_fails_loud():
    cfg = load_config({
        "mounts": {
            "/data": {
                "resource": "ram"
            }
        },
        "clis": {
            "x": {
                "cli": "nope"
            }
        },
    })
    with pytest.raises(ValueError, match="unknown cli 'nope'"):
        Workspace(**cfg.to_workspace_kwargs())


@pytest.mark.asyncio
async def test_policy_sees_the_cli_fact():
    denied: list[str | None] = []

    def policy(ctx):
        denied.append(ctx.commands[0].cli if ctx.commands else None)
        if ctx.commands and ctx.commands[0].cli == "slack-eng":
            return {"deny": "cli lines are frozen"}
        return None

    workspace = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                          mode=MountMode.WRITE,
                          route_policy=policy)
    workspace.register_cli("slack-eng", make_tree(), config={"token": "tok"})
    io = await workspace.execute("slack-eng message send -t x hi")
    assert io.exit_code == 126
    err = await materialize(io.stderr) if io.stderr else b""
    assert err == b"slack-eng: Permission denied\n"
    assert io.refusal is not None and io.refusal.kind == "deny"
    assert denied[-1] == "slack-eng"
    io = await workspace.execute("echo unaffected")
    assert io.exit_code == 0
    assert denied[-1] is None


def _quickjs_home() -> str | None:
    root = os.environ.get(QUICKJS_HOME_ENV)
    if root and (Path(root) / "qjs-wasi.wasm").is_file():
        return root
    return None


live_quickjs = pytest.mark.skipif(
    _quickjs_home() is None,
    reason=f"{QUICKJS_HOME_ENV} does not point at a qjs-wasi.wasm build")


def pager_spec(source: str, language: str = "python") -> CLISpec:
    return CLISpec(name="pager",
                   script=ScriptSource(source, language=language))


@pytest.mark.asyncio
async def test_script_cli_runs_on_monty_with_verbatim_argv(ws):
    ws.register_cli("pager", pager_spec("print('paged', argv[1])"))
    code, out, err = await run(ws, "pager report.txt")
    assert (code, out, err) == (0, b"paged report.txt\n", b"")


@pytest.mark.asyncio
async def test_script_cli_reads_config_from_mirage_config_env(ws):
    ws.register_cli(
        "pager",
        pager_spec("import os\n"
                   "print(os.environ.get('MIRAGE_CLI_CONFIG'))"),
        {"width": 80})
    code, out, _ = await run(ws, "pager")
    assert (code, out) == (0, b'{"width": 80}\n')


@pytest.mark.asyncio
async def test_script_cli_reads_piped_stdin(ws):
    ws.register_cli("pager", pager_spec("print(stdin.decode())"))
    code, out, _ = await run(ws, "echo body | pager")
    assert (code, out) == (0, b"body\n\n")


@pytest.mark.asyncio
async def test_script_cli_exit_code_reaches_the_shell(ws):
    # A crashing program's traceback and nonzero exit surface as the
    # line's stderr and $?, like any command.
    ws.register_cli("pager", pager_spec("raise ValueError('nope')"))
    code, _, err = await run(ws, "pager")
    assert code == 1
    assert b"ValueError" in err
    code, out, _ = await run(ws, "pager; echo status=$?")
    assert b"status=1" in out


@pytest.mark.asyncio
async def test_script_cli_line_records_in_history(ws):
    ws.register_cli("pager", pager_spec("print('hi')"))
    await run(ws, "pager report.txt")
    code, out, _ = await run(ws, "history 2")
    assert code == 0
    assert b"pager report.txt" in out


@pytest.mark.asyncio
async def test_shell_function_shadows_a_script_cli(ws):
    # The one agent-side override, bash's own rule: function beats CLI,
    # reversible with unset -f.
    ws.register_cli("pager", pager_spec("print('from-script')"))
    await run(ws, "pager() { echo from-function; }")
    code, out, _ = await run(ws, "pager")
    assert (code, out) == (0, b"from-function\n")
    await run(ws, "unset -f pager")
    code, out, _ = await run(ws, "pager")
    assert (code, out) == (0, b"from-script\n")


@pytest.mark.asyncio
async def test_script_cli_pinned_to_local_runs_on_the_host(ws):
    # sys.argv only exists on a host interpreter (monty has no sys
    # bridge), so output proves the runtime: pin escalated to local.
    ws.add_runtime("local")
    spec = CLISpec(name="pager",
                   script=ScriptSource("import sys\n"
                                       "print('local', sys.argv[1])"),
                   runtime="local")
    ws.register_cli("pager", spec)
    code, out, _ = await run(ws, "pager report.txt")
    assert (code, out) == (0, b"local report.txt\n")


@pytest.mark.asyncio
@live_quickjs
async def test_script_cli_js_runs_on_quickjs(ws):
    # scriptArgs[0] is the installed name, like a qjs script's path.
    ws.register_cli(
        "pager",
        pager_spec("console.log('paged-js', scriptArgs[0], scriptArgs[1])",
                   "js"))
    code, out, _ = await run(ws, "pager report.txt")
    assert (code, out) == (0, b"paged-js pager report.txt\n")


@pytest.mark.asyncio
async def test_script_cli_receives_its_own_flags(ws):
    # A yaml clis entry declares no grammar, so mirage must not refuse
    # flags on the program's behalf; the program is the parser.
    ws.register_cli("pager", pager_spec("print('paged', argv[1:])"))
    code, out, err = await run(ws, "pager --width 80 -n report.txt")
    assert (code, err) == (0, b"")
    assert out == b"paged ['--width', '80', '-n', 'report.txt']\n"


@pytest.mark.asyncio
async def test_script_cli_answers_its_own_help(ws):
    ws.register_cli("pager", pager_spec("print('program usage', argv[1:])"))
    code, out, _ = await run(ws, "pager --help")
    assert (code, out) == (0, b"program usage ['--help']\n")


@pytest.mark.asyncio
async def test_man_of_a_script_cli_promises_no_help_flag(ws):
    ws.register_cli("pager", pager_spec("print('hi')"))
    code, out, _ = await run(ws, "man pager")
    assert code == 0
    assert out.startswith(b"pager\n")
    assert b"--help" not in out


@pytest.mark.asyncio
async def test_yaml_script_entry_executes_end_to_end(tmp_path):
    script = tmp_path / "pager.py"
    script.write_text(
        "import os\n"
        "print('yaml', argv[1], os.environ.get('MIRAGE_CLI_CONFIG'))\n")
    cfg = load_config({
        "mounts": {
            "/data": {
                "resource": "ram"
            }
        },
        "clis": {
            "pager": {
                "script": str(script),
                "config": {
                    "width": 80
                }
            }
        },
    })
    ws = Workspace(**cfg.to_workspace_kwargs())
    code, out, _ = await run(ws, "pager report.txt")
    assert (code, out) == (0, b'yaml report.txt {"width": 80}\n')
    await ws.close()
