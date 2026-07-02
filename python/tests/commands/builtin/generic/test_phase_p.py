import gzip as gziplib

import pytest

from mirage.commands.builtin.generic.gunzip import gunzip
from mirage.commands.builtin.generic.gzip import gzip
from mirage.commands.builtin.generic.zcat import zcat
from mirage.commands.builtin.generic.zgrep import zgrep
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(resource_path=(path).strip("/"),
                    virtual=path,
                    directory=path,
                    resolved=True)


def _make_backend(files: dict[str, bytes]):
    store = dict(files)

    async def read_bytes(accessor, path, index=None):
        key = path.virtual if isinstance(path, PathSpec) else path
        if key not in store:
            raise FileNotFoundError(key)
        return store[key]

    async def write_bytes(accessor, path, data, index=None):
        key = path.virtual if isinstance(path, PathSpec) else path
        store[key] = data

    async def unlink(accessor, path, index=None):
        key = path.virtual if isinstance(path, PathSpec) else path
        store.pop(key, None)

    return read_bytes, write_bytes, unlink, store


async def _drain(stdout) -> bytes:
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    return b"".join([c async for c in stdout])


@pytest.mark.asyncio
async def test_gzip_compress_then_decompress_round_trip():
    rb, wb, un, _ = _make_backend({})
    compressed_iter, _ = await gzip([],
                                    read_bytes=rb,
                                    write_bytes=wb,
                                    unlink=un,
                                    stdin=b"hello world\n")
    compressed = await _drain(compressed_iter)
    decompressed_iter, _ = await gunzip([],
                                        read_bytes=rb,
                                        write_bytes=wb,
                                        unlink=un,
                                        stdin=compressed)
    assert await _drain(decompressed_iter) == b"hello world\n"


@pytest.mark.asyncio
async def test_gzip_file_writes_gz_and_deletes_source():
    rb, wb, un, store = _make_backend({"/a.txt": b"payload data"})
    _, io = await gzip([_spec("/a.txt")],
                       read_bytes=rb,
                       write_bytes=wb,
                       unlink=un)
    assert "/a.txt.gz" in store
    assert "/a.txt" not in store
    assert "/a.txt.gz" in io.writes


@pytest.mark.asyncio
async def test_gzip_file_keep_preserves_source():
    rb, wb, un, store = _make_backend({"/a.txt": b"payload"})
    await gzip([_spec("/a.txt")],
               read_bytes=rb,
               write_bytes=wb,
               unlink=un,
               keep=True)
    assert "/a.txt" in store
    assert "/a.txt.gz" in store


@pytest.mark.asyncio
async def test_gzip_to_stdout_does_not_modify_store():
    rb, wb, un, store = _make_backend({"/a.txt": b"payload"})
    output, _ = await gzip([_spec("/a.txt")],
                           read_bytes=rb,
                           write_bytes=wb,
                           unlink=un,
                           to_stdout=True)
    assert "/a.txt" in store
    assert "/a.txt.gz" not in store
    assert gziplib.decompress(output) == b"payload"


@pytest.mark.asyncio
async def test_gunzip_decompresses_file_and_removes_source():
    raw = gziplib.compress(b"hello")
    rb, wb, un, store = _make_backend({"/a.gz": raw})
    await gunzip([_spec("/a.gz")], read_bytes=rb, write_bytes=wb, unlink=un)
    assert "/a" in store
    assert store["/a"] == b"hello"
    assert "/a.gz" not in store


@pytest.mark.asyncio
async def test_gunzip_test_only_verifies_integrity():
    raw = gziplib.compress(b"valid")
    rb, wb, un, store = _make_backend({"/a.gz": raw})
    output, io = await gunzip([_spec("/a.gz")],
                              read_bytes=rb,
                              write_bytes=wb,
                              unlink=un,
                              test_only=True)
    assert output is None
    assert io.exit_code == 0
    assert "/a.gz" in store


@pytest.mark.asyncio
async def test_gunzip_to_stdout():
    raw = gziplib.compress(b"hi there")
    rb, wb, un, _ = _make_backend({"/a.gz": raw})
    output, _ = await gunzip([_spec("/a.gz")],
                             read_bytes=rb,
                             write_bytes=wb,
                             unlink=un,
                             to_stdout=True)
    assert output == b"hi there"


@pytest.mark.asyncio
async def test_zcat_decompresses_file():
    raw = gziplib.compress(b"compressed text\n")
    rb, _, _, _ = _make_backend({"/a.gz": raw})
    output, _ = await zcat([_spec("/a.gz")], read_bytes=rb)
    assert output == b"compressed text\n"


@pytest.mark.asyncio
async def test_zcat_stdin():
    raw = gziplib.compress(b"from stdin")
    rb, _, _, _ = _make_backend({})
    output, _ = await zcat([], read_bytes=rb, stdin=raw)
    assert output == b"from stdin"


@pytest.mark.asyncio
async def test_zgrep_finds_match_in_compressed_file():
    raw = gziplib.compress(b"alpha\nbeta\ngamma\n")
    rb, _, _, _ = _make_backend({"/a.gz": raw})
    output, io = await zgrep([_spec("/a.gz")], ["beta"], read_bytes=rb)
    assert b"beta" in output
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_zgrep_no_match_returns_exit_1():
    raw = gziplib.compress(b"alpha\nbeta\n")
    rb, _, _, _ = _make_backend({"/a.gz": raw})
    output, io = await zgrep([_spec("/a.gz")], ["zzz"], read_bytes=rb)
    assert output is None
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_zgrep_count_only():
    raw = gziplib.compress(b"foo\nfoo\nbar\n")
    rb, _, _, _ = _make_backend({"/a.gz": raw})
    output, _ = await zgrep(
        [_spec("/a.gz")],
        ["foo"],
        read_bytes=rb,
        flags={"c": True},
    )
    assert b"2" in output


@pytest.mark.asyncio
async def test_zgrep_ignore_case():
    raw = gziplib.compress(b"Apple\nbanana\n")
    rb, _, _, _ = _make_backend({"/a.gz": raw})
    output, _ = await zgrep(
        [_spec("/a.gz")],
        ["apple"],
        read_bytes=rb,
        flags={"i": True},
    )
    assert b"Apple" in output


@pytest.mark.asyncio
async def test_zgrep_files_only_multi():
    rb, _, _, _ = _make_backend({
        "/a.gz": gziplib.compress(b"foo\n"),
        "/b.gz": gziplib.compress(b"bar\n"),
    })
    output, _ = await zgrep(
        [_spec("/a.gz"), _spec("/b.gz")],
        ["foo"],
        read_bytes=rb,
        flags={"args_l": True},
    )
    decoded = output.decode()
    assert "/a.gz" in decoded
    assert "/b.gz" not in decoded


@pytest.mark.asyncio
async def test_zgrep_stdin():
    raw = gziplib.compress(b"hello\nworld\n")
    rb, _, _, _ = _make_backend({})
    output, _ = await zgrep([], ["hello"], read_bytes=rb, stdin=raw)
    assert b"hello" in output
