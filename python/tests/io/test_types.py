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

from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.types import IOResult, OpReport


async def _async_source(*chunks):
    for chunk in chunks:
        yield chunk


def test_ioresult_reads_accepts_bytes():
    io = IOResult(reads={"/a": b"hello"})
    assert io.reads["/a"] == b"hello"


def test_ioresult_reads_accepts_async_iterator():
    ait = _async_source(b"chunk")
    io = IOResult(reads={"/a": ait})
    assert io.reads["/a"] is ait


def test_ioresult_cache_default_empty():
    io = IOResult()
    assert io.cache == []


def test_op_report_defaults_say_nothing_ran():
    # A refusal at a pre gate or a backend failure leaves the report
    # untouched, and an observer records nothing off it.
    report = OpReport()
    assert report.completed is False
    assert report.source is None
    assert report.bytes is None
    assert report.capped is False


def test_op_report_served_stamps_the_completion():
    report = OpReport()
    report.served("ram", 10)
    assert report.completed is True
    assert report.source == "ram"
    assert report.bytes == 10
    # An output cap is a separate fact, stamped by the door only when
    # one shortened the delivered bytes.
    assert report.capped is False


def test_op_report_served_defaults_to_the_owning_mount():
    # None source means the owning mount answered; None bytes means the
    # result is the measure.
    report = OpReport()
    report.served()
    assert report.completed is True
    assert report.source is None
    assert report.bytes is None


def test_ioresult_cache_set():
    io = IOResult(
        reads={"/a": _async_source(b"x")},
        cache=["/a"],
    )
    assert io.cache == ["/a"]


def test_ioresult_merge_combines_cache():

    async def _run():
        left = IOResult(cache=["/a"])
        right = IOResult(cache=["/b"])
        merged = await left.merge(right)
        assert merged.cache == ["/a", "/b"]

    asyncio.run(_run())


def test_ioresult_merge_mixed_reads():

    async def _run():
        left = IOResult(reads={"/a": b"hello"})
        ait = _async_source(b"x")
        right = IOResult(reads={"/b": ait})
        merged = await left.merge(right)
        assert merged.reads["/a"] == b"hello"
        assert merged.reads["/b"] is ait

    asyncio.run(_run())


def test_ioresult_stdout_defaults_none():
    io = IOResult()
    assert io.stdout is None
    assert io.stderr is None
    assert io.exit_code == 0


def test_ioresult_materialize_stdout_bytes():

    async def _run():
        io = IOResult(stdout=b"hello")
        assert await io.materialize_stdout() == b"hello"

    asyncio.run(_run())


def test_ioresult_materialize_stdout_exhausted_async():

    async def _run():
        ci = CachableAsyncIterator(_async_source(b"he", b"llo"))
        await ci.drain()
        io = IOResult(stdout=ci)
        assert await io.materialize_stdout() == b"hello"
        assert io.stdout == b"hello"

    asyncio.run(_run())


def test_ioresult_materialize_stdout_none():

    async def _run():
        io = IOResult(stdout=None)
        assert await io.materialize_stdout() == b""

    asyncio.run(_run())


def test_ioresult_stdout_str():

    async def _run():
        io = IOResult(stdout=b"hello world")
        assert await io.stdout_str() == "hello world"

    asyncio.run(_run())


def test_ioresult_materialize_stderr():

    async def _run():
        io = IOResult(stderr=b"error msg")
        assert await io.materialize_stderr() == b"error msg"

    asyncio.run(_run())


def test_ioresult_stderr_str():

    async def _run():
        io = IOResult(stderr=b"error")
        assert await io.stderr_str() == "error"

    asyncio.run(_run())


def test_ioresult_merge_stdout_takes_right():

    async def _run():
        left = IOResult(stdout=b"left")
        right = IOResult(stdout=b"right")
        merged = await left.merge(right)
        assert await merged.materialize_stdout() == b"right"

    asyncio.run(_run())


def test_ioresult_merge_exit_code_takes_right():

    async def _run():
        left = IOResult(exit_code=0)
        right = IOResult(exit_code=1)
        merged = await left.merge(right)
        assert merged.exit_code == 1

    asyncio.run(_run())


def test_ioresult_merge_stderr_concatenates():

    async def _run():
        left = IOResult(stderr=b"err1 ")
        right = IOResult(stderr=b"err2")
        merged = await left.merge(right)
        assert await merged.materialize_stderr() == b"err1 err2"

    asyncio.run(_run())


def test_ioresult_merge_stderr_none_both():

    async def _run():
        left = IOResult(stderr=None)
        right = IOResult(stderr=None)
        merged = await left.merge(right)
        assert merged.stderr is None

    asyncio.run(_run())


def test_stdout_str_materializes_async_iterator():

    async def _run():
        io = IOResult(stdout=_async_source(b"hel", b"lo"))
        assert await io.stdout_str() == "hello"

    asyncio.run(_run())


def test_stderr_str_materializes_async_iterator():

    async def _run():
        io = IOResult(stderr=_async_source(b"err", b"or"))
        assert await io.stderr_str() == "error"

    asyncio.run(_run())


def test_merge_materializes_async_stderr():

    async def _run():
        left = IOResult(stderr=_async_source(b"warn"))
        right = IOResult(stdout=b"out")
        merged = await left.merge(right)
        assert await merged.stderr_str() == "warn"

    asyncio.run(_run())
