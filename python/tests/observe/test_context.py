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
from collections.abc import AsyncIterator
from typing import Any

import pytest

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.observe import context as observe_context
from mirage.observe.context import (
    RecordingScope,
    active_recorder,
    push_mount_context,
    push_revisions,
    record,
    record_stream,
    reset_active_recorder,
    reset_revisions,
    revision_for,
    start_op,
    with_mount_context,
    with_revisions,
)
from mirage.types import PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


class ClosingIterator:
    def __init__(self) -> None:
        self.yielded = False
        self.closed = False

    def __aiter__(self) -> "ClosingIterator":
        return self

    async def __anext__(self) -> bytes:
        if self.yielded:
            raise StopAsyncIteration
        self.yielded = True
        return b"chunk"

    async def aclose(self) -> None:
        self.closed = True


def test_record_no_context():
    record("read", "/a.txt", "s3", 100, start_op())


def test_recording_scope_collects_records():
    scope = RecordingScope()
    records = scope.records
    record("read", "/a.txt", "s3", 100, start_op())
    scope.close()
    assert len(records) == 1
    assert records[0].op == "read"
    assert records[0].bytes == 100


def test_record_after_stop_is_noop():
    scope = RecordingScope()
    records = scope.records
    record("read", "/a.txt", "s3", 100, start_op())
    scope.close()
    record("read", "/b.txt", "s3", 200, start_op())
    assert len(records) == 1


def test_multiple_records():
    scope = RecordingScope()
    records = scope.records
    record("read", "/a.txt", "s3", 100, start_op())
    record("write", "/b.txt", "ram", 50, start_op())
    scope.close()
    assert len(records) == 2
    assert records[0].source == "s3"
    assert records[1].source == "ram"


def test_record_without_prefix():
    scope = RecordingScope()
    records = scope.records
    record("read", "/data/file.json", "s3", 100, start_op())
    scope.close()
    assert records[0].path == "/data/file.json"


def test_push_mount_context_carries_mount_id():
    scope = RecordingScope()
    token = push_mount_context("mount-a")
    try:
        record("read", "/s3/a", "s3", 1, start_op())
        record_stream("read", "/s3/b", "s3")
    finally:
        reset_active_recorder(token)
    record("read", "/s3/c", "s3", 1, start_op())
    scope.close()
    assert [(r.path, r.mount_id) for r in scope.records] == [
        ("/s3/a", "mount-a"),
        ("/s3/b", "mount-a"),
        ("/s3/c", None),
    ]


def test_push_mount_context_no_recorder_is_noop():
    token = push_mount_context("mount-a")
    try:
        assert active_recorder() is None
        record("read", "/s3/a", "s3", 1, start_op())
        assert record_stream("read", "/s3/a", "s3") is None
    finally:
        reset_active_recorder(token)


async def _record_under_mount(
    mount_id: str, path: str, opened: set[str], other: str
) -> None:
    token = push_mount_context(mount_id)
    try:
        opened.add(mount_id)
        while other not in opened:
            await asyncio.sleep(0)
        record("read", path, "s3", 1, start_op())
    finally:
        reset_active_recorder(token)


@pytest.mark.asyncio
async def test_push_mount_context_is_task_local_across_concurrent_branches():
    # Each branch records only after the other has pushed its own frame.
    scope = RecordingScope()
    opened: set[str] = set()
    try:
        await asyncio.gather(
            asyncio.create_task(
                _record_under_mount("A", "/a/x.txt", opened, "B")
            ),
            asyncio.create_task(
                _record_under_mount("B", "/b/y.txt", opened, "A")
            ),
        )
    finally:
        scope.close()
    assert sorted((r.path, r.mount_id) for r in scope.records) == [
        ("/a/x.txt", "A"),
        ("/b/y.txt", "B"),
    ]


class RecordingIterator:
    def __init__(self, paths: list[str]) -> None:
        self.paths = list(paths)

    def __aiter__(self) -> "RecordingIterator":
        return self

    async def __anext__(self) -> bytes:
        if not self.paths:
            raise StopAsyncIteration
        record_stream("read", self.paths.pop(0), "s3")
        return b"chunk"


