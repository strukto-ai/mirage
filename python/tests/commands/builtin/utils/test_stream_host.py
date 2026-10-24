import errno
from collections.abc import AsyncIterator
from typing import Any

import pytest

from mirage.commands.builtin.utils.stream_host import StreamHost
from mirage.commands.constants import ROOT_CWD
from mirage.io.types import IOResult, OpReport, materialize
from mirage.types import JsonValue, PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(
        vfs_path=path.strip("/"), virtual=path, directory=path, resolved=True
    )


async def _chunks(*parts: bytes) -> AsyncIterator[bytes]:
    for part in parts:
        yield part


def _host(files: dict[str, bytes], stdin: bytes = b"") -> StreamHost:
    async def stream(path: PathSpec) -> AsyncIterator[bytes]:
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        yield files[path.virtual]

    return StreamHost(
        [_spec("/a.txt")],
        stream,
        _chunks(*stdin.split(b"|")) if stdin else None,
        None,
        ROOT_CWD,
        None,
        lambda path: True,
    )


@pytest.mark.asyncio
async def test_an_operand_as_typed_reads_through_the_mount() -> None:
    host = _host({"/a.txt": b"one\n"})
    read: dict[str, JsonValue] = {
        "op": "read",
        "fd": 1,
        "path": "/a.txt",
        "operand": 1,
    }
    assert await host.serve(read, b"") == ({}, b"one\n", None)
    assert (await host.serve({"op": "read", "fd": 1}, b"")).reply == {
        "end": True
    }
    missing: dict[str, JsonValue] = {"op": "read", "fd": 2, "path": "/b.txt"}
    reply = (await host.serve(missing, b"")).reply
    assert reply == {"error": "No such file or directory", "errno": "ENOENT"}


@pytest.mark.asyncio
async def test_stdin_readers_share_one_cursor() -> None:
    host = _host({}, stdin=b"p\n|q\n")
    first = await host.serve({"op": "read", "fd": 1, "path": "-"}, b"")
    second = await host.serve(
        {"op": "read", "fd": 2, "path": "/dev/stdin"}, b""
    )
    assert (first.data, second.data) == (b"p\n", b"q\n")


@pytest.mark.asyncio
async def test_a_spool_goes_to_the_output_once() -> None:
    host = _host({})
    await host.serve({"op": "spool", "fd": 3}, b"held")
    served = await host.serve({"op": "emit", "fd": 3}, b"")
    assert served.output is not None
    assert await materialize(served.output) == b"held"
    assert (await host.serve({"op": "emit", "fd": 3}, b"")).output is None


@pytest.mark.asyncio
async def test_what_needs_a_workspace_is_refused_outside_one() -> None:
    host = _host({})
    write: dict[str, JsonValue] = {
        "op": "write",
        "path": "out",
        "append": False,
    }
    run: dict[str, JsonValue] = {"op": "run", "command": "ls"}
    assert (await host.serve(write, b"x")).reply == {
        "fatal": "file output requires a workspace"
    }
    assert (await host.serve(run, b"")).reply == {
        "fatal": "running a command requires a workspace"
    }
    await host.close()


@pytest.mark.asyncio
async def test_a_replacement_lands_whole_once_flushed() -> None:
    files: dict[str, bytes] = {"/out": b"old"}

    async def dispatch(
        name: str,
        path: PathSpec,
        /,
        *,
        report: OpReport | None = None,
        **kwargs: Any,
    ) -> tuple[None, IOResult]:
        if path.virtual == "/ro":
            raise PermissionError(errno.EACCES, "Permission denied")
        body = await materialize(kwargs.get("data", b""))
        kept = files.get(path.virtual, b"") if name == "append" else b""
        files[path.virtual] = kept + body
        return None, IOResult()

    async def stream(path: PathSpec) -> AsyncIterator[bytes]:
        yield files[path.virtual]

    host = StreamHost(
        [], stream, None, dispatch, ROOT_CWD, None, lambda path: True
    )
    replace: dict[str, JsonValue] = {
        "op": "write",
        "path": "/out",
        "atomic": True,
    }
    spooled: dict[str, JsonValue] = {
        "op": "write",
        "path": "/out",
        "append": True,
        "spool": 4,
    }
    await host.serve(replace, b"new ")
    await host.serve({"op": "spool", "fd": 4}, b"tail")
    await host.serve(spooled, b"")
    assert files["/out"] == b"old"
    assert (await host.serve({"op": "flush", "path": "/out"}, b"")).reply == {}
    assert files["/out"] == b"new tail"
    await host.serve({"op": "write", "path": "/ro", "atomic": True}, b"")
    failed = await host.serve({"op": "flush"}, b"")
    assert failed.reply == {
        "error": "Permission denied",
        "errno": "EACCES",
        "path": "/ro",
    }
    await host.close()


@pytest.mark.asyncio
async def test_a_file_a_script_names_is_never_stdin() -> None:
    host = _host({}, stdin=b"p\n")
    read: dict[str, JsonValue] = {
        "op": "read",
        "fd": 1,
        "path": "-",
        "file": True,
    }
    assert (await host.serve(read, b"")).reply == {
        "error": "No such file or directory",
        "errno": "ENOENT",
    }


@pytest.mark.asyncio
async def test_an_error_reply_carries_its_words_as_bytes() -> None:
    async def dispatch(
        name: str,
        path: PathSpec,
        /,
        *,
        report: OpReport | None = None,
        **kwargs: Any,
    ) -> tuple[None, IOResult]:
        raise ValueError("refusé")

    async def stream(path: PathSpec) -> AsyncIterator[bytes]:
        yield b""

    host = StreamHost(
        [], stream, None, dispatch, ROOT_CWD, None, lambda path: True
    )
    write: dict[str, JsonValue] = {
        "op": "write",
        "path": "/o",
        "append": False,
    }
    assert (await host.serve(write, b"")).reply == {
        "error": "refusé".encode().decode("latin-1")
    }
