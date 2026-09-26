from dataclasses import replace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from mirage import (GenericVFS, MountMode, NativeReadOps, PathSpec, ReadOps,
                    SearchOps, SearchQuery, SessionProfile, VFSAdapter,
                    Workspace, WriteOps)
from mirage.accessor.ram import RAMAccessor
from mirage.commands.builtin.ram.io import IO
from mirage.policy.profile import PathsBlock
from mirage.vfs.ram.store import RAMStore

READ = ReadOps(readdir=IO.readdir, read_bytes=IO.read_bytes, stat=IO.stat)
PATH = PathSpec(virtual="/nested/data/a.txt",
                directory="/nested/data",
                vfs_path="a.txt")


@pytest_asyncio.fixture
async def accessor():
    backend = RAMAccessor(RAMStore())
    await IO.write(backend, PATH, b"hello\n")
    return backend


@pytest.mark.asyncio
async def test_minimal_reads_serve_shell_streams_and_dispatch(accessor):
    vfs = GenericVFS(name="custom",
                     accessor=accessor,
                     io=VFSAdapter(read=READ))
    ws = Workspace({"/nested/data": vfs}, mode=MountMode.READ)
    try:
        for line, expected in [
            ("cat /nested/data/*.txt", "hello\n"),
            ("grep hello /nested/data/a.txt", "hello\n"),
            ("gzip -c /nested/data/a.txt | gunzip", "hello\n"),
        ]:
            result = await ws.shell(line)
            assert await result.stdout_str() == expected
            assert result.exit_code == 0
        assert (await ws.stat(PATH.virtual)).size == 6
        data, _ = await ws.dispatch("read", PATH, offset=1, size=3)
        assert data == b"ell"
        assert b"".join([
            chunk async for chunk in vfs.io.read_stream(accessor, PATH)
        ]) == b"hello\n"
        refused = await ws.shell("rm /nested/data/a.txt")
        assert refused.exit_code == 1
        assert await refused.stderr_str() == (
            "rm: cannot remove '/nested/data/a.txt': "
            "Operation not supported\n")
        assert "write" not in {op.name for op in vfs.ops_list()}
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_existence_fallback_only_handles_absence(accessor):
    io = VFSAdapter(read=READ).to_command_io()
    assert await io.exists(accessor, PATH)
    missing = replace(PATH, vfs_path="missing")
    assert not await io.exists(accessor, missing)
    denied = AsyncMock(side_effect=PermissionError("denied"))
    io = VFSAdapter(read=replace(READ, stat=denied)).to_command_io()
    with pytest.raises(PermissionError, match="denied"):
        await io.exists(accessor, PATH)


@pytest.mark.asyncio
async def test_native_reads_do_not_enable_writes(accessor):
    chunks = [b"hel", b"lo\n"]

    async def stream(a, p, index=None):
        for chunk in chunks:
            yield chunk

    native_range = AsyncMock(return_value=b"ell")
    whole_read = AsyncMock(side_effect=AssertionError("whole read"))
    adapter = VFSAdapter(read=replace(READ, read_bytes=whole_read),
                         native=NativeReadOps(read_stream=stream,
                                              read_range=native_range))
    vfs = GenericVFS(name="custom", accessor=accessor, io=adapter)
    ws = Workspace({"/nested/data": vfs})
    try:
        data, _ = await ws.dispatch("read", PATH, offset=1, size=3)
        assert data == b"ell"
        native_range.assert_awaited_once()
        assert b"".join([
            chunk async for chunk in vfs.io.read_stream(accessor, PATH)
        ]) == b"hello\n"
        whole_read.assert_not_awaited()
        assert "write" not in {op.name for op in vfs.ops_list()}
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", [MountMode.READ, MountMode.WRITE])
async def test_write_capability_obeys_mount_mode(accessor, mode):
    write = AsyncMock(wraps=IO.write)
    vfs = GenericVFS(name="custom",
                     accessor=accessor,
                     io=VFSAdapter(read=READ, writes=WriteOps(write=write)))
    ws = Workspace({"/nested/data": vfs}, mode=mode)
    try:
        result = await ws.shell("echo changed > /nested/data/a.txt")
        assert (result.exit_code == 0) == (mode == MountMode.WRITE)
        assert write.await_count == (1 if mode == MountMode.WRITE else 0)
        refused = await ws.shell("rm /nested/data/a.txt")
        assert await refused.stderr_str() == (
            "rm: cannot remove '/nested/data/a.txt': "
            "Operation not supported\n")
        assert "write" in {op.name for op in vfs.ops_list()}
        assert "unlink" not in {op.name for op in vfs.ops_list()}
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("command", ["grep", "rg"])
@pytest.mark.parametrize("answer", [["native match"], [], None])
async def test_search_capability_distinguishes_decline_from_no_matches(
        accessor, command, answer):
    search = AsyncMock(return_value=answer)
    read = AsyncMock(wraps=IO.read_bytes)
    adapter = VFSAdapter(read=replace(READ, read_bytes=read),
                         search=SearchOps(search=search,
                                          meta={"grep": {
                                              "mode": "literal"
                                          }}))
    ws = Workspace({
        "/nested/data":
        GenericVFS(name="custom", accessor=accessor, io=adapter)
    })
    try:
        result = await ws.shell(f"{command} -F hello {PATH.virtual}")
        output = await result.stdout_str()
        assert output == ("hello\n" if answer is None else "".join(
            line + "\n" for line in answer))
        assert result.exit_code == (1 if answer == [] else 0)
        assert read.await_count == (1 if answer is None else 0)
        search.assert_awaited_once()
        args = search.await_args.args
        assert args[1].vfs_path == "a.txt"
        assert args[2] == SearchQuery(query="hello",
                                      options={
                                          "grep": {
                                              "ignore_case": False,
                                              "fixed_string": True,
                                              "whole_word": False,
                                              "basic": command == "grep"
                                          }
                                      })
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("flags,pattern,expected",
                         [("-n", "hello", "1:hello\n"),
                          ("-E", "h.*o", "hello\n")])
