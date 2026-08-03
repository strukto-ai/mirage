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
from pydantic import BaseModel

from mirage import CLISpec, Workspace
from mirage.commands.cli.specs import register_cli_spec, unregister_cli_spec
from mirage.commands.spec.types import Operand, Option
from mirage.config import load_config
from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.resource.ram import RAMResource
from mirage.types import MountMode


class TokenConfig(BaseModel):
    token: str


async def send(config, paths, *texts, **flags):
    body = " ".join(texts)
    to = flags.get("to")
    return f"sent[{config.token}] to={to}: {body}\n".encode(), IOResult()


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
                          policy=policy)
    workspace.register_cli("slack-eng", make_tree(), config={"token": "tok"})
    io = await workspace.execute("slack-eng message send -t x hi")
    assert io.exit_code == 126
    err = await materialize(io.stderr) if io.stderr else b""
    assert b"policy denied" in err
    assert denied[-1] == "slack-eng"
    io = await workspace.execute("echo unaffected")
    assert io.exit_code == 0
    assert denied[-1] is None
