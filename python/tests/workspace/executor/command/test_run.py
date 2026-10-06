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
import importlib
import inspect

import pytest

from mirage.cache import context as cache_context
from mirage.commands.builtin.generic_bind.builders import BUILDERS
from mirage.observe.record import OpRecord
from mirage.policy.builtin import output_cap
from mirage.types import Limit, MountMode, PathSpec
from mirage.vfs.disk import DiskVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.command.run import drop_mount_caches
from tests.fixtures.apply_marks import caching_ram_workspace, capture_marks


@pytest.mark.parametrize("cmd", ["ls", "stat", "find", "du", "file"])
def test_the_symlink_aware_commands_read_the_links_field(cmd):
    """`CommandOpts.ns` reaches every handler; the family generic is
    where the read lives (tests/commands/test_links_optin.py pins the
    full delegation rule), and the builder passes `opts` through."""
    module = importlib.import_module(f"mirage.commands.builtin.generic.{cmd}")
    assert "opts.ns.links" in inspect.getsource(module)


def test_stat_overlay_is_read_where_stats_render():
    """The overlay used to carry its own list of command names; now the
    builders that render stats read it off `opts`."""
    named = set()
    for builder in BUILDERS:
        module = inspect.getmodule(inspect.unwrap(builder.fn))
        if module is None:
            continue
        if "opts.ns.stat_overlay" in inspect.getsource(module):
            named.add(builder.name)
    assert named == {"ls", "stat", "cp", "mv", "find"}


async def _cli_write_case(tmp_path) -> tuple[str, str, str]:
    """A CLI write mutates the service out of band, exactly as gws does
    by file id, then every mount drops its caches."""
    (tmp_path / "one").mkdir()
    (tmp_path / "two").mkdir()
    (tmp_path / "one" / "a.txt").write_bytes(b"v1\n")
    (tmp_path / "two" / "b.txt").write_bytes(b"v1\n")
    one = DiskVFS(root=str(tmp_path / "one"))
    two = DiskVFS(root=str(tmp_path / "two"))
    one.caches_reads = True
    two.caches_reads = True
    ws = Workspace({"/one/": one, "/two/": two}, mode=MountMode.WRITE)
    await (await ws.shell("cat /one/a.txt")).stdout_str()
    await (await ws.shell("cat /two/b.txt")).stdout_str()
    (tmp_path / "one" / "a.txt").write_bytes(b"v2\n")
    (tmp_path / "one" / "new.txt").write_bytes(b"fresh\n")
    (tmp_path / "two" / "b.txt").write_bytes(b"v2\n")
    await drop_mount_caches(ws._registry)
    body = await (await ws.shell("cat /one/a.txt")).stdout_str()
    listing = await (await ws.shell("ls /one")).stdout_str()
    other = await (await ws.shell("cat /two/b.txt")).stdout_str()
    return body, listing, other


@pytest.mark.asyncio
async def test_a_cli_write_drops_bodies_as_well_as_listings(tmp_path):
    """A stale listing hides a create; a stale body hides an edit. The
    cached body is the one that answers without reaching the service, so
    clearing the index alone leaves `cat` serving pre-write content."""
    body, listing, _other = await _cli_write_case(tmp_path)
    assert body == "v2\n"
    assert "new.txt" in listing


@pytest.mark.asyncio
async def test_a_cli_write_drops_every_mount(tmp_path):
    # Which mounts the CLI's service backs is not the CLI's business, so
    # the executor says the one thing it knows: a write happened.
    _body, _listing, other = await _cli_write_case(tmp_path)
    assert other == "v2\n"


@pytest.fixture
def restore_command_limits():
    snapshot = dict(output_cap.DEFAULT_COMMAND_LIMITS)
    yield
    output_cap.DEFAULT_COMMAND_LIMITS.clear()
    output_cap.DEFAULT_COMMAND_LIMITS.update(snapshot)


def _writes_of(ws: Workspace, path: str) -> list[OpRecord]:
    return [r for r in ws.vfs.records if r.op == "write" and r.path == path]


