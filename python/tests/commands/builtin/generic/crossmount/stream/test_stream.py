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

from mirage.commands.builtin.generic.crossmount.stream import run_stream
from mirage.io import IOResult
from mirage.io.stream import close_quietly, materialize
from mirage.types import PathSpec


class _HeldSource:
    """Yields its bytes once, then waits until it is closed, once."""

    def __init__(self, data, on_close):
        self._data = data
        self._on_close = on_close

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._data:
            data, self._data = self._data, b""
            return data
        await asyncio.Event().wait()

    async def aclose(self):
        if self._on_close is not None:
            self._on_close()
            self._on_close = None


def _scope(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual[: virtual.rfind("/") + 1],
        vfs_path="",
        resolved=True,
    )


class FakeRunSingle:
    """Records run_single calls; serves per-path bytes for cat pushdowns."""

    def __init__(self, files: dict[str, bytes]):
        self.files = files
        self.calls: list[dict] = []
        self.final_stdin: bytes | None = None

    async def __call__(
        self,
        cmd_name,
        paths,
        texts,
        flag_kwargs,
        stdin=None,
        resolve_hint=None,
    ):
        self.calls.append(
            dict(
                cmd=cmd_name,
                paths=[p.virtual for p in paths],
                texts=list(texts),
                flags=dict(flag_kwargs),
                resolve_hint=resolve_hint.virtual
                if resolve_hint is not None
                else None,
            )
        )
        if cmd_name == "cat" and paths:
            data = self.files.get(paths[0].virtual)
            if data is None:
                err = f"cat: {paths[0].virtual}: No such file\n".encode()
                return None, IOResult(exit_code=1, stderr=err)
            return data, IOResult()
        self.final_stdin = (
            await materialize(stdin) if stdin is not None else None
        )
        return b"FINAL:" + (self.final_stdin or b""), IOResult()


def _run(coro):
    return asyncio.run(coro)


def test_plain_cat_skips_the_final_run():
    rs = FakeRunSingle({"/a/x": b"1\n", "/b/y": b"2\n"})
    out, io = _run(
        run_stream("cat", [_scope("/a/x"), _scope("/b/y")], [], {}, rs)
    )
    assert _run(materialize(out)) == b"1\n2\n"
    assert io.exit_code == 0
    assert [c["cmd"] for c in rs.calls] == ["cat", "cat"]


def test_flagged_command_runs_once_on_the_merged_stream():
    rs = FakeRunSingle({"/a/x": b"1", "/b/y": b"2\n"})
    out, io = _run(
        run_stream(
            "cut", [_scope("/a/x"), _scope("/b/y")], [], {"r": True}, rs
        )
    )
    assert _run(materialize(out)) == b"FINAL:1\n2\n"
    assert io.exit_code == 0
    final = rs.calls[-1]
    assert final["cmd"] == "cut"
    assert final["paths"] == []
    assert final["flags"] == {"r": True}
    assert final["resolve_hint"] == "/a/x"
    assert rs.final_stdin == b"1\n2\n"


def test_cat_with_flags_reapplies_cat_on_the_merged_stream():
    rs = FakeRunSingle({"/a/x": b"1", "/b/y": b"2\n"})
    out, _ = _run(
        run_stream(
            "cat", [_scope("/a/x"), _scope("/b/y")], [], {"n": True}, rs
        )
    )
    assert _run(materialize(out)) == b"FINAL:12\n"
    assert rs.calls[-1]["cmd"] == "cat"
    assert rs.calls[-1]["flags"] == {"n": True}


