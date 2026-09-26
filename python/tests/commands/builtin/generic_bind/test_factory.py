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

from dataclasses import replace

import pytest

from mirage.cache.context import push_cache_manager
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders import BUILDERS
from mirage.commands.builtin.generic_bind.factory import (
    _run_with_namespace_globs, make_generic_commands, with_read_cache,
    with_slash_guard)
from mirage.commands.config import CommandOpts
from mirage.ops.types import LinkView, NamespaceView
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


class _CountingBackend:

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.stream_calls = 0
        self.bytes_calls = 0

    async def read_stream(self, accessor, path, *args, **kwargs):
        self.stream_calls += 1
        yield self.data

    async def read_bytes(self, accessor, path, *args, **kwargs) -> bytes:
        self.bytes_calls += 1
        return self.data


async def _noop_readdir(accessor, path, index=None) -> list[str]:
    return []


async def _noop_stat(accessor, path, index=None):
    return None


def _ops(backend: _CountingBackend) -> CommandIO:
    return CommandIO(
        readdir=_noop_readdir,
        read_bytes=backend.read_bytes,
        read_stream=backend.read_stream,
        stat=_noop_stat,
        is_mounted=lambda a: True,
        local=False,
    )


def _spec() -> PathSpec:
    return PathSpec(vfs_path=mount_key("/s3/a.txt", "/s3/"),
                    virtual="/s3/a.txt",
                    directory="/s3/")


async def _drain(source) -> bytes:
    return b"".join([c async for c in source])


def test_factory_registers_every_command_whatever_the_backend_lacks():
    # A backend without the write-side ops still gets the whole family:
    # `gzip -c`, `tar -t` and `split -n 1/2` only read, and a line that
    # writes is refused at the missing op instead of the command being
    # absent.
    backend = _CountingBackend(b"payload")
    commands = make_generic_commands("limited", _ops(backend))
    names = {
        registered.name
        for command in commands
        for registered in command._registered_commands
    }

    assert names == {b.name for b in BUILDERS}


@pytest.mark.asyncio
async def test_warm_read_stream_serves_cache_without_backend():
    backend = _CountingBackend(b"payload")
    cache = RAMFileCacheStore()
    await cache.set("/s3/a.txt", b"payload")
    manager = CacheManager(cache, None, "/s3/", True)
    ops = with_read_cache(_ops(backend))
    prev = push_cache_manager(manager)
    try:
        out = await _drain(ops.read_stream(None, _spec()))
    finally:
        push_cache_manager(prev)
    assert out == b"payload"
    assert backend.stream_calls == 0


@pytest.mark.asyncio
async def test_warm_read_bytes_serves_cache_without_backend():
    backend = _CountingBackend(b"payload")
    cache = RAMFileCacheStore()
    await cache.set("/s3/a.txt", b"payload")
    manager = CacheManager(cache, None, "/s3/", True)
    ops = with_read_cache(_ops(backend))
    prev = push_cache_manager(manager)
    try:
        out = await ops.read_bytes(None, _spec())
    finally:
        push_cache_manager(prev)
    assert out == b"payload"
    assert backend.bytes_calls == 0


@pytest.mark.asyncio
async def test_cold_read_falls_through_to_backend():
    backend = _CountingBackend(b"payload")
    manager = CacheManager(RAMFileCacheStore(), None, "/s3/", True)
    ops = with_read_cache(_ops(backend))
    prev = push_cache_manager(manager)
    try:
        out = await _drain(ops.read_stream(None, _spec()))
    finally:
        push_cache_manager(prev)
    assert out == b"payload"
    assert backend.stream_calls == 1


@pytest.mark.asyncio
async def test_no_manager_falls_through_to_backend():
    backend = _CountingBackend(b"payload")
    ops = with_read_cache(_ops(backend))
    out = await _drain(ops.read_stream(None, _spec()))
    assert out == b"payload"
    assert backend.stream_calls == 1


async def _no_target(virtual: str):
    return None


async def _nothing_there(virtual: str) -> bool:
    return False


def _no_links(directory: str) -> list:
    return []


def _same(path: str) -> str:
    return path


def _owes_nothing(parent: str) -> list[str]:
    return []


