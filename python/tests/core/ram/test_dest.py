import asyncio
import threading

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.core.ram import write as write_module
from mirage.core.ram.copy import copy
from mirage.core.ram.dest import lookup_error
from mirage.core.ram.read import read
from mirage.core.ram.rename import rename
from mirage.core.ram.rmdir import rmdir
from mirage.core.ram.set_attrs import set_attrs
from mirage.core.ram.stat import stat
from mirage.core.ram.unlink import unlink
from mirage.core.ram.write import write
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


def test_appends_from_two_threads_never_pass_the_cap(monkeypatch):
    usage = StorageUsage(8, used=0)
    store = RAMStore(files=RAMFiles(usage), usage=usage)
    store.files["/a"] = b"1234"
    accessor = RAMAccessor(store)
    inside, release = threading.Event(), threading.Event()
    check = write_module.check_capacity

    def held(*args) -> None:
        check(*args)
        if not inside.is_set():
            inside.set()
            release.wait(5)

    monkeypatch.setattr(write_module, "check_capacity", held)
    refused: list[QuotaExceededError] = []

    def append() -> None:
        try:
            asyncio.run(write(accessor, _spec("/a"), b"5678", append=True))
        except QuotaExceededError as exc:
            refused.append(exc)

    first = threading.Thread(target=append)
    first.start()
    assert inside.wait(5)
    second = threading.Thread(target=append)
    second.start()
    second.join(0.05)
    release.set()
    first.join(5)
    second.join(5)
    assert len(refused) == 1
    assert (store.files["/a"], usage.used) == (b"12345678", 8)
