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
import itertools
import uuid
from typing import Any

import pytest

from mirage.cache.index import IndexConfig
from mirage.cache.index.config import LookupStatus
from mirage.commands.cli.builtin.gws import GWS
from mirage.context import reset_current_session, set_current_session
from mirage.runtime.sandbox import RemoteSandbox
from mirage.shell.job_table.ram import RAMJobStore
from mirage.types import MountBackend, MountMode
from mirage.utils.clock import ManualClock
from mirage.utils.ids import SeededIdSource, SystemIdSource
from mirage.vfs.gdrive.config import GoogleDriveConfig
from mirage.vfs.gdrive.gdrive import GoogleDriveVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Session, Workspace
from mirage.workspace.mount.namespace.ram import RAMNamespaceStore
from mirage.workspace.mount.spec import Mount
from mirage.workspace.shell_execution import ShellExecution
from mirage.workspace.snapshot import apply_state_dict, read_tar

SEED_5_IDS = [
    "00000000-0000-709b-a78b-37e02557f3ef",
    "00000000-0000-709c-a45f-a2ddcbf27499",
    "00000000-0000-709d-8a25-2d58fd25f996",
    "00000000-0000-709e-b168-26af1c8ce177",
]

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
    "session",
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
        assert (ws.vfs.records[-1].op, ws.vfs.records[-1].path) == (
            "read",
            "/repo/README.md",
        )
        with pytest.raises(FileNotFoundError):
            await reviewer.vfs.read("/repo/secrets/key.pem")
        assert await ws.vfs.read("/repo/secrets/key.pem") == b"PRIVATE\n"
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
    store = RAMNamespaceStore()
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


@pytest.mark.asyncio
async def test_one_clock_ages_the_file_cache_and_every_mount_index():
    clock = ManualClock(start=1000.0)
    ws = Workspace(
        {"/a": RAMVFS()},
        mode=MountMode.WRITE,
        index=IndexConfig(ttl=60),
        clock=clock,
    )
    try:
        ws.add_mount("/b", RAMVFS(), MountMode.WRITE)
        stores = [ws.mount(p).index_store for p in ("/a", "/b")]
        await ws.cache.set("/a/f.txt", b"hello", ttl=60)
        for prefix, store in zip(("/a", "/b"), stores):
            await store.set_dir(prefix, [])
        clock.advance(59)
        assert await ws.cache.exists("/a/f.txt") is True
        for prefix, store in zip(("/a", "/b"), stores):
            assert (await store.list_dir(prefix)).status is None
        clock.advance(1)
        assert await ws.cache.exists("/a/f.txt") is False
        for prefix, store in zip(("/a", "/b"), stores):
            assert (
                await store.list_dir(prefix)
            ).status == LookupStatus.EXPIRED
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_one_clock_reaches_every_mount_and_cli_token_manager():
    clock = ManualClock(start=1000.0)
    config = GoogleDriveConfig(client_id="c", refresh_token="r")
    ws = Workspace(
        {"/a": GoogleDriveVFS(config)}, mode=MountMode.WRITE, clock=clock
    )
    try:
        ws.add_mount("/b", GoogleDriveVFS(config), MountMode.WRITE)
        install = ws.register_cli(
            "gws", GWS, {"client_id": "c", "refresh_token": "r"}
        )
        managers = [
            ws.mount("/a").vfs.accessor.token_manager,
            ws.mount("/b").vfs.accessor.token_manager,
            install.accessor.token_manager,
        ]
        assert [m.clock for m in managers] == [clock, clock, clock]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_manual_clock_workspace_keeps_one_time_domain_in_history():
    clock = ManualClock(start=1_000_000.0)
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE, clock=clock)
    try:
        await ws.shell("echo hi > /data/a.txt")
        clock.advance(5)
        await ws.shell("cat /data/a.txt")
        clock.advance(5)
        await ws.vfs.read("/data/a.txt")
        await ws.shell("history -c")
        await asyncio.sleep(0)
        events = await ws.observer.events()
        assert {e["type"] for e in events} >= {"op", "command", "clear"}
        assert {e["timestamp"] for e in events} == {
            1_000_000_000,
            1_000_005_000,
            1_000_010_000,
        }
        assert {(r.timestamp, r.duration_ms) for r in ws.vfs.records} == {
            (1_000_000_000, 0),
            (1_000_005_000, 0),
            (1_000_010_000, 0),
        }
    finally:
        await ws.close()


