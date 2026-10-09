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
import inspect
import io

import pytest

from mirage.context import reset_current_session, set_current_session
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Session, Workspace
from mirage.workspace.session import RAMSessionStore
from mirage.workspace.snapshot import apply_state_dict, read_tar

PROFILES = {"reviewer": {"paths": {"hide": ["/repo/secrets"]}}}

# The one argument a `Session` answers for itself: it *is* the session, so
# naming one per call would be a second, contradictory source.
BOUND = "session_id"

# Arguments the executor's nested evals thread through and no embedder
# types. Exempt because they are marked ``Internal.`` in the docstring,
# which ``test_every_exemption_says_it_is_internal`` pins: adding a name
# here means documenting it as internal, not editing a list.
INTERNAL = (
    "routing_decision",
    "handed",
    "sink",
    "call_stack",
    "execution_scope",
    "job_table",
)


def _seeded() -> Workspace:
    ws = Workspace(
        {"/repo/": RAMVFS()}, mode=MountMode.WRITE, profiles=PROFILES
    )
    return ws


async def _seed(ws: Workspace) -> None:
    await ws.shell(
        "mkdir -p /repo/secrets && echo hello > /repo/README.md"
        " && echo PRIVATE > /repo/secrets/key.pem"
    )


@pytest.mark.asyncio
async def test_a_handle_binds_both_entry_points_to_one_session():
    # One object per agent: the shell entry point and the dispatcher answer
    # under the same profile, so a hide the shell honors is a hide the
    # file tool honors too.
    ws = _seeded()
    try:
        await _seed(ws)
        reviewer = await ws.session("reviewer", profile="reviewer")
        assert isinstance(reviewer, Session)
        assert reviewer.session_id == "reviewer"
        assert reviewer.state is ws.get_session("reviewer")
        shown = await reviewer.shell("cat /repo/README.md")
        assert shown.stdout == b"hello\n"
        hidden = await reviewer.shell("cat /repo/secrets/key.pem")
        assert hidden.exit_code == 1
        assert await reviewer.vfs.read("/repo/README.md") == b"hello\n"
        with pytest.raises(FileNotFoundError):
            await reviewer.vfs.read("/repo/secrets/key.pem")
        assert await ws.vfs.read("/repo/secrets/key.pem") == b"PRIVATE\n"
        assert reviewer.vfs.records is ws.vfs.records
        assert await reviewer.glob("/repo/*") == ["/repo/README.md"]
        assert await ws.glob("/repo/*") == ["/repo/README.md", "/repo/secrets"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_handle_adopts_an_existing_session_and_refuses_a_profile():
    ws = _seeded()
    try:
        first = await ws.session("reviewer", profile="reviewer")
        again = await ws.session("reviewer")
        assert again.state is first.state
        with pytest.raises(ValueError, match="exists"):
            await ws.session("reviewer", profile="reviewer")
        with pytest.raises(ValueError, match="exists"):
            await ws.session("reviewer", mounts={"/repo": "read"})
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_handle_adopts_a_persisted_session_before_creating_one():
    # A session store hydrates on first use, so a handle asked for
    # before any async entry point has run used to see an empty session
    # table, recreate a persisted session bare, and hand the next
    # flush a record that overwrote the stored profile. The entry point
    # hydrates first, so the stored session is adopted as is.
    store = RAMSessionStore()
    first = Workspace(
        {"/repo/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=PROFILES,
        session_store=store,
    )
    second = Workspace(
        {"/repo/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles=PROFILES,
        session_store=store,
    )
    try:
        created = await first.session("reviewer", profile="reviewer")
        assert created.state.visibility.paths is not None
        await first.flush_sessions()
        adopted = await second.session("reviewer")
        assert adopted.state.visibility.paths is not None
        with pytest.raises(ValueError, match="exists"):
            await second.session("reviewer", profile="reviewer")
    finally:
        await first.close()
        await second.close()


@pytest.mark.asyncio
async def test_a_handle_forwards_per_call_options():
    ws = _seeded()
    try:
        await _seed(ws)
        reviewer = await ws.session("reviewer", profile="reviewer")
        forked = await reviewer.shell("pwd", cwd="/repo")
        assert forked.stdout == b"/repo\n"
        assert reviewer.state.cwd != "/repo"
        token = set_current_session(ws.get_session(ws.default_session_id))
        try:
            # A session already bound is kept by the dispatcher, so a
            # handle reached from inside the default session's own
            # command reads as that session, never wider.
            assert (
                await reviewer.vfs.read("/repo/secrets/key.pem")
                == b"PRIVATE\n"
            )
        finally:
            reset_current_session(token)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_session_has_one_tool_table_every_caller_shares():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo one > /a.txt")
    agent = await ws.session("agent")
    other = await ws.session("other")
    try:
        assert agent.tools is Session(ws, "agent").tools
        assert ws.tools is Session(ws, None).tools
        await agent.tools.call("read", {"path": "/a.txt"})
        written = await Session(ws, "agent").tools.call(
            "write", {"path": "/a.txt", "content": "two\n"}
        )
        refused = await other.tools.call(
            "write", {"path": "/a.txt", "content": "three\n"}
        )
    finally:
        await ws.close()
    assert not written.is_error
    assert refused.is_error
    assert "read all of it" in refused.text


@pytest.mark.asyncio
async def test_closing_a_session_drops_its_tool_table():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo one > /a.txt")
    agent = await ws.session("agent")
    try:
        await agent.tools.call("read", {"path": "/a.txt"})
        await ws.close_session("agent")
        again = await ws.session("agent")
        refused = await again.tools.call(
            "write", {"path": "/a.txt", "content": "two\n"}
        )
    finally:
        await ws.close()
    assert refused.is_error


@pytest.mark.asyncio
async def test_the_default_tool_table_follows_a_restored_default():
    source = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await source.shell("echo one > /a.txt")
    buf = io.BytesIO()
    await source.snapshot(buf)
    restored = source.default_session_id
    await source.close()
    buf.seek(0)
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    tools = ws.tools
    try:
        await apply_state_dict(ws, read_tar(buf))
        read = await tools.call("read", {"path": "/a.txt"})
    finally:
        await ws.close()
    assert ws.default_session_id == restored
    assert not read.is_error, read.text
    assert ws.tools is tools


@pytest.mark.asyncio
async def test_an_explicit_default_id_keeps_its_session_after_a_restore():
    source = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await source.shell("echo one > /a.txt")
    buf = io.BytesIO()
    await source.snapshot(buf)
    await source.close()
    buf.seek(0)
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    pinned = Session(ws, ws.default_session_id).tools
    try:
        assert pinned is not ws.tools
        await apply_state_dict(ws, read_tar(buf))
        with pytest.raises(KeyError):
            await pinned.call("read", {"path": "/a.txt"})
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_restored_default_starts_with_no_read_history():
    source = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await source.shell("echo one > /a.txt")
    buf = io.BytesIO()
    await source.snapshot(buf)
    await source.close()
    buf.seek(0)
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo one > /a.txt")
    tools = ws.tools
    try:
        await tools.call("read", {"path": "/a.txt"})
        await apply_state_dict(ws, read_tar(buf))
        refused = await tools.call(
            "write", {"path": "/a.txt", "content": "two\n"}
        )
    finally:
        await ws.close()
    assert refused.is_error
    assert "read all of it" in refused.text


@pytest.mark.asyncio
async def test_default_tables_share_one_read_history():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo one > /a.txt")
    try:
        await ws.tools.call("read", {"path": "/a.txt"})
        written = await Session(ws, ws.default_session_id).tools.call(
            "write", {"path": "/a.txt", "content": "two\n"}
        )
    finally:
        await ws.close()
    assert not written.is_error, written.text


@pytest.mark.asyncio
async def test_a_restored_session_starts_with_no_read_history():
    source = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await source.shell("echo one > /a.txt")
    await source.session("agent")
    buf = io.BytesIO()
    await source.snapshot(buf)
    await source.close()
    buf.seek(0)
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo one > /a.txt")
    agent = (await ws.session("agent")).tools
    try:
        await agent.call("read", {"path": "/a.txt"})
        await apply_state_dict(ws, read_tar(buf))
        refused = await agent.call(
            "write", {"path": "/a.txt", "content": "two\n"}
        )
    finally:
        await ws.close()
    assert refused.is_error
    assert "read all of it" in refused.text


@pytest.mark.asyncio
async def test_a_read_in_flight_during_a_restore_counts_for_no_one():
    source = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await source.shell("echo one > /a.txt")
    buf = io.BytesIO()
    await source.snapshot(buf)
    await source.close()
    buf.seek(0)
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo one > /a.txt")
    reads = await ws._session_reads(None)
    entered, release = asyncio.Event(), asyncio.Event()
    real = reads.read

    async def held(path: str) -> bytes:
        data = await real(path)
        entered.set()
        await release.wait()
        return data

    reads.read = held  # type: ignore[method-assign]
    try:
        pending = asyncio.create_task(
            ws.tools.call("read", {"path": "/a.txt"})
        )
        await entered.wait()
        await apply_state_dict(ws, read_tar(buf))
        release.set()
        await pending
        refused = await ws.tools.call(
            "write", {"path": "/a.txt", "content": "two\n"}
        )
    finally:
        await ws.close()
    assert refused.is_error
    assert "read all of it" in refused.text


def _params(fn) -> list[inspect.Parameter]:
    return [
        p
        for name, p in inspect.signature(fn).parameters.items()
        if name != "self"
    ]


def test_the_handle_forwards_every_argument_the_workspace_takes():
    """``Session.shell`` is ``Workspace.shell`` with the session
    fixed, and the forwarding is hand-copied, so a parameter added to
    one has to reach the other. Without this, a new argument would be
    invisible from a `Session` and nothing would fail.
    """
    skip = (BOUND, *INTERNAL)
    wide = [p for p in _params(Workspace.shell) if p.name not in skip]
    bound = _params(Session.shell)
    assert [p.name for p in bound] == [p.name for p in wide]
    for got, want in zip(bound, wide):
        assert got.annotation == want.annotation, got.name
        assert got.default == want.default, got.name
        assert got.kind == want.kind, got.name


def test_the_handle_answers_for_the_session_itself():
    assert BOUND in inspect.signature(Workspace.shell).parameters
    assert BOUND not in inspect.signature(Session.shell).parameters


def test_every_exemption_says_it_is_internal():
    """An argument a `Session` may omit has to declare why in the
    docstring, so the allowlist cannot grow by edit alone.
    """
    doc = Workspace.shell.__doc__ or ""
    for name in INTERNAL:
        assert f"{name}: Internal." in doc, name
        assert name not in inspect.signature(Session.shell).parameters
