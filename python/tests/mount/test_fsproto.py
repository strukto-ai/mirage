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

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.mount.changes import SERVED_BY, RecentChanges
from mirage.mount.constants import FSPROTO_VERSION
from mirage.mount.fsproto import (
    Frame,
    FrameReader,
    FsprotoServer,
    encode_frame,
)
from mirage.mount.types import ServedPrefix
from mirage.utils.clock import ManualClock


class Client:
    """A mirage-fuse end: requests go in, replies come back by id,
    pushes queue apart."""

    def __init__(self) -> None:
        self.reader = asyncio.StreamReader()
        self.replies: dict[int, Frame] = {}
        self.pushes: list[Frame] = []
        self._got = asyncio.StreamReader()
        self._frames = FrameReader()
        self._next = 0
        self._changed = asyncio.Event()
        self._task = asyncio.create_task(self._read())

    def write(self, data: bytes) -> None:
        self._got.feed_data(data)

    def close(self) -> None:
        self._got.feed_eof()

    async def _read(self) -> None:
        while (frame := await self._frames.next(self._got)) is not None:
            if "id" in frame.head:
                self.replies[frame.head["id"]] = frame
            else:
                self.pushes.append(frame)
            self._changed.set()

    async def until(self, test) -> None:
        while not test():
            self._changed.clear()
            await self._changed.wait()

    def send(self, head: dict, body: bytes = b"") -> None:
        self.reader.feed_data(encode_frame(head, body))

    async def call(self, head: dict, body: bytes = b"") -> Frame:
        self._next += 1
        rid = self._next
        self.send({**head, "id": rid}, body)
        await self.until(lambda: rid in self.replies)
        return self.replies.pop(rid)

    async def end(self, serving) -> None:
        self.reader.feed_eof()
        await serving
        self._task.cancel()


async def served(changes: RecentChanges | None = None):
    ws = Workspace({"/notes": RAMVFS()}, mode=MountMode.WRITE)
    await ws.vfs.write("/notes/plan.txt", b"plan")
    await ws.session("agent")
    server = FsprotoServer(
        ws.vfs,
        ws.get_session("agent"),
        None,
        ServedPrefix("/notes", "dev", changes),
    )
    end = Client()
    serving = asyncio.create_task(server.serve(end.reader, end))
    return ws, server, end, serving


# The bytes mirage-fuse's and TypeScript's tests check too.
def test_a_frame_has_the_shared_layout():
    assert encode_frame({"id": 1}, b"xy") == (
        b"\x00\x00\x00\x0e\x00\x00\x00\x08" + b'{"id":1}xy'
    )


@pytest.mark.asyncio
async def test_frames_read_back_across_chunks():
    stream = asyncio.StreamReader()
    data = encode_frame({"id": 1, "op": "getattr"}) + encode_frame(
        {"id": 2}, b"body"
    )
    stream.feed_data(data[:7])
    stream.feed_data(data[7:])
    stream.feed_eof()
    reader = FrameReader()
    first, second = await reader.next(stream), await reader.next(stream)
    assert (first.head["id"], second.body) == (1, b"body")
    assert await reader.next(stream) is None


@pytest.mark.asyncio
async def test_a_header_past_its_frame_is_refused():
    stream = asyncio.StreamReader()
    stream.feed_data(b"\x00\x00\x00\x06\x00\x00\x00\x09{}")
    with pytest.raises(ValueError, match="a header past its frame"):
        await FrameReader().next(stream)


@pytest.mark.asyncio
async def test_a_ram_mount_s_answers_are_kept():
    ws, server, end, serving = await served()
    hello = await end.call({"op": "hello", "proto": FSPROTO_VERSION})
    assert hello.head["proto"] == FSPROTO_VERSION
    stat = await end.call({"op": "getattr", "path": "/notes/plan.txt"})
    assert (stat.head["k"], stat.head["a"]["s"]) == (True, 4)
    listed = await end.call({"op": "list", "path": "/notes"})
    assert [name for name, _ in listed.head["e"]] == ["plan.txt"]
    await end.end(serving)


@pytest.mark.asyncio
async def test_a_deep_listing_carries_the_folders_under_it():
    ws, server, end, serving = await served()
    await ws.vfs.mkdir("/notes/sub")
    await ws.vfs.mkdir("/notes/sub/deeper")
    await ws.vfs.write("/notes/sub/a.txt", b"a")
    await ws.vfs.write("/notes/sub/deeper/b.txt", b"b")
    deep = await end.call({"op": "list", "path": "/notes", "deep": True})
    assert [name for name, _ in deep.head["e"]] == ["plan.txt", "sub"]
    assert [
        (folder, [name for name, _ in rows]) for folder, rows in deep.head["d"]
    ] == [
        ("/notes/sub", ["a.txt", "deeper"]),
        ("/notes/sub/deeper", ["b.txt"]),
    ]
    alone = await end.call({"op": "list", "path": "/notes"})
    assert "d" not in alone.head
    await end.end(serving)


