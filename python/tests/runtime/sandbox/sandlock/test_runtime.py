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

import asyncio
import json
import os
import sys

import pytest

from mirage import RAMResource, Workspace
from mirage.runtime.sandbox.sandlock import SandlockRuntime
from mirage.runtime.table import build_runtime
from mirage.runtime.types import ProcessExecution
from mirage.types import PathSpec


@pytest.fixture
def cli(tmp_path, monkeypatch):
    binary = tmp_path / "sandlock"
    binary.write_text(
        f"#!{sys.executable}\n" + "import json, os, sys, time\n"
        "if sys.argv[-1] == 'wait': time.sleep(60)\n"
        "print(json.dumps(dict(argv=sys.argv[1:], env=dict(os.environ), "
        "cwd=os.getcwd(), stdin=sys.stdin.read())))\n")
    binary.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path))
    return tmp_path


@pytest.mark.asyncio
async def test_argv_environment_cwd_and_stdin_reach_cli(cli, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOST_ONLY", "must-not-inherit")
    runtime = SandlockRuntime(
        config={
            "env": {
                "E": "config",
                "BASE": "yes"
            },
            "fs_readable": ("/data", ),
            "fs_writable": ("/work", ),
            "max_memory": "512M"
        })
    argv = ("node", "a b", "$(echo literal)", "", "--flag")
    result = await runtime.execute(
        ProcessExecution(argv=argv,
                         cwd=PathSpec.from_str_path(str(cli)),
                         stdin=b"input\n",
                         env={
                             "E": "request",
                             "LD_PRELOAD": "/guest-only.so"
                         }))
    assert result.exit_code == 0
    data = json.loads(result.stdout)
    args = data["argv"]
    assert args[args.index("--") + 1:] == list(argv)
    assert args[:1] == ["run"]
    assert args[1:1 + len(runtime.policy_argv())] == runtime.policy_argv()
    assert "--clean-env" in args
    assert "E=request" in args and "E=config" not in args
    assert "BASE=yes" in args and "LD_PRELOAD=/guest-only.so" in args
    assert "LD_PRELOAD" not in data["env"]
    assert "MIRAGE_HOST_ONLY" not in data["env"]
    assert "E" not in data["env"]
    assert data["cwd"] == os.path.realpath(cli)
    assert data["stdin"] == "input\n"


@pytest.mark.asyncio
async def test_workspace_routes_named_programs_as_argv(cli):
    runtime = SandlockRuntime(captures=("python3", "node"))
    ws = Workspace({"/": RAMResource()}, runtimes=[runtime])
    try:
        for line in ("python3 --version", "node --version"):
            io = await ws.execute(line)
            assert io.exit_code == 0
            data = json.loads(await io.stdout_str())
            assert data["argv"][-3:] == ["--", *line.split()]
    finally:
        await ws.close()


def test_registry_declares_process_and_shell_without_language_or_workspace_fs(
):
    runtime = build_runtime("sandlock")
    assert isinstance(runtime, SandlockRuntime)
    assert runtime.captures == ("@external", )
    assert runtime.capabilities.process and runtime.capabilities.shell
    assert runtime.capabilities.languages == ()
    assert runtime.capabilities.filesystem == ()
    assert runtime.capabilities.reach == "process"
    with pytest.raises(TypeError, match="home"):
        SandlockRuntime(config={"home": "python3"})


@pytest.mark.asyncio
async def test_missing_cli_fails_loud(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(FileNotFoundError, match="sandlock CLI on PATH"):
        await SandlockRuntime().execute(
            ProcessExecution(argv=("node", ), cwd=PathSpec.from_str_path("/")))


@pytest.mark.asyncio
async def test_empty_argv_is_refused():
    with pytest.raises(ValueError, match="argv must not be empty"):
        await SandlockRuntime().execute(
            ProcessExecution(argv=(), cwd=PathSpec.from_str_path("/")))


@pytest.mark.asyncio
async def test_cancellation_reaps_the_cli(cli):
    runtime = SandlockRuntime()
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            runtime.execute(
                ProcessExecution(argv=("wait", ),
                                 cwd=PathSpec.from_str_path(str(cli)))), 0.1)
    assert not runtime._children


@pytest.mark.asyncio
async def test_close_reaps_an_active_cli(cli):
    runtime = SandlockRuntime()
    task = asyncio.create_task(
        runtime.execute(
            ProcessExecution(argv=("wait", ),
                             cwd=PathSpec.from_str_path(str(cli)))))
    async with asyncio.timeout(2):
        while not runtime._children:
            await asyncio.sleep(0.01)
        await runtime.close()
        result = await task
    assert result.exit_code != 0
    assert not runtime._children
