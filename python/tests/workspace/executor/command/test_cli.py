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

from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Operand, Option
from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.executor.command.cli import handle_cli
from mirage.workspace.session import Session


class TokenConfig(BaseModel):
    token: str


CALLS: list[dict] = []


async def send(config, paths, *texts, **flags):
    CALLS.append({
        "config": config,
        "paths": paths,
        "texts": texts,
        "flags": flags
    })
    return f"sent[{config.token}]\n".encode(), IOResult()


def make_install(name: str = "prog") -> CLIInstall:
    spec = CLISpec(
        name="prog",
        config_model=TokenConfig,
        options=(Option(short="-v", long="--verbose", count=True), ),
        subcommands=(CLISpec(name="message",
                             subcommands=(CLISpec(
                                 name="send",
                                 fn=send,
                                 options=(Option(short="-t",
                                                 long="--to",
                                                 type="str",
                                                 required=True), ),
                                 rest=Operand(type="str")), )), ),
    )
    return CLIInstall(name=name, spec=spec, config=TokenConfig(token="tok"))


@pytest.mark.asyncio
async def test_leaf_runs_with_config_group_flags_and_texts():
    CALLS.clear()
    install = make_install()
    parts = ["prog", "-vv", "message", "send", "-t", "#eng", "hello", "world"]
    stdout, io, node = await handle_cli(install, parts, Session("t"))
    assert io.exit_code == 0
    assert await materialize(stdout) == b"sent[tok]\n"
    call = CALLS.pop()
    assert call["config"].token == "tok"
    assert call["texts"] == ("hello", "world")
    assert call["flags"]["to"] == "#eng"
    assert call["flags"]["verbose"] == 2
    assert node.command == "prog -vv message send -t #eng hello world"


@pytest.mark.asyncio
async def test_unknown_verb_is_git_worded_exit_1():
    install = make_install("renamed")
    _, io, node = await handle_cli(install, ["renamed", "bogus"], Session("t"))
    assert io.exit_code == 1
    assert io.stderr == (b"renamed: 'bogus' is not a renamed command. "
                         b"See 'renamed --help'.\n")
    assert node.exit_code == 1


@pytest.mark.asyncio
async def test_bare_group_prints_usage_stdout_exit_1():
    install = make_install()
    stdout, io, _ = await handle_cli(install, ["prog", "message"],
                                     Session("t"))
    assert io.exit_code == 1
    out = await materialize(stdout)
    assert b"Usage: prog message" in out
    assert b"send" in out


@pytest.mark.asyncio
async def test_leaf_help_prints_installed_prog_exit_0():
    install = make_install("renamed")
    stdout, io, _ = await handle_cli(install,
                                     ["renamed", "message", "send", "--help"],
                                     Session("t"))
    assert io.exit_code == 0
    out = await materialize(stdout)
    assert out.startswith(b"renamed message send\n")
    assert b"--help" in out


@pytest.mark.asyncio
async def test_leaf_usage_error_exits_2_with_prog_attribution():
    install = make_install()
    _, io, _ = await handle_cli(install, ["prog", "message", "send", "hi"],
                                Session("t"))
    assert io.exit_code == 2
    assert io.stderr.startswith(b"prog message send: option '--to' is "
                                b"required")


@pytest.mark.asyncio
async def test_stdin_is_injected_as_a_kwarg():
    CALLS.clear()
    install = make_install()
    await handle_cli(install, ["prog", "message", "send", "-t", "x"],
                     Session("t"),
                     stdin=b"body")
    assert CALLS.pop()["flags"]["stdin"] == b"body"
