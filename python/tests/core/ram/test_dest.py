import threading

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.core.ram.copy import copy
from mirage.core.ram.dest import check_capacity, lookup_error
from mirage.core.ram.read import read
from mirage.core.ram.rename import rename
from mirage.core.ram.rmdir import rmdir
from mirage.core.ram.set_attrs import set_attrs
from mirage.core.ram.stat import stat
from mirage.core.ram.unlink import unlink
from mirage.errors.types import QuotaExceededError
from mirage.types import PathSpec
from mirage.vfs.capacity import StorageUsage
from mirage.vfs.ram.store import RAMFiles, RAMStore


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


_OPS = {
    "read": lambda a, p: read(a, p),
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


def test_a_capacity_check_and_its_store_are_one_step_across_threads():
    usage = StorageUsage(8, used=0)
    store = RAMStore(files=RAMFiles(usage), usage=usage)
    inside, release = threading.Event(), threading.Event()
    refused: list[QuotaExceededError] = []

    def fill() -> None:
        with check_capacity(store, _spec("/a"), "/a", 8):
            inside.set()
            release.wait()
            store.files["/a"] = b"x" * 8

    def add() -> None:
        try:
            with check_capacity(store, _spec("/b"), "/b", 1):
                store.files["/b"] = b"y"
        except QuotaExceededError as exc:
            refused.append(exc)

    first = threading.Thread(target=fill)
    first.start()
    inside.wait()
    second = threading.Thread(target=add)
    second.start()
    second.join(0.05)
    release.set()
    first.join()
    second.join()
    assert len(refused) == 1
    assert ("/b" in store.files, usage.used) == (False, 8)