@pytest.mark.asyncio
async def test_namespace_globs_stamp_the_link_target_stat():
    # The command tier's `*/` asks the namespace what a link points at,
    # so the invocation's target_stat rides the adapter beside the child
    # names, stamped per invocation exactly like glob_children.
    seen: list[CommandIO] = []

    async def capture(ops, accessor, paths, texts, opts):
        seen.append(ops)

    links = LinkView(stat_at=_no_links,
                     children=_no_links,
                     subtree=_no_links,
                     resolve=_same,
                     exists=_nothing_there,
                     target_stat=_no_target)
    opts = CommandOpts(
        ns=NamespaceView(links=links, child_mounts=_owes_nothing))
    await _run_with_namespace_globs(_ops(_CountingBackend(b"")),
                                    lambda ops: ops, capture, None, [], [],
                                    opts)
    assert seen[0].glob_children is _owes_nothing
    assert seen[0].glob_target_stat is _no_target


@pytest.mark.asyncio
async def test_namespace_globs_stamp_nothing_without_links():
    seen: list[CommandIO] = []

    async def capture(ops, accessor, paths, texts, opts):
        seen.append(ops)

    opts = CommandOpts(ns=NamespaceView(child_mounts=_owes_nothing))
    await _run_with_namespace_globs(_ops(_CountingBackend(b"")),
                                    lambda ops: ops, capture, None, [], [],
                                    opts)
    assert seen[0].glob_target_stat is None


@pytest.mark.asyncio
async def test_slash_guard_refuses_a_slashed_write_before_the_backend():
    # open(2) with O_CREAT answers `x/` with EISDIR before looking anything
    # up, so `tee missing/` and `truncate -s0 missing/` must not leave a
    # regular file called `missing` behind; a bare operand passes through.
    backend = _CountingBackend(b"")
    written: list[str] = []

    async def write(accessor, path, data) -> None:
        written.append(path.virtual)

    async def truncate(accessor, path, length) -> None:
        written.append(path.virtual)

    guarded = with_slash_guard(
        replace(_ops(backend), write=write, append=write, truncate=truncate))
    slashed = PathSpec(vfs_path=mount_key("/s3/missing", "/s3/"),
                       virtual="/s3/missing",
                       directory="/s3/",
                       raw_path="/s3/missing/")
    with pytest.raises(IsADirectoryError):
        await guarded.write(None, slashed, b"x")
    with pytest.raises(IsADirectoryError):
        await guarded.append(None, slashed, b"x")
    with pytest.raises(IsADirectoryError):
        await guarded.truncate(None, slashed, 0)
    await guarded.write(None, _spec(), b"x")
    await guarded.truncate(None, _spec(), 0)
    assert written == ["/s3/a.txt", "/s3/a.txt"]


@pytest.mark.asyncio
async def test_slash_guard_leaves_write_absent_when_the_backend_has_none():
    guarded = with_slash_guard(_ops(_CountingBackend(b"")))
    assert guarded.write is None
    assert guarded.append is None
    assert guarded.truncate is None


@pytest.mark.parametrize("option", [
    {
        "overrides": {"cat", "search"}
    },
    {
        "provision_overrides": {
            "gerp": lambda *a, **k: None
        }
    },
    {
        "ops_overrides": {
            "lss": _ops(_CountingBackend(b""))
        }
    },
])
def test_a_name_no_builder_has_is_refused(option):
    """A name no builder has did nothing, so a typo left the generic
    registered beside the bespoke command, and mem0's ``search`` read as
    if it displaced something."""
    with pytest.raises(ValueError, match="no generic builder named"):
        make_generic_commands("fake", _ops(_CountingBackend(b"")), **option)


@pytest.mark.asyncio
async def test_partial_consumer_caches_complete_synthesized_stream():
    backend = _CountingBackend(b'first\nsecond\n')
    manager = CacheManager(RAMFileCacheStore(), None, '/s3/', True)
    prev = push_cache_manager(manager)
    try:
        ops = with_read_cache(replace(_ops(backend), streams_bytes=True))
    finally:
        push_cache_manager(prev)
    source = ops.read_stream(None, _spec())
    assert (await anext(source))[:5] == b'first'
    await source.aclose()
    assert await manager.cached_bytes(_spec()) == backend.data
    assert await ops.read_bytes(None, _spec()) == backend.data
    assert backend.bytes_calls == 1
    assert backend.stream_calls == 0
