import pytest

from mirage.accessor.redis import RedisAccessor
from mirage.core.redis.copy import copy
from mirage.core.redis.dest import lookup_error
from mirage.core.redis.read import read
from mirage.core.redis.rename import rename
from mirage.core.redis.rmdir import rmdir
from mirage.core.redis.set_attrs import set_attrs
from mirage.core.redis.stat import stat
from mirage.core.redis.stream import read_stream
from mirage.core.redis.unlink import unlink
from mirage.types import PathSpec


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.lstrip("/"), virtual=virtual, directory=virtual
    )


async def _seed(accessor: RedisAccessor) -> None:
    await accessor.store.set_file("/a.txt", b"a")
    await accessor.store.add_dir("/d")


# The kernel resolves a path one component at a time and stops at the
# first that is not a directory; measured on debian:stable-slim (`cat
# a.txt/x` is "Not a directory", `cat nope/x` is "No such file or
# directory").
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "key,kind",
    [
        ("/a.txt/x", NotADirectoryError),
        ("/a.txt/x/y", NotADirectoryError),
        ("/d/x", FileNotFoundError),
        ("/nope/x", FileNotFoundError),
        ("/nope", FileNotFoundError),
    ],
)
async def test_lookup_error_stops_at_the_first_non_directory(store, key, kind):
    await _seed(store)
    error = await lookup_error(store.store, _spec(key), key)
    assert type(error) is kind
    assert error.filename == key


async def _drain(accessor: RedisAccessor, spec: PathSpec) -> None:
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
async def test_every_lookup_names_a_plain_file_parent(store, name):
    await _seed(store)
    op = _OPS[name]
    with pytest.raises(NotADirectoryError) as exc:
        await op(store, _spec("/a.txt/x"))
    assert exc.value.filename == "/a.txt/x"
    with pytest.raises(FileNotFoundError):
        await op(store, _spec("/nope/x"))
