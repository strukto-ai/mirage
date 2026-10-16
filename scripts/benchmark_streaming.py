import argparse
import asyncio
import gc
import hashlib
import json
import platform
import random
import time
import tracemalloc
from collections.abc import AsyncIterator
from typing import Any, NoReturn, NotRequired, TypedDict

from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.generic.gzip import gzip
from mirage.commands.builtin.generic.tar.tar import _write_archive
from mirage.commands.builtin.generic.tar.types import CreateResult, Member
from mirage.io.stream import ensure_stream
from mirage.io.types import ByteSource, materialize
from mirage.types import PathSpec

parser = argparse.ArgumentParser()
parser.add_argument(
    "mode",
    choices=[
        "gzip_file",
        "gzip_stdin",
        "tar_current",
        "cache_default",
        "cache_8mib",
        "cache_0",
    ],
)
parser.add_argument(
    "--whole-read",
    action="store_true",
    help="Use the pre-streaming command reader contract.",
)
parser.add_argument(
    "--known-size",
    action="store_true",
    help="Supply the current tar planner with a known member size.",
)
parser.add_argument("--label", default="working-tree")
parser.add_argument("--mib", type=int, default=128)
args = parser.parse_args()
SIZE = args.mib * 1024 * 1024
CHUNK = 65536
BLOCK = random.Random(17).randbytes(CHUNK)
INPUT = PathSpec.from_str_path("/data/payload.bin")
STDOUT = PathSpec(virtual="-", directory="-", vfs_path="-", raw_path="-")


class Progress(TypedDict):
    input_bytes: int
    output_bytes: int
    first_output_ms: float | None
    first_64k_ms: float | None
    cached_bytes: NotRequired[int]
    drain_budget: NotRequired[int | None]


async def main() -> None:
    state: Progress = {
        "input_bytes": 0,
        "output_bytes": 0,
        "first_output_ms": None,
        "first_64k_ms": None,
    }
    digest = hashlib.sha256()
    stop = False
    gaps = []

    async def heartbeat() -> None:
        previous = time.perf_counter()
        while not stop:
            await asyncio.sleep(0.005)
            now = time.perf_counter()
            gaps.append(max(0, now - previous - 0.005))
            previous = now

    async def source() -> AsyncIterator[bytes]:
        for offset in range(0, SIZE, CHUNK):
            await asyncio.sleep(0)
            chunk = bytes(bytearray(BLOCK[: min(CHUNK, SIZE - offset)]))
            state["input_bytes"] += len(chunk)
            yield chunk

    def read_stream(path: PathSpec) -> AsyncIterator[bytes]:
        return source()

    async def read_bytes(path: PathSpec) -> bytes:
        return await materialize(source())

    async def consume(output: ByteSource | None) -> None:
        if output is None:
            return
        async for chunk in ensure_stream(output):
            if chunk and state["first_output_ms"] is None:
                state["first_output_ms"] = (
                    time.perf_counter() - started
                ) * 1000
            state["output_bytes"] += len(chunk)
            if (
                state["output_bytes"] >= CHUNK
                and state["first_64k_ms"] is None
            ):
                state["first_64k_ms"] = (time.perf_counter() - started) * 1000
            digest.update(chunk)

    async def unexpected(*params: Any) -> NoReturn:
        raise AssertionError("unexpected write or unlink")

    member = (
        Member(name="payload.bin", kind="file", path=INPUT, size=SIZE)
        if args.known_size
        else Member(name="payload.bin", kind="file", path=INPUT)
    )
    reader = read_bytes if args.whole_read else read_stream
    cache = None
    if args.mode.startswith("cache_"):
        budget = {
            "cache_default": None,
            "cache_8mib": 8 * 1024 * 1024,
            "cache_0": 0,
        }[args.mode]
        cache = RAMFileCacheStore(max_drain_bytes=budget)
        manager = CacheManager(cache, RAMIndexCacheStore(), "/data", True)

    gc.collect()
    monitor = asyncio.create_task(heartbeat())
    await asyncio.sleep(0.006)
    gaps.clear()
    tracemalloc.start()
    started = time.perf_counter()
    if args.mode == "tar_current":
        output, io = await _write_archive(
            CreateResult((member,), (), 0),
            STDOUT,
            "",
            False,
            reader,
            unexpected,
        )
        assert io.exit_code == 0
        await consume(output)
    elif args.mode in ("gzip_file", "gzip_stdin"):
        output, io = await gzip(
            [INPUT] if args.mode == "gzip_file" else [],
            read_bytes=reader,
            write_bytes=unexpected,
            unlink=unexpected,
            stdin=source() if args.mode == "gzip_stdin" else None,
            to_stdout=True,
        )
        assert io.exit_code == 0
        await consume(output)
    elif cache is not None:
        await consume(manager.fill_stream(INPUT, source(), []))
        state["cached_bytes"] = cache.cache_size
        state["drain_budget"] = cache.drain_budget
    else:
        raise ValueError(args.mode)
    elapsed = time.perf_counter() - started
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    await asyncio.sleep(0.006)
    stop = True
    await monitor
    assert state["input_bytes"] == SIZE
    print(
        json.dumps(
            {
                "mode": args.mode,
                "mib": args.mib,
                "elapsed_ms": elapsed * 1000,
                "peak_python_mib": peak / 1024 / 1024,
                "max_event_loop_lag_ms": max(gaps, default=0) * 1000,
                "sha256": digest.hexdigest(),
                **state,
                "revision": args.label,
                "python": platform.python_version(),
                "platform": platform.platform(),
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