def _drive() -> GoogleDriveVFS:
    return GoogleDriveVFS(GoogleDriveConfig(client_id="c", refresh_token="r"))


@pytest.mark.asyncio
async def test_a_vfs_held_on_another_workspace_clock_is_refused():
    vfs = _drive()
    first = Workspace({"/g": vfs}, mode=MountMode.WRITE, clock=ManualClock())
    try:
        with pytest.raises(ValueError, match="another clock"):
            Workspace({"/g": vfs}, mode=MountMode.WRITE, clock=ManualClock())
        with pytest.raises(ValueError, match="another clock"):
            Workspace({"/g": vfs}, mode=MountMode.WRITE)
    finally:
        await first.close()


@pytest.mark.asyncio
async def test_two_workspaces_may_share_a_vfs_on_one_clock():
    vfs, clock = _drive(), ManualClock()
    first = Workspace({"/g": vfs}, mode=MountMode.WRITE, clock=clock)
    second = Workspace({"/g": vfs}, mode=MountMode.WRITE, clock=clock)
    try:
        assert vfs.accessor.token_manager.clock is clock
    finally:
        await second.close()
        await first.close()


@pytest.mark.asyncio
async def test_closing_a_workspace_lets_go_of_its_clock():
    vfs = _drive()
    ws = Workspace({"/g": vfs}, mode=MountMode.WRITE, clock=ManualClock())
    await ws.close()
    later = ManualClock()
    vfs.accessor.bind_clock(later, "later")
    assert vfs.accessor.token_manager.clock is later


@pytest.mark.asyncio
async def test_unmounting_lets_go_of_the_clock():
    vfs = _drive()
    ws = Workspace({"/g": vfs}, mode=MountMode.WRITE, clock=ManualClock())
    try:
        await ws.unmount("/g")
        later = ManualClock()
        vfs.accessor.bind_clock(later, "later")
        assert vfs.accessor.token_manager.clock is later
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_refused_workspace_lets_go_of_what_it_placed():
    free, held = _drive(), _drive()
    holder = Workspace({"/h": held}, mode=MountMode.WRITE, clock=ManualClock())
    try:
        with pytest.raises(ValueError, match="another clock"):
            Workspace(
                {"/a": free, "/b": held},
                mode=MountMode.WRITE,
                clock=ManualClock(),
            )
        later = ManualClock()
        free.accessor.bind_clock(later, "later")
        assert free.accessor.token_manager.clock is later
    finally:
        await holder.close()


@pytest.mark.asyncio
async def test_a_workspace_failing_after_its_mounts_holds_no_clock():
    vfs = _drive()
    with pytest.raises(ValueError, match="unknown cli"):
        Workspace(
            {"/g": vfs},
            mode=MountMode.WRITE,
            clock=ManualClock(),
            clis={"x": ("no-such-cli", None)},
        )
    later = ManualClock()
    vfs.accessor.bind_clock(later, "later")
    assert vfs.accessor.token_manager.clock is later


@pytest.mark.asyncio
async def test_closing_one_workspace_keeps_another_s_hold():
    vfs, clock = _drive(), ManualClock()
    first = Workspace({"/g": vfs}, mode=MountMode.WRITE, clock=clock)
    second = Workspace({"/g": vfs}, mode=MountMode.WRITE, clock=clock)
    try:
        await first.close()
        with pytest.raises(ValueError, match="another clock"):
            vfs.accessor.bind_clock(ManualClock(), "later")
    finally:
        await second.close()


@pytest.mark.asyncio
async def test_unmounting_one_of_two_mounts_of_a_vfs_keeps_the_clock():
    vfs = _drive()
    ws = Workspace({"/g": vfs}, mode=MountMode.WRITE, clock=ManualClock())
    try:
        ws.add_mount("/h", vfs, MountMode.WRITE)
        await ws.unmount("/h")
        with pytest.raises(ValueError, match="another clock"):
            vfs.accessor.bind_clock(ManualClock(), "later")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_mount_added_later_takes_the_workspace_clock():
    clock, vfs = ManualClock(), _drive()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE, clock=clock)
    try:
        ws.add_mount("/g", vfs, MountMode.WRITE)
        assert vfs.accessor.token_manager.clock is clock
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_adding_a_vfs_held_on_another_clock_holds_nothing():
    vfs = _drive()
    holder = Workspace({"/g": vfs}, mode=MountMode.WRITE, clock=ManualClock())
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.WRITE, clock=ManualClock()
    )
    try:
        with pytest.raises(ValueError, match="another clock"):
            ws.add_mount("/g", vfs, MountMode.WRITE)
        await holder.close()
        later = ManualClock()
        vfs.accessor.bind_clock(later, "later")
        assert vfs.accessor.token_manager.clock is later
    finally:
        await ws.close()


