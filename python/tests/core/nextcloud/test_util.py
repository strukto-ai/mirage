import contextlib

import pytest

from mirage.core.nextcloud.copy import copy
from mirage.core.nextcloud.create import create
from mirage.core.nextcloud.read import read
from mirage.core.nextcloud.rename import rename
from mirage.core.nextcloud.stream import read_stream
from mirage.core.nextcloud.truncate import truncate
from mirage.core.nextcloud.unlink import unlink
from mirage.core.nextcloud.util import nextcloud_key, raw_path_of
from mirage.core.nextcloud.write import write
from mirage.types import PathSpec


def _mounted(virtual: str, vfs_path: str) -> PathSpec:
    return PathSpec(virtual=virtual, directory=virtual, vfs_path=vfs_path)


@pytest.mark.parametrize(
    ("virtual", "vfs_path", "raw", "key"),
    [
        ("/nc/docs/a.txt", "docs/a.txt", "/docs/a.txt", "docs/a.txt"),
        ("/nc", "", "/", ""),
        ("/nc/", "", "/", ""),
        ("/nc/docs/", "docs", "/docs/", "docs/"),
        ("/nc/docs/a.txt/", "docs/a.txt", "/docs/a.txt/", "docs/a.txt/"),
        ("/a.txt", "a.txt", "/a.txt", "a.txt"),
    ],
)
def test_raw_path_and_key_drop_the_mount_prefix(virtual, vfs_path, raw, key):
    path = _mounted(virtual, vfs_path)
    assert raw_path_of(path) == raw
    assert nextcloud_key(path) == key


class _KeyLog:
    def __init__(self, operator) -> None:
        self.operator = operator
        self.calls: list[tuple[str, ...]] = []

    def __getattr__(self, method: str):
        target = getattr(self.operator, method)

        def call(*args, **kwargs):
            keys = tuple(a for a in args if isinstance(a, str))
            self.calls.append((method, *keys))
            return target(*args, **kwargs)

        return call


async def _drain(chunks) -> None:
    async for _ in chunks:
        pass


_SLASHED = _mounted("/nc/docs/a.txt/", "docs/a.txt")
_OTHER = _mounted("/nc/b.txt", "b.txt")


@pytest.mark.parametrize(
    ("call", "calls"),
    [
        (
            lambda acc: copy(acc, _SLASHED, _OTHER),
            [("copy", "docs/a.txt/", "b.txt")],
        ),
        (lambda acc: create(acc, _SLASHED), [("write", "docs/a.txt/")]),
        (lambda acc: read(acc, _SLASHED), [("read", "docs/a.txt/")]),
        (
            lambda acc: rename(acc, _SLASHED, _OTHER),
            [("rename", "docs/a.txt/", "b.txt")],
        ),
        (
            lambda acc: _drain(read_stream(acc, _SLASHED)),
            [("open", "docs/a.txt/", "rb")],
        ),
        (
            lambda acc: truncate(acc, _SLASHED, 0),
            [("read", "docs/a.txt/"), ("write", "docs/a.txt/")],
        ),
        (lambda acc: unlink(acc, _SLASHED), [("delete", "docs/a.txt/")]),
        (
            lambda acc: write(acc, _SLASHED, b"x"),
            [("write", "docs/a.txt/")],
        ),
    ],
    ids=[
        "copy",
        "create",
        "read",
        "rename",
        "stream",
        "truncate",
        "unlink",
        "write",
    ],
)
@pytest.mark.asyncio
async def test_key_only_ops_keep_the_typed_trailing_slash(
    make_acc, call, calls
):
    acc = make_acc({"docs/a.txt": b"abc"})
    log = _KeyLog(acc._fake)
    acc.operator = lambda: log
    with contextlib.suppress(FileNotFoundError):
        await call(acc)
    assert log.calls == calls