@pytest.mark.asyncio
async def test_a_file_reads_whole_and_a_write_lands_by_its_release():
    ws, server, end, serving = await served()
    whole = await end.call({"op": "readall", "path": "/notes/plan.txt"})
    assert whole.body == b"plan"
    opened = await end.call(
        {
            "op": "open",
            "path": "/notes/plan.txt",
            "write": True,
            "truncate": True,
        }
    )
    fh = opened.head["fh"]
    await end.call({"op": "write", "fh": fh, "offset": 0}, b"done")
    await end.call({"op": "release", "fh": fh})
    assert await server.sync() == []
    assert await ws.vfs.read("/notes/plan.txt") == b"done"
    await end.end(serving)


@pytest.mark.asyncio
async def test_a_rename_with_noreplace_refuses_an_existing_target():
    ws, server, end, serving = await served()
    made = await end.call(
        {"op": "create", "path": "/notes/new.txt", "mode": 0o644}
    )
    await end.call({"op": "release", "fh": made.head["fh"]})
    refused = await end.call(
        {
            "op": "rename",
            "from": "/notes/new.txt",
            "to": "/notes/plan.txt",
            "noreplace": True,
        }
    )
    assert refused.head["errno"] == "EEXIST"
    await end.call(
        {"op": "rename", "from": "/notes/new.txt", "to": "/notes/plan.txt"}
    )
    assert await ws.vfs.read("/notes/plan.txt") == b""
    await end.end(serving)


@pytest.mark.asyncio
async def test_a_link_points_where_it_was_made_to():
    ws, server, end, serving = await served()
    made = await end.call(
        {"op": "symlink", "path": "/notes/link", "target": "plan.txt"}
    )
    assert made.head["a"]["m"] & 0o170000 == 0o120000
    read = await end.call({"op": "readlink", "path": "/notes/link"})
    assert read.head["target"] == "plan.txt"
    whole = await end.call({"op": "readall", "path": "/notes/link"})
    assert whole.body == b"plan"
    await end.end(serving)


@pytest.mark.asyncio
async def test_a_failure_is_named_by_its_errno():
    ws, server, end, serving = await served()
    missing = await end.call({"op": "getattr", "path": "/notes/missing"})
    assert missing.head["errno"] == "ENOENT"
    await end.end(serving)


@pytest.mark.asyncio
async def test_setattr_truncates_and_answers_the_new_size():
    ws, server, end, serving = await served()
    done = await end.call(
        {"op": "setattr", "path": "/notes/plan.txt", "size": 2}
    )
    assert done.head["a"]["s"] == 2
    await end.end(serving)


@pytest.mark.asyncio
async def test_a_folder_of_small_files_prefetches_in_one_reply():
    ws, server, end, serving = await served()
    await ws.vfs.write("/notes/b.txt", b"bee")
    fetched = await end.call({"op": "fetchdir", "path": "/notes"})
    assert [(name, a["s"]) for name, a in fetched.head["f"]] == [
        ("b.txt", 3),
        ("plan.txt", 4),
    ]
    assert fetched.body == b"beeplan"
    await end.end(serving)


@pytest.mark.asyncio
async def test_another_s_change_is_pushed_and_a_barrier_waits_for_the_client():
    changes = RecentChanges(ManualClock(0), 1)
    ws, server, end, serving = await served(changes)
    await end.call({"op": "hello", "proto": FSPROTO_VERSION})
    token = SERVED_BY.set("dev")
    try:
        changes.note("/notes/own.txt")
    finally:
        SERVED_BY.reset(token)
    changes.note("/notes/plan.txt")
    changes.note("/elsewhere/x")
    barrier = asyncio.create_task(server.begin())
    await end.until(
        lambda: any(f.head.get("op") == "begin" for f in end.pushes)
    )
    assert end.pushes[0].head == {
        "push": "inval",
        "paths": ["/notes/plan.txt"],
    }
    assert not barrier.done()
    begin = next(f for f in end.pushes if f.head.get("op") == "begin")
    end.send({"hid": begin.head["hid"]})
    await barrier
    await end.end(serving)