def _refuse_fuse(*_args: Any, **_kwargs: Any) -> None:
    raise RuntimeError("no FUSE here")


@pytest.mark.asyncio
async def test_a_failing_kernel_mount_lets_go_of_the_clock(monkeypatch):
    monkeypatch.setattr(Workspace, "add_fuse_mount", _refuse_fuse)
    vfs = _drive()
    with pytest.raises(RuntimeError, match="no FUSE here"):
        Workspace(
            {
                "/g": Mount(
                    vfs, backend=MountBackend.FUSE, mountpoint="/tmp/mnt-g"
                )
            },
            mode=MountMode.WRITE,
            clock=ManualClock(),
        )
    later = ManualClock()
    vfs.accessor.bind_clock(later, "later")
    assert vfs.accessor.token_manager.clock is later


@pytest.mark.asyncio
async def test_an_unmount_holds_the_clock_until_its_calls_finish():
    vfs = _drive()
    ws = Workspace({"/g": vfs}, mode=MountMode.WRITE, clock=ManualClock())
    try:
        done = ws.mount("/g").activity.acquire()
        unmounting = asyncio.create_task(ws.unmount("/g"))
        try:
            while any(m.prefix == "/g/" for m in ws.mounts()):
                await asyncio.sleep(0)
            with pytest.raises(ValueError, match="another clock"):
                vfs.accessor.bind_clock(ManualClock(), "later")
        finally:
            done()
            await unmounting
        later = ManualClock()
        vfs.accessor.bind_clock(later, "later")
        assert vfs.accessor.token_manager.clock is later
    finally:
        await ws.close()


async def _replay(seed: int) -> list[str]:
    ws = Workspace(
        {"/data": RAMVFS(), "/more": RAMVFS()},
        mode=MountMode.WRITE,
        ids=SeededIdSource(seed),
    )
    try:
        await ws.shell("seq 1 20 > /data/n.txt && seq 30 40 > /more/m.txt")
        seen = [
            ws.workspace_id,
            ws.default_session_id,
            ws.mount("/data").mount_id,
        ]
        for line in (
            "mktemp -u /data/t.XXXXXX",
            "shuf -n 3 /data/n.txt",
            "shuf -i 1-9",
            "cat /data/n.txt | shuf -n 2",
            "shuf -n 4 /data/n.txt /more/m.txt",
        ):
            result = await ws.shell(line)
            assert result.exit_code == 0, line
            seen.append(await result.stdout_str())
        seen.extend(
            str(event.get("execution_id"))
            for event in await ws.observer.events()
        )
        copy = await ws.copy()
        try:
            seen.append(copy.mount("/data").mount_id)
        finally:
            await copy.close()
        return seen
    finally:
        await ws.close()


def _refuse_draw(self):
    raise AssertionError("a seeded workspace drew from the system")