@pytest.mark.asyncio
async def test_a_claimed_write_is_marked_with_the_claimed_value():
    ws = caching_ram_workspace()
    captured = capture_marks(ws)
    try:
        result = await ws.shell("echo a | tee /r/f")
        assert result.exit_code == 0
    finally:
        await ws.close()
    [(marks, writes)] = captured
    claimed = [c for op, path, c in marks if (op, path) == ("write", "/r/f")]
    assert len(claimed) == 1
    assert claimed[0] is writes["/r/f"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line", "exit_code"),
    [("echo a | tee /r/f", 0), ("echo a | tee /r/f; sleep 2", 124)],
    ids=["finished", "timed-out"],
)
async def test_no_record_keeps_its_mark_after_the_line(
    restore_command_limits, line, exit_code
):
    output_cap.DEFAULT_COMMAND_LIMITS["sleep"] = Limit(timeout_seconds=0.1)
    ws = caching_ram_workspace()
    try:
        result = await ws.shell(line)
        assert result.exit_code == exit_code
        assert _writes_of(ws, "/r/f")
        assert all(r.claimed is None for r in ws.vfs.records)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_failed_session_save_still_clears_and_seals_the_marks():
    ws = caching_ram_workspace()
    applied: list[list[OpRecord]] = []
    orig_apply = ws._dispatcher.apply_io

    async def keep_records(result, records=None, cache_facts=None):
        applied.append(records)
        await orig_apply(result, records=records, cache_facts=cache_facts)

    async def failing_flush(session_id: str) -> None:
        raise OSError("session store down")

    ws._dispatcher.apply_io = keep_records
    ws._session_mgr.flush = failing_flush
    try:
        with pytest.raises(OSError, match="session store down"):
            await ws.shell("echo a | tee /r/f")
    finally:
        await ws.close()
    [records] = applied
    assert [r for r in records if r.op == "write"]
    assert all(r.claimed is None and r.sealed for r in records)


@pytest.mark.asyncio
async def test_a_background_write_marked_during_the_session_save_is_cleared():
    ws = caching_ram_workspace()
    applied: list[list[OpRecord]] = []
    orig_apply = ws._dispatcher.apply_io
    orig_flush = ws._session_mgr.flush

    async def keep_records(result, records=None, cache_facts=None):
        applied.append(records)
        await orig_apply(result, records=records, cache_facts=cache_facts)

    async def flush_after_the_mark(session_id: str) -> None:
        if len(applied) == 1:
            for _ in range(500):
                if any(r.claimed is not None for r in applied[0]):
                    break
                await asyncio.sleep(0.01)
        await orig_flush(session_id)

    ws._dispatcher.apply_io = keep_records
    ws._session_mgr.flush = flush_after_the_mark
    try:
        assert (await ws.shell("echo a | tee /r/f &")).exit_code == 0
        assert (await ws.shell("wait")).exit_code == 0
        assert _writes_of(ws, "/r/f")
        assert all(r.claimed is None and r.sealed for r in ws.vfs.records)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_background_claimer_ending_after_the_line_marks_nothing(
    monkeypatch,
):
    # The background tee's write records while the line still runs (RAM
    # stores the bytes and records before it invalidates, with no await
    # between, so the loop sees the record once it sees the bytes), and the
    # line persists that record; the tee itself returns only after the gate
    # opens, past the line's end, when its scope is sealed.
    real = cache_context.invalidate_after_write
    gate = asyncio.Event()
    returned = asyncio.Event()

    async def gated_invalidate(path: PathSpec) -> None:
        await gate.wait()
        await real(path)
        returned.set()

    monkeypatch.setattr(
        "mirage.core.ram.write.invalidate_after_write", gated_invalidate
    )
    ws = caching_ram_workspace()
    try:
        result = await asyncio.wait_for(
            ws.shell(
                "echo a | tee /r/f & until [ -s /r/f ]; do sleep 0.01; done"
            ),
            timeout=5,
        )
        assert result.exit_code == 0
        assert _writes_of(ws, "/r/f")
        gate.set()
        assert (await ws.shell("wait")).exit_code == 0
        assert returned.is_set()
        assert all(r.claimed is None for r in ws.vfs.records)
    finally:
        gate.set()
        await ws.close()
