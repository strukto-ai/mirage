import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.core.ram.copy import copy
from mirage.core.ram.dest import lookup_error
from mirage.core.ram.read import read
from mirage.core.ram.rename import rename
from mirage.core.ram.rmdir import rmdir
from mirage.core.ram.set_attrs import set_attrs
from mirage.core.ram.stat import stat
from mirage.core.ram.stream import read_stream
from mirage.core.ram.unlink import unlink
from mirage.types import PathSpec
from mirage.vfs.ram.store import RAMStore


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.lstrip("/"), virtual=virtual, directory=virtual
    )


@pytest.fixture
def accessor() -> RAMAccessor:
    s = RAMStore()
    s.files["/a.txt"] = b"a"
    s.dirs.add("/d")
    s.files["/orphan/a.txt"] = b"o"
    return RAMAccessor(s)


# GNU resolves a path one component at a time and stops at the first that
# is not a directory; measured against coreutils 9.7 (`cat a.txt/x` is
# "Not a directory", `cat nope/x` is "No such file or directory").
@pytest.mark.parametrize(
    "key,kind",
    [
        ("/a.txt/x", NotADirectoryError),
        ("/a.txt/x/y", NotADirectoryError),
        ("/d/a.txt/x", FileNotFoundError),
        ("/d/x", FileNotFoundError),
        ("/nope/x", FileNotFoundError),
        ("/nope", FileNotFoundError),
        ("/orphan/b.txt", FileNotFoundError),
    ],
)
def test_lookup_error_stops_at_the_first_non_directory(accessor, key, kind):
    error = lookup_error(accessor.store, _spec(key), key)
    assert type(error) is kind
    assert error.filename == key


async def _drain(accessor: RAMAccessor, spec: PathSpec) -> None:
    async for _ in read_stream(accessor, spec):
        pass


_OPS = {
    "read": lambda a, p: read(a, p),
    "stream": _drain,
    "stat": lambda a, p: stat(a, p),
    "set_attrs": lambda a, p: set_attrs(a, p, mode=0o644),
    "unlink": lambda a, p: unlink(a, p),
    "rmdir": lambda a, p: rmdir(a, p),
    "copy": lambda a, p: copy(a, p, _spec("/copy.txt")),
    "rename": lambda a, p: rename(a, p, _spec("/moved.txt")),
}


@pytest.mark.asyncio
@pytest.mark.parametrize("name", sorted(_OPS))
async def test_every_lookup_names_a_plain_file_parent(accessor, name):
    op = _OPS[name]
    with pytest.raises(NotADirectoryError) as exc:
        await op(accessor, _spec("/a.txt/x"))
    assert exc.value.filename == "/a.txt/x"
    with pytest.raises(FileNotFoundError):
        await op(accessor, _spec("/nope/x"))
