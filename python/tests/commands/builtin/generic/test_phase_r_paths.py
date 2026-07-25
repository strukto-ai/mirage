import pytest

from mirage.commands.builtin.generic.basename import basename
from mirage.commands.builtin.generic.dirname import dirname
from mirage.commands.builtin.generic.mktemp import mktemp
from mirage.commands.builtin.generic.readlink import readlink
from mirage.commands.builtin.generic.realpath import realpath
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import mount_key


def _spec(original: str, prefix: str = "") -> PathSpec:
    return PathSpec(resource_path=mount_key(original, prefix),
                    virtual=original,
                    directory=original,
                    resolved=True)


@pytest.mark.asyncio
async def test_basename_single():
    out, _ = await basename("/a/b/c.txt")
    assert out == b"c.txt\n"


@pytest.mark.asyncio
async def test_basename_suffix():
    out, _ = await basename("/a/b.txt", ".txt")
    assert out == b"b\n"


@pytest.mark.asyncio
async def test_basename_empty():
    out, _ = await basename()
    assert out == b"\n"


@pytest.mark.asyncio
async def test_dirname_single():
    out, _ = await dirname("/a/b/c.txt")
    assert out == b"/a/b\n"


@pytest.mark.asyncio
async def test_dirname_no_slash():
    out, _ = await dirname("foo")
    assert out == b".\n"


@pytest.mark.asyncio
async def test_dirname_multiple():
    out, _ = await dirname("/a/b", "/x/y/z")
    assert out == b"/a\n/x/y\n"


@pytest.mark.asyncio
async def test_realpath_normalizes():

    async def stat_fn(path):
        return FileStat(name="x")

    out, _ = await realpath([_spec("/a/./b/../c")], stat_fn=stat_fn)
    assert out == b"/a/c\n"


@pytest.mark.asyncio
async def test_realpath_exists_check_passes():

    async def stat_fn(path):
        return FileStat(name="x")

    out, _ = await realpath([_spec("/a/b")], stat_fn=stat_fn, e=True)
    assert out == b"/a/b\n"


@pytest.mark.asyncio
async def test_realpath_exists_check_fails():

    async def stat_fn(path):
        raise FileNotFoundError

    # A plain (non-fs) error carrying the fully GNU-formatted message, so
    # format_fs_error emits it verbatim; a FileNotFoundError would be
    # re-wrapped into a doubled message (and diverge from the TS throw).
    with pytest.raises(ValueError, match="realpath"):
        await realpath([_spec("/missing")], stat_fn=stat_fn, e=True)


@pytest.mark.asyncio
async def test_realpath_multiple():

    async def stat_fn(path):
        return FileStat(name="x")

    out, _ = await realpath([_spec("/a"), _spec("/b/../c")], stat_fn=stat_fn)
    assert out == b"/a\n/c\n"


@pytest.mark.asyncio
async def test_readlink_simple():
    out, _ = await readlink([_spec("/a/b")])
    assert out == b"/a/b\n"


@pytest.mark.asyncio
async def test_readlink_with_prefix():
    out, _ = await readlink([_spec("/mnt/b", prefix="/mnt")])
    assert out == b"/mnt/b\n"


@pytest.mark.asyncio
async def test_readlink_normalize_with_f():
    out, _ = await readlink([_spec("/a/./b")], f=True)
    assert out == b"/a/b\n"


@pytest.mark.asyncio
async def test_readlink_no_newline():
    out, _ = await readlink([_spec("/a/b")], n=True)
    assert out == b"/a/b"


@pytest.mark.asyncio
async def test_readlink_missing_operand():
    with pytest.raises(ValueError, match="missing operand"):
        await readlink([])


@pytest.mark.asyncio
async def test_mktemp_creates_file():
    mkdir_calls: list[tuple] = []
    write_calls: list[tuple] = []

    async def mkdir_fn(path, parents=False):
        mkdir_calls.append((path, parents))

    async def write_bytes_fn(path, data):
        write_calls.append((path, data))

    out, _ = await mktemp(mkdir_fn=mkdir_fn,
                          write_bytes_fn=write_bytes_fn,
                          t=True)
    text = out.decode()
    assert text.startswith("/tmp/tmp.")
    assert text.endswith("\n")
    assert [(path.virtual, parents)
            for path, parents in mkdir_calls] == [("/tmp", True)]
    assert len(write_calls) == 1
    assert write_calls[0][0].virtual == text.rstrip("\n")
    assert write_calls[0][1] == b""


@pytest.mark.asyncio
async def test_mktemp_creates_directory():
    mkdir_calls: list[tuple] = []
    write_calls: list[tuple] = []

    async def mkdir_fn(path, parents=False):
        mkdir_calls.append((path, parents))

    async def write_bytes_fn(path, data):
        write_calls.append((path, data))

    out, _ = await mktemp(mkdir_fn=mkdir_fn,
                          write_bytes_fn=write_bytes_fn,
                          d=True,
                          t=True)
    text = out.decode().rstrip("\n")
    assert [(path.virtual, parents)
            for path, parents in mkdir_calls] == [("/tmp", True),
                                                  (text, False)]
    assert write_calls == []


@pytest.mark.asyncio
async def test_mktemp_custom_parent():
    mkdir_calls: list[tuple] = []

    async def mkdir_fn(path, parents=False):
        mkdir_calls.append((path, parents))

    async def write_bytes_fn(path, data):
        pass

    out, _ = await mktemp(mkdir_fn=mkdir_fn,
                          write_bytes_fn=write_bytes_fn,
                          p="/var/cache")
    assert out.decode().startswith("/var/cache/tmp.")
    assert (mkdir_calls[0][0].virtual, mkdir_calls[0][1]) == ("/var/cache",
                                                              True)


@pytest.mark.asyncio
async def test_mktemp_pathspec_parent():
    mkdir_calls: list[tuple] = []

    async def mkdir_fn(path, parents=False):
        mkdir_calls.append((path, parents))

    async def write_bytes_fn(path, data):
        pass

    out, _ = await mktemp(mkdir_fn=mkdir_fn,
                          write_bytes_fn=write_bytes_fn,
                          p=_spec("/scratch"))
    assert out.decode().startswith("/scratch/tmp.")


@pytest.mark.asyncio
async def test_mktemp_custom_template():
    mkdir_calls: list[tuple] = []
    write_calls: list[tuple] = []

    async def mkdir_fn(path, parents=False):
        mkdir_calls.append((path, parents))

    async def write_bytes_fn(path, data):
        write_calls.append((path, data))

    out, _ = await mktemp("session_XXXXXX",
                          mkdir_fn=mkdir_fn,
                          write_bytes_fn=write_bytes_fn,
                          t=True)
    text = out.decode().rstrip("\n")
    assert text.startswith("/tmp/session_")
    assert len(text) == len("/tmp/session_") + 6