async def test_search_unsupported_requests_scan_without_calling_backend(
        accessor, flags, pattern, expected):
    search = AsyncMock(side_effect=AssertionError("native query must not run"))
    adapter = VFSAdapter(read=READ,
                         search=SearchOps(search=search,
                                          meta={"grep": {
                                              "mode": "literal"
                                          }}))
    ws = Workspace({
        "/nested/data":
        GenericVFS(name="custom", accessor=accessor, io=adapter)
    })
    try:
        result = await ws.shell(f"grep {flags} '{pattern}' {PATH.virtual}")
        assert await result.stdout_str() == expected
        assert result.exit_code == 0
        search.assert_not_awaited()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_search_errors_do_not_turn_into_fallback_reads(accessor):
    search = AsyncMock(side_effect=PermissionError("search refused"))
    read = AsyncMock(wraps=IO.read_bytes)
    adapter = VFSAdapter(read=replace(READ, read_bytes=read),
                         search=SearchOps(search=search,
                                          meta={"grep": {
                                              "mode": "regex"
                                          }}))
    ws = Workspace({
        "/nested/data":
        GenericVFS(name="custom", accessor=accessor, io=adapter)
    })
    try:
        result = await ws.shell(f"grep hello {PATH.virtual}")
        assert result.exit_code != 0
        assert "search refused" in await result.stderr_str()
        read.assert_not_awaited()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_native_search_defers_when_subtree_contains_hidden_paths(
        accessor):
    search = AsyncMock(
        side_effect=AssertionError("native search would bypass visibility"))
    adapter = VFSAdapter(read=READ,
                         search=SearchOps(search=search,
                                          meta={"grep": {
                                              "mode": "regex"
                                          }}))
    ws = Workspace(
        {
            "/nested/data":
            GenericVFS(name="custom", accessor=accessor, io=adapter)
        },
        profiles={
            "default":
            SessionProfile(paths=PathsBlock(hide=("/nested/data/secret", )))
        })
    try:
        result = await ws.shell("grep -r hello /nested/data")
        assert result.exit_code == 0
        assert "hello" in await result.stdout_str()
        search.assert_not_awaited()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_resource_search_options_are_independent_of_grep(accessor):
    search = AsyncMock(return_value=["deployment 42"])
    capability = SearchOps(search=search, meta={"ranking": "relevance"})
    adapter = VFSAdapter(read=READ, search=capability)
    query = SearchQuery("recent deployments",
                        options={
                            "limit": 20,
                            "filters": {
                                "project": "backend"
                            }
                        })
    io = adapter.to_command_io()
    assert await io.search.search(accessor, PATH, query) == ["deployment 42"]
    search.assert_awaited_once_with(accessor, PATH, query)
    search.reset_mock()
    ws = Workspace({
        "/nested/data":
        GenericVFS(name="custom", accessor=accessor, io=adapter)
    })
    try:
        for command in ("grep", "rg"):
            result = await ws.shell(f"{command} hello {PATH.virtual}")
            assert result.exit_code == 0
            assert await result.stdout_str() == "hello\n"
        search.assert_not_awaited()
    finally:
        await ws.close()