@pytest.mark.asyncio
async def test_with_mount_context_keeps_mount_id_across_steps():
    # The consumer runs under a foreign mount's frame; every lazy record the
    # wrapped stream emits must still carry the captured mount's identity.
    scope = RecordingScope()
    wrapped = with_mount_context(
        RecordingIterator(["/s3/a", "/s3/b"]), "mount-a"
    )
    outer = push_mount_context("mount-b")
    try:
        chunks = [chunk async for chunk in wrapped]
        record("read", "/r/x", "ram", 1, start_op())
    finally:
        reset_active_recorder(outer)
    scope.close()
    assert chunks == [b"chunk", b"chunk"]
    assert [(r.path, r.mount_id) for r in scope.records] == [
        ("/s3/a", "mount-a"),
        ("/s3/b", "mount-a"),
        ("/r/x", "mount-b"),
    ]


@pytest.mark.asyncio
async def test_with_mount_context_without_id_inherits_the_frame():
    scope = RecordingScope()
    wrapped = with_mount_context(RecordingIterator(["/s3/a"]), None)
    outer = push_mount_context("mount-b")
    try:
        _ = [chunk async for chunk in wrapped]
    finally:
        reset_active_recorder(outer)
    scope.close()
    assert [r.mount_id for r in scope.records] == ["mount-b"]


@pytest.mark.asyncio
async def test_with_mount_context_close_propagates_to_source():
    source = ClosingIterator()
    wrapped = with_mount_context(source, "mount-a")
    assert await anext(wrapped) == b"chunk"
    await wrapped.aclose()
    assert source.closed


@pytest.mark.asyncio
async def test_with_revisions_close_propagates_to_source():
    source = ClosingIterator()
    wrapped = with_revisions({"/s3/a": "v1"}, source)
    assert await anext(wrapped) == b"chunk"
    await wrapped.aclose()
    assert source.closed


def test_record_carries_fingerprint_when_passed():
    scope = RecordingScope()
    records = scope.records
    record("read", "/s3/x", "s3", 10, start_op(), fingerprint="abc")
    scope.close()
    assert records[0].fingerprint == "abc"
    assert records[0].revision is None


def test_record_carries_revision_when_passed():
    scope = RecordingScope()
    records = scope.records
    record("read", "/s3/x", "s3", 10, start_op(), revision="v1")
    scope.close()
    assert records[0].revision == "v1"
    assert records[0].fingerprint is None


def test_record_carries_both_when_passed():
    scope = RecordingScope()
    records = scope.records
    record(
        "read", "/s3/x", "s3", 10, start_op(), fingerprint="abc", revision="v1"
    )
    scope.close()
    assert records[0].fingerprint == "abc"
    assert records[0].revision == "v1"


def test_record_fingerprint_default_is_none():
    scope = RecordingScope()
    records = scope.records
    record("read", "/s3/x", "s3", 10, start_op())
    scope.close()
    assert records[0].fingerprint is None
    assert records[0].revision is None


def test_record_stream_carries_fingerprint_when_passed():
    scope = RecordingScope()
    records = scope.records
    rec = record_stream("read", "/s3/x", "s3", fingerprint="abc")
    scope.close()
    assert rec is not None
    assert records[0].fingerprint == "abc"


def test_record_stream_carries_revision_when_passed():
    scope = RecordingScope()
    records = scope.records
    rec = record_stream("read", "/s3/x", "s3", revision="v1")
    scope.close()
    assert rec is not None
    assert records[0].revision == "v1"


def test_record_stream_assignable_after_open():
    scope = RecordingScope()
    records = scope.records
    rec = record_stream("read", "/s3/x", "s3")
    assert rec.fingerprint is None
    assert rec.revision is None
    rec.fingerprint = "abc"
    rec.revision = "v2"
    scope.close()
    assert records[0].fingerprint == "abc"
    assert records[0].revision == "v2"


def test_revision_for_no_context():
    assert revision_for("/s3/a") is None


def test_revision_for_with_context():
    token = push_revisions({"/s3/a": "v1", "/s3/b": "v2"})
    try:
        assert revision_for("/s3/a") == "v1"
        assert revision_for("/s3/b") == "v2"
        assert revision_for("/s3/c") is None
    finally:
        reset_revisions(token)
    assert revision_for("/s3/a") is None


def test_revision_for_with_none_context():
    token = push_revisions(None)
    try:
        assert revision_for("/s3/a") is None
    finally:
        reset_revisions(token)


