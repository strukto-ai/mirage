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
import io
import time
import uuid
from pathlib import Path
from typing import Literal

import pytest
from agents import Runner, RunState
from agents.run import RunConfig
from agents.sandbox import Manifest, SandboxAgent, SandboxRunConfig
from agents.sandbox.apply_patch import WorkspaceEditor
from agents.sandbox.capabilities import Shell
from agents.sandbox.capabilities.shell import ShellToolSet
from agents.sandbox.entries import File
from agents.sandbox.errors import ExecTimeoutError
from agents.sandbox.manifest import Environment
from agents.sandbox.session.sandbox_session_state import SandboxSessionState

from mirage.agents.openai_agents.constants import (
    INTERRUPT,
    INTERRUPTED_EXIT_CODE,
    NO_STDIN,
)
from mirage.agents.openai_agents.sandbox import (
    MirageSandboxClient,
    combined_output,
    shell_line,
)
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _make_client() -> MirageSandboxClient:
    ram = RAMVFS()
    ws = Workspace(
        {"/": (ram, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    return MirageSandboxClient(ws)


def test_create_session_with_default_mounts():
    async def _run():
        client = _make_client()
        session = await client.create()
        result = await session.exec("echo", "hello", shell=False)
        assert result.exit_code == 0
        assert b"hello" in result.stdout

    asyncio.run(_run())


def test_session_file_read_write():
    async def _run():
        client = _make_client()
        session = await client.create()

        content = b"test file content"
        await session.write(Path("myfile.txt"), io.BytesIO(content))

        stream = await session.read(Path("myfile.txt"))
        assert stream.read() == content

    asyncio.run(_run())


def test_persist_and_hydrate_workspace():
    async def _run():
        client = _make_client()
        session = await client.create()
        await session.write(Path("data.txt"), io.BytesIO(b"persist me"))

        snapshot = await session.persist_workspace()

        client2 = _make_client()
        session2 = await client2.create()
        await session2.hydrate_workspace(snapshot)

        stream = await session2.read(Path("data.txt"))
        assert stream.read() == b"persist me"

    asyncio.run(_run())


def test_session_running_state():
    async def _run():
        client = _make_client()
        session = await client.create()
        assert await session.running() is True

    asyncio.run(_run())


def test_exec_names_the_reason_beside_a_refused_command():
    # stderr is bash's bare `Permission denied`; the reason rides the
    # refusal record, and a byte surface appends it as one more line.

    async def _run():
        ws = Workspace(
            {"/": (RAMVFS(), MountMode.WRITE)},
            mode=MountMode.WRITE,
            route_policy=lambda ctx: (
                {"deny": "no deletes"} if ctx.command == "rm" else None
            ),
        )
        session = await MirageSandboxClient(ws).create()
        result = await session.exec("rm", "/x", shell=False)
        assert result.exit_code == 126
        assert result.stderr == (
            b"rm: Permission denied\npolicy denied: no deletes\n"
        )

    asyncio.run(_run())


def _workspace() -> Workspace:
    return Workspace(
        {
            "/": (RAMVFS(), MountMode.WRITE),
            "/ro": (RAMVFS(), MountMode.READ),
        },
        mode=MountMode.WRITE,
    )


def test_argv_keeps_its_word_boundaries():
    async def _run():
        session = await _make_client().create()
        result = await session.exec("printf", "%s|", "a b", "c", shell=False)
        assert result.stdout == b"a b|c|"

    asyncio.run(_run())


def test_a_single_string_without_a_shell_is_one_program_name():
    async def _run():
        session = await _make_client().create()
        result = await session.exec("echo hello", shell=False)
        assert result.exit_code == 127

    asyncio.run(_run())


def test_a_shell_prefix_runs_the_line_itself():
    async def _run():
        session = await _make_client().create()
        result = await session.exec("echo $((1 + 2))", shell=["sh", "-c"])
        assert result.stdout == b"3\n"

    asyncio.run(_run())


def test_exec_raises_on_its_timeout():
    async def _run():
        session = await _make_client().create()
        start = time.perf_counter()
        with pytest.raises(ExecTimeoutError):
            await session.exec("sleep 5", timeout=0.2)
        assert time.perf_counter() - start < 2

    asyncio.run(_run())


def test_commands_start_at_the_manifest_root():
    async def _run():
        client = MirageSandboxClient(_workspace())
        session = await client.create(
            manifest=Manifest(
                root="/workspace", entries={"notes.md": File(content=b"hi\n")}
            )
        )
        await session.start()
        assert (await session.exec("pwd")).stdout == b"/workspace\n"
        assert (await session.exec("cat notes.md")).stdout == b"hi\n"

    asyncio.run(_run())


def test_an_unconfigured_session_runs_at_the_mirage_root():
    async def _run():
        session = await _make_client().create()
        assert session.state.manifest.root == "/"
        assert (await session.exec("pwd")).stdout == b"/\n"

    asyncio.run(_run())


def test_cd_and_export_do_not_outlive_their_command():
    async def _run():
        session = await _make_client().create()
        await session.exec("cd /tmp; export X=1")
        assert (await session.exec("pwd; echo X=$X")).stdout == b"/\nX=\n"

    asyncio.run(_run())


def test_each_sandbox_session_owns_a_mirage_session_until_deleted():
    async def _run():
        ws = _workspace()
        client = MirageSandboxClient(ws)
        first = await client.create()
        second = await client.create()
        ids = {s.session_id for s in ws.list_sessions()}
        first_id = f"openai-{first.state.session_id.hex}"
        assert first_id in ids
        assert f"openai-{second.state.session_id.hex}" in ids
        await client.delete(first)
        assert first_id not in {s.session_id for s in ws.list_sessions()}

    asyncio.run(_run())


def test_relative_paths_resolve_against_the_manifest_root():
    async def _run():
        ws = _workspace()
        session = await MirageSandboxClient(ws).create(
            manifest=Manifest(root="/project")
        )
        await session.start()
        await session.write(Path("rel.txt"), io.BytesIO(b"rel"))
        assert await ws.vfs.read("/project/rel.txt") == b"rel"
        assert (await session.read(Path("rel.txt"))).read() == b"rel"

    asyncio.run(_run())


def test_write_creates_every_missing_parent():
    async def _run():
        ws = _workspace()
        session = await MirageSandboxClient(ws).create()
        await session.write(Path("/a/b/c/d.txt"), io.BytesIO(b"deep"))
        assert await ws.vfs.read("/a/b/c/d.txt") == b"deep"

    asyncio.run(_run())


def test_resume_after_delete_keeps_the_agents_edits():
    async def _run():
        ws = _workspace()
        client = MirageSandboxClient(ws)
        session = await client.create(
            manifest=Manifest(
                root="/workspace", entries={"notes.md": File(content=b"v1\n")}
            )
        )
        await session.start()
        await session.exec("echo v2 > notes.md")
        state = session.state
        await client.delete(session)
        resumed = await client.resume(state)
        await resumed.start()
        assert (await resumed.exec("cat notes.md")).stdout == b"v2\n"

    asyncio.run(_run())


def test_resume_refuses_another_backends_state():
    class OtherState(SandboxSessionState):
        type: Literal["other"] = "other"

    async def _run():
        client = MirageSandboxClient(_workspace())
        session = await client.create()
        other = OtherState(
            session_id=uuid.uuid4(),
            snapshot=session.state.snapshot,
            manifest=session.state.manifest,
        )
        with pytest.raises(TypeError, match="'other'"):
            await client.resume(other)

    asyncio.run(_run())


def test_a_long_command_keeps_running_in_the_background():
    async def _run():
        session = await _make_client().create()
        started = await session.pty_exec_start(
            "sleep 1; echo done", yield_time_s=0.25
        )
        assert started.process_id is not None
        assert started.exit_code is None
        finished = await session.pty_write_stdin(
            session_id=started.process_id, chars="", yield_time_s=5
        )
        assert finished.process_id is None
        assert finished.exit_code == 0
        assert finished.output == b"done\n"

    asyncio.run(_run())


def test_a_quick_background_command_answers_at_once():
    async def _run():
        session = await _make_client().create()
        update = await session.pty_exec_start("echo out; echo err >&2")
        assert update.process_id is None
        assert update.exit_code == 0
        assert update.output == b"out\nerr\n"

    asyncio.run(_run())


def test_interrupt_cancels_a_background_command():
    async def _run():
        session = await _make_client().create()
        started = await session.pty_exec_start("sleep 30", yield_time_s=0.25)
        assert started.process_id is not None
        stopped = await session.pty_write_stdin(
            session_id=started.process_id, chars=INTERRUPT
        )
        assert stopped.exit_code == INTERRUPTED_EXIT_CODE
        assert stopped.process_id is None

    asyncio.run(_run())


def test_a_background_command_refuses_stdin():
    async def _run():
        session = await _make_client().create()
        started = await session.pty_exec_start("sleep 30", yield_time_s=0.25)
        assert started.process_id is not None
        with pytest.raises(RuntimeError, match=NO_STDIN):
            await session.pty_write_stdin(
                session_id=started.process_id, chars="y\n"
            )
        await session.pty_terminate_all()

    asyncio.run(_run())


def test_shell_line_quotes_an_argv_and_keeps_a_shell_string():
    assert shell_line(["ls", "-la", "--", "a b"], False) == "ls -la -- 'a b'"
    assert shell_line(["ls -la | wc -l"], True) == "ls -la | wc -l"


def test_combined_output_puts_stderr_on_its_own_line():
    from agents.sandbox.types import ExecResult

    assert (
        combined_output(ExecResult(exit_code=1, stdout=b"a", stderr=b"b"))
        == "a\nb"
    )
    assert (
        combined_output(ExecResult(exit_code=0, stdout=b"a\n", stderr=b""))
        == "a\n"
    )


def test_an_approved_command_resumes_through_the_runner(scripted_model):
    def gate(tools: ShellToolSet) -> None:
        tools.exec_command.needs_approval = True

    async def _run():
        client = MirageSandboxClient(_workspace())
        agent = SandboxAgent(
            name="gated",
            model=scripted_model([("exec_command", {"cmd": "echo resumed"})]),
            capabilities=[Shell(configure_tools=gate)],
        )
        config = RunConfig(
            sandbox=SandboxRunConfig(client=client), tracing_disabled=True
        )
        paused = await Runner.run(agent, "go", run_config=config)
        assert [item.name for item in paused.interruptions] == ["exec_command"]
        state = await RunState.from_json(agent, paused.to_state().to_json())
        for interruption in state.get_interruptions():
            state.approve(interruption)
        result = await Runner.run(agent, state, run_config=config)
        assert "resumed" in result.final_output

    asyncio.run(_run())


def test_commands_see_the_manifest_environment():
    async def _run():
        session = await _make_client().create(
            manifest=Manifest(
                root="/project",
                environment=Environment(value={"GREETING": "hi"}),
            )
        )
        await session.start()
        assert (await session.exec("echo $GREETING")).stdout == b"hi\n"
        update = await session.pty_exec_start("echo $GREETING")
        assert update.output == b"hi\n"

    asyncio.run(_run())


def test_a_background_command_raises_on_its_timeout():
    async def _run():
        session = await _make_client().create()
        started = await session.pty_exec_start(
            "sleep 5", timeout=0.3, yield_time_s=0.25
        )
        assert started.process_id is not None
        with pytest.raises(ExecTimeoutError):
            await session.pty_write_stdin(
                session_id=started.process_id, chars="", yield_time_s=3
            )

    asyncio.run(_run())


def test_apply_patch_writes_inside_the_sandbox_session():
    async def _run():
        ws = _workspace()
        session = await MirageSandboxClient(ws).create()
        seen: list[str | None] = []
        write = ws.vfs.write

        async def recording_write(path, data, *, session_id=None):
            seen.append(session_id)
            await write(path, data, session_id=session_id)

        ws.vfs.write = recording_write
        await WorkspaceEditor(session).apply_patch(
            {
                "type": "create_file",
                "path": "pkg/new.py",
                "diff": "+x = 1\n",
            }
        )
        assert seen == [f"openai-{session.state.session_id.hex}"]

    asyncio.run(_run())