@pytest.mark.asyncio
async def test_owned_failed_fetch_is_drained_before_merging_stderr():
    async def run_single(cmd, paths, texts, flags, **kwargs):
        if paths[0].virtual == "/b/missing":
            return b"discarded", IOResult(
                stderr=b"cat: /b/missing: No such file or directory\n",
                exit_code=1,
            )
        return b"kept\n", IOResult()

    out, io = await run_stream(
        "cat", [_scope("/a/file"), _scope("/b/missing")], [], {}, run_single
    )
    assert await materialize(out) == b"kept\n"
    assert (
        await io.materialize_stderr()
        == b"cat: /b/missing: No such file or directory\n"
    )
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_late_fetch_diagnostics_and_claims_merge_in_operand_order():
    async def run_single(cmd, paths, texts, flags, **kwargs):
        path = paths[0].virtual
        result = IOResult()

        async def source():
            yield path.encode() + b"\n"
            result.stderr = f"cat: {path}: late diagnostic\n".encode()
            result.reads[path] = b"saved"
            result.cache.append(path)
            result.exit_code = 1

        return source(), result

    out, io = await run_stream(
        "cat", [_scope("/a/x"), _scope("/b/y")], [], {}, run_single
    )
    assert await materialize(out) == b"/a/x\n/b/y\n"
    assert (
        await io.materialize_stderr()
        == b"cat: /a/x: late diagnostic\ncat: /b/y: late diagnostic\n"
    )
    assert io.exit_code == 1
    assert io.reads == {"/a/x": b"saved", "/b/y": b"saved"}
    assert io.cache == ["/a/x", "/b/y"]


@pytest.mark.asyncio
async def test_late_final_command_diagnostic_and_status_survive():
    async def run_single(cmd, paths, texts, flags, stdin=None, **kwargs):
        result = IOResult()

        async def source():
            yield await materialize(stdin)
            result.stderr = b"cut: late diagnostic\n"
            result.exit_code = 7

        return (b"kept\n", result) if paths else (source(), result)

    out, io = await run_stream("cut", [_scope("/a/x")], [], {}, run_single)
    assert await materialize(out) == b"kept\n"
    assert await io.materialize_stderr() == b"cut: late diagnostic\n"
    assert io.exit_code == 7


@pytest.mark.asyncio
async def test_close_before_first_pull_closes_every_owned_fetch():
    closed = []

    async def run_single(cmd, paths, texts, flags, **kwargs):
        path = paths[0].virtual
        return _HeldSource(b"ready", lambda: closed.append(path)), IOResult()

    out, _ = await run_stream(
        "cat", [_scope("/a/x"), _scope("/b/y")], [], {}, run_single
    )
    await asyncio.wait_for(close_quietly(out), 1)
    assert closed == ["/a/x", "/b/y"]


@pytest.mark.asyncio
async def test_failed_sort_closes_unread_fetch_and_respells_diagnostic():
    closed = asyncio.Event()

    async def run_single(cmd, paths, texts, flags, **kwargs):
        if paths[0].virtual == "/b/missing":
            return None, IOResult(
                stderr=b"cat: /b/missing: No such file or directory\n",
                exit_code=1,
            )
        return _HeldSource(b"unread", closed.set), IOResult()

    out, io = await asyncio.wait_for(
        run_stream(
            "sort", [_scope("/a/x"), _scope("/b/missing")], [], {}, run_single
        ),
        1,
    )
    assert out is None
    assert closed.is_set()
    assert io.exit_code == 2
    assert (
        await io.materialize_stderr()
        == b"sort: /b/missing: No such file or directory\n"
    )


@pytest.mark.asyncio
async def test_close_while_next_fetch_pull_is_pending():
    closed = []

    async def run_single(cmd, paths, texts, flags, **kwargs):
        path = paths[0].virtual
        return _HeldSource(
            path.encode(), lambda: closed.append(path)
        ), IOResult()

    out, _ = await run_stream(
        "cat", [_scope("/a/x"), _scope("/b/y")], [], {}, run_single
    )
    assert await anext(out) == b"/a/x"
    pending = asyncio.create_task(anext(out))
    await asyncio.sleep(0)
    await asyncio.wait_for(close_quietly(out), 1)
    await asyncio.gather(pending, return_exceptions=True)
    assert sorted(closed) == ["/a/x", "/b/y"]