def test_nested_scope_close_restores_outer():
    outer = RecordingScope()
    record("read", "/a", "s3", 1, start_op())
    inner = RecordingScope()
    record("read", "/b", "s3", 1, start_op())
    inner.close()
    record("read", "/c", "s3", 1, start_op())
    outer.close()
    assert [r.path for r in outer.records] == ["/a", "/c"]
    assert [r.path for r in inner.records] == ["/b"]


def test_inactive_scope_joins_enclosing():
    outer = RecordingScope()
    joined = RecordingScope(active=False)
    record("read", "/a", "s3", 1, start_op())
    joined.close()
    outer.close()
    assert [r.path for r in outer.records] == ["/a"]
    assert joined.records == []


async def _dispatch_recording_read(
    recorded: list[str], stream: bool
) -> list[str]:
    # A RAM mount at /m whose read records exactly the paths it is given,
    # inside a real mount frame, so the recorder's own treatment of the
    # path is what the ledger shows.
    async def recording_read() -> AsyncIterator[bytes]:
        for path in recorded:
            if stream:
                record_stream("read", path, "ram")
            else:
                record("read", path, "ram", 0, start_op())
        yield b""

    class RecordingRAMVFS(RAMVFS):
        async def read(
            self,
            path: PathSpec,
            index: IndexCacheStore = NULL_INDEX,
            offset: int = 0,
            size: int | None = None,
        ) -> Any:
            return recording_read()

    ws = Workspace({"/m": RecordingRAMVFS()})
    scope = RecordingScope()
    try:
        out, _ = await ws.dispatch("read", PathSpec.from_str_path("/m/k.txt"))
        async for _chunk in out:
            pass
    finally:
        scope.close()
        await ws.close()
    return [r.path for r in scope.records]


@pytest.mark.asyncio
async def test_record_stores_the_path_as_given_inside_a_mount_frame():
    # "/x/y" names no mount, so it must not gain the frame's /m.
    paths = await _dispatch_recording_read(["/x/y", "/m/k.txt"], stream=False)
    assert paths == ["/x/y", "/m/k.txt"]


@pytest.mark.asyncio
async def test_record_stream_stores_the_path_as_given_inside_a_mount_frame():
    # The record_stream twin: same rule, separate code path.
    paths = await _dispatch_recording_read(["/x/y", "/m/k.txt"], stream=True)
    assert paths == ["/x/y", "/m/k.txt"]


def test_command_records_collects_only_its_own_commands_records():
    scope = RecordingScope()
    try:
        with observe_context.command_records() as outer:
            record("write", "/a", "ram", 1, start_op())
            with observe_context.command_records() as inner:
                record("write", "/b", "ram", 1, start_op())
                record_stream("write", "/c", "ram")
            record("write", "/post", "ram", 1, start_op())
    finally:
        scope.close()
    assert [r.path for r in inner] == ["/b", "/c"]
    assert [r.path for r in outer] == ["/a", "/post"]
    assert [r.path for r in scope.records] == ["/a", "/b", "/c", "/post"]
    # The marks land on the line's own records, so the lists share them.
    sink = {id(r) for r in scope.records}
    assert all(id(r) in sink for r in [*inner, *outer])


def test_command_records_stays_empty_outside_a_recording_scope():
    with observe_context.command_records() as mine:
        record("write", "/a", "ram", 1, start_op())
        assert record_stream("write", "/b", "ram") is None
    assert mine == []


async def _record_in_own_command(
    path: str, opened: set[str], recorded: set[str], me: str, other: str
) -> list[str]:
    with observe_context.command_records() as mine:
        opened.add(me)
        while other not in opened:
            await asyncio.sleep(0)
        record("write", path, "ram", 1, start_op())
        recorded.add(me)
        # Both lists stay open until both have recorded, so a shared
        # variable that restores the previous list on exit still holds
        # the other command's list when this one records.
        while other not in recorded:
            await asyncio.sleep(0)
    return [r.path for r in mine]


@pytest.mark.asyncio
async def test_command_records_is_task_local_across_concurrent_commands():
    # Each command records only after the other has opened its own list.
    scope = RecordingScope()
    opened: set[str] = set()
    recorded: set[str] = set()
    try:
        first, second = await asyncio.gather(
            asyncio.create_task(
                _record_in_own_command("/a/x.txt", opened, recorded, "A", "B")
            ),
            asyncio.create_task(
                _record_in_own_command("/b/y.txt", opened, recorded, "B", "A")
            ),
        )
    finally:
        scope.close()
    assert (first, second) == (["/a/x.txt"], ["/b/y.txt"])
