import errno
from collections.abc import AsyncIterator
from typing import Any

import pytest

from mirage.commands.builtin.utils.stream_host import StreamHost
from mirage.commands.constants import ROOT_CWD
from mirage.errors.fs import enotsup
from mirage.io.async_line_iterator import SharedInput
from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.types import IOResult, OpReport, materialize
from mirage.types import FileStat, FileType, JsonValue, PathSpec


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
    gathered: dict[str, JsonValue] = {**read, "least": 8}
    assert await host.serve(gathered, b"") == ({"end": True}, b"one\n", None)
    missing: dict[str, JsonValue] = {"op": "read", "fd": 2, "path": "/b.txt"}
    reply = (await host.serve(missing, b"")).reply
    assert reply == {"error": "No such file or directory", "errno": "ENOENT"}


@pytest.mark.asyncio
async def test_a_name_standing_in_for_an_operand_reads_as_one() -> None:
    # Outside a workspace only the operand's reader can serve a name.
    host = _host({"/a.txt.zip": b"stored\n"})
    named: dict[str, JsonValue] = {"op": "read", "fd": 1, "path": "/a.txt.zip"}
    assert (await host.serve(named, b"")).reply == {
        "error": "No such file or directory",
        "errno": "ENOENT",
    }
    stand_in: dict[str, JsonValue] = {**named, "fd": 2, "as_operand": True}
    assert await host.serve(stand_in, b"") == ({}, b"stored\n", None)


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

    host = StreamHost([], stream, None, dispatch, ROOT_CWD)
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
    refused: dict[str, JsonValue] = {
        "op": "write",
        "path": "/ro",
        "atomic": True,
    }
    assert (await host.serve(refused, b"")).reply == {
        "error": "Permission denied",
        "errno": "EACCES",
    }
    append: dict[str, JsonValue] = {
        "op": "write",
        "path": "/ro",
        "append": True,
    }
    assert (await host.serve(append, b"x")).reply == {}
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

    host = StreamHost([], stream, None, dispatch, ROOT_CWD)
    write: dict[str, JsonValue] = {
        "op": "write",
        "path": "/o",
        "append": False,
    }
    assert (await host.serve(write, b"")).reply == {
        "error": "refusé".encode().decode("latin-1")
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("unbuffered", "seekable", "rest"),
    [
        (True, False, b"left|tail"),
        (False, True, b"left|tail"),
        (False, False, b""),
    ],
)
async def test_standard_input_gets_back_what_the_stream_left(
    unbuffered: bool, seekable: bool, rest: bytes
) -> None:
    async def stream(path: PathSpec) -> AsyncIterator[bytes]:
        yield b""

    # A buffer an earlier reader left comes whole, longer than a piece: the
    # piece goes to the stream, and what it hands back comes before the
    # rest of that buffer.
    shared = SharedInput(_chunks(), seekable=seekable)
    shared.lines.unread(b"x" * CHUNK_SIZE + b"|tail")
    host = StreamHost(
        [], stream, shared, None, ROOT_CWD, unbuffered=unbuffered
    )
    first = await host.serve({"op": "read", "fd": 1, "path": "-"}, b"")
    assert first.data == b"x" * CHUNK_SIZE
    assert (await host.serve({"op": "unread"}, b"left")).reply == {}
    assert await materialize(shared) == rest


@pytest.mark.asyncio
async def test_a_kept_copy_lands_as_a_rename_would_put_it() -> None:
    files: dict[str, bytes] = {"/f": b"body", "/f.bak": b"old"}
    modes: dict[str, int] = {"/f": 0o640}
    calls: list[str] = []

    async def dispatch(
        name: str,
        path: PathSpec,
        /,
        *,
        report: OpReport | None = None,
        **kwargs: Any,
    ) -> tuple[FileStat | bytes | None, IOResult]:
        calls.append(f"{name} {path.virtual}")
        if name == "stat" and path.virtual == "/d":
            return FileStat(name="d", type=FileType.DIRECTORY), IOResult()
        if name == "stat" and path.virtual in files:
            mode = modes.get(path.virtual)
            return FileStat(
                name="f", type=FileType.FILE, mode=mode
            ), IOResult()
        if name == "stat":
            raise FileNotFoundError(errno.ENOENT, "No such file or directory")
        if name == "copy":
            raise enotsup("ram", name, path)
        if name == "read":
            return files[path.virtual], IOResult()
        if name == "write":
            files[path.virtual] = await materialize(kwargs["data"])
        if name == "unlink":
            del files[path.virtual]
        if name == "setattr":
            modes[path.virtual] = kwargs["mode"]
        return None, IOResult()

    async def stream(path: PathSpec) -> AsyncIterator[bytes]:
        yield b""

    host = StreamHost([], stream, None, dispatch, ROOT_CWD)
    kept = await host.serve({"op": "copy", "path": "/f", "to": "/f.bak"}, b"")
    assert kept.reply == {}
    # The store cannot copy, so the bytes stream through in place of the
    # file standing there, its mode kept.
    assert (files["/f.bak"], modes["/f.bak"]) == (b"body", 0o640)
    assert "unlink /f.bak" in calls
    onto = await host.serve({"op": "copy", "path": "/f", "to": "/d"}, b"")
    assert onto.reply == {"error": "Is a directory", "errno": "EISDIR"}
    missing = await host.serve({"op": "readlink", "path": "/none"}, b"")
    assert missing.reply == {
        "error": "No such file or directory",
        "errno": "ENOENT",
    }
    assert (
        await host.serve({"op": "readlink", "path": "/f"}, b"")
    ).reply == {}