def _refuse_system_draws(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(SystemIdSource, "uuid7", _refuse_draw)
    monkeypatch.setattr(SystemIdSource, "random_u32", _refuse_draw)


@pytest.mark.asyncio
async def test_one_id_source_replays_every_id_and_draw_of_a_run(monkeypatch):
    _refuse_system_draws(monkeypatch)
    first = await _replay(5)
    assert first == await _replay(5)
    assert first != await _replay(6)


@pytest.mark.asyncio
async def test_a_seeded_workspace_mints_its_ids_in_a_fixed_order():
    # Pinned by workspace.test.ts too: the workspace id, the default
    # session id, then each mount, on both hosts.
    ws = Workspace({"/data": RAMVFS()}, ids=SeededIdSource(5))
    try:
        assert [
            ws.workspace_id,
            ws.default_session_id,
            ws.mount("/dev").mount_id,
            ws.mount("/data").mount_id,
        ] == SEED_5_IDS
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_default_id_source_stamps_from_the_workspace_clock():
    ws = Workspace(
        {"/data": RAMVFS()}, clock=ManualClock(start=1_700_000_000.0)
    )
    try:
        for value in [
            ws.workspace_id,
            ws.default_session_id,
            ws.mount("/data").mount_id,
        ]:
            assert uuid.UUID(value).int >> 80 == 1_700_000_000_000
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_sessions_are_created_on_the_workspace_clock():
    clock = ManualClock(start=1_000.0)
    ws = Workspace({"/data": RAMVFS()}, clock=clock)
    try:
        clock.advance(5)
        created = ws.create_session("other")
        assert ws.get_session(ws.default_session_id).created_at == 1_000.0
        assert created.created_at == 1_005.0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_given_id_outranks_the_id_source():
    ws = Workspace(
        {"/data": RAMVFS()},
        workspace_id="ws-given",
        session_id="sess-given",
        ids=SeededIdSource(5),
    )
    try:
        assert ws.workspace_id == "ws-given"
        assert ws.default_session_id == "sess-given"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_close_cancels_streamed_lines_in_the_order_they_started(
    monkeypatch,
):
    # Hashes that fall as lines start, so a set visits them out of start
    # order; close must follow start order, whatever the hashes are.
    hashes = itertools.count(1_000, -1)
    assigned: dict[int, int] = {}
    monkeypatch.setattr(
        ShellExecution,
        "__hash__",
        lambda self: assigned.setdefault(id(self), next(hashes)),
    )
    cancelled: list[ShellExecution] = []
    cancel = ShellExecution.cancel

    def recording(self: ShellExecution) -> None:
        cancelled.append(self)
        cancel(self)

    monkeypatch.setattr(ShellExecution, "cancel", recording)
    ws = Workspace({"/data": RAMVFS()})
    started = [await ws.shell("sleep 100", stream=True) for _ in range(4)]
    await ws.close()
    assert cancelled[: len(started)] == started


class _ReapedBox(RemoteSandbox):
    """A sandbox runtime that records the runs it was asked to reap, and
    holds those its tags name."""

    name = "reapbox"

    def __init__(self, holds: tuple[str, ...]) -> None:
        super().__init__(captures=("never-run",))
        self.holds = holds
        self.reaped: list[tuple[str, int]] = []

    async def connect(self) -> None:
        return None

    async def reap(self, tag: str, signum: int) -> bool:
        self.reaped.append((tag, signum))
        if tag == "broken":
            raise RuntimeError("box not answering")
        return tag in self.holds


# A lapsed workspace's runs are stopped by whatever reaches them here: a
# sandbox run by the runtime of its name, and reached once its box held
# it. A run the box does not hold (another box of the name, as another
# workspace's docker may target), one whose box did not answer, a run of
# another host and one of a runtime this workspace lacks are answered
# back as out of reach.
@pytest.mark.asyncio
async def test_a_workspace_reaps_the_runs_its_runtimes_reach():
    box = _ReapedBox(("t1",))
    ws = Workspace({}, runtimes=[box])
    try:
        mine = {"runtime": "reapbox", "tag": "t1", "command": "x"}
        elsewhere = {"runtime": "reapbox", "tag": "t3", "command": "z"}
        broken = {"runtime": "reapbox", "tag": "broken", "command": "w"}
        theirs = {"runtime": "otherbox", "tag": "t2", "command": "y"}
        host = {"host": "elsewhere", "pid": 41, "started_at": 1.0}
        runs = [mine, elsewhere, broken, theirs, host]
        left = await ws._reap_runs(runs, 15)
        assert left == [elsewhere, broken, theirs, host]
        assert box.reaped == [("t1", 15), ("t3", 15), ("broken", 15)]
    finally:
        await ws.close()


# A workspace stops what a lapsed instance left as it starts, before
# anything lists processes.
@pytest.mark.asyncio
async def test_a_workspace_reaps_a_lapsed_instance_as_it_starts():
    box = _ReapedBox(("t1",))
    ws = Workspace({}, runtimes=[box])
    try:
        store = RAMJobStore(lease_seconds=30.0)
        ws.job_table.store = store
        run = {"runtime": "reapbox", "tag": "t1", "command": "x"}
        await store.publish(
            "dead", {"2": {"pid": 2, "session": "s", "runs": [run]}}
        )
        await ws.shell("true")
        async with asyncio.timeout(5):
            while "dead" in await store.processes():
                await asyncio.sleep(0.01)
        assert box.reaped == [("t1", 15)]
    finally:
        await ws.close()
