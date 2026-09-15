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
from mirage.commands.builtin.generic_bind.factory import (
    _run_with_namespace_globs, make_generic_commands, with_read_cache)
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
    return PathSpec(resource_path=mount_key("/s3/a.txt", "/s3/"),
                    virtual="/s3/a.txt",
                    directory="/s3/")


async def _drain(source) -> bytes:
    return b"".join([c async for c in source])


def test_factory_registers_only_commands_with_available_capabilities():
    backend = _CountingBackend(b"payload")
    ops = replace(_ops(backend), write=backend.read_bytes)
    commands = make_generic_commands("limited", ops)
    names = {
        registered.name
        for command in commands
        for registered in command._registered_commands
    }

    assert "tee" in names
    assert {
        "cp", "mv", "rm", "mkdir", "tar", "unzip", "gzip", "gunzip", "touch"
    }.isdisjoint(names)


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
