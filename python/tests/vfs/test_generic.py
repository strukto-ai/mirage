# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import inspect
from functools import partial

import pytest

from mirage import MountMode, Workspace
from mirage.accessor.base import Accessor
from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexConfig
from mirage.commands.builtin.generic_bind import CommandIO
from mirage.commands.builtin.ram.io import IO as RAM_IO
from mirage.commands.builtin.s3.io import IO as S3_IO
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.commands.config import command
from mirage.commands.spec import CommandSpec
from mirage.io.types import IOResult
from mirage.types import (ContentType, FileStat, FileType, PathSpec,
                          ReadPolicy, ReadSpec)
from mirage.vfs.generic import _DIRECT_OPS, GenericVFS, direct_ops
from mirage.vfs.ram.ram import RAMVFS
from mirage.vfs.ram.store import RAMStore
from mirage.vfs.s3.s3 import S3VFS
from mirage.workspace.mount.read_policy import check_read_capability

PAGES = {
    "guides": {
        "quickstart.md": "# Quickstart\nHello.\n",
    },
    "notes.md": "agents speak bash\n",
}


class WikiAccessor(Accessor):

    def __init__(self, pages: dict) -> None:
        self.pages = pages


def _node(pages: dict, key: str):
    node = pages
    for part in [p for p in key.split("/") if p]:
        if not isinstance(node, dict) or part not in node:
            raise FileNotFoundError(key)
        node = node[part]
    return node


async def readdir(
    accessor: WikiAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    node = _node(accessor.pages, path.vfs_path)
    if not isinstance(node, dict):
        raise NotADirectoryError(path.virtual)
    parent = path.virtual.rstrip("/")
    return [
        f"{parent}/{name}" + ("/" if isinstance(child, dict) else "")
        for name, child in node.items()
    ]


async def read_bytes(
    accessor: WikiAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    node = _node(accessor.pages, path.vfs_path)
    if isinstance(node, dict):
        raise IsADirectoryError(path.virtual)
    return node.encode()


async def stat(
    accessor: WikiAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    node = _node(accessor.pages, path.vfs_path)
    name = path.virtual.rstrip("/").rsplit("/", 1)[-1] or "/"
    if isinstance(node, dict):
        return FileStat(name=name, size=None, type=FileType.DIRECTORY)
    return FileStat(name=name,
                    size=len(node.encode()),
                    type=FileType.FILE,
                    content=ContentType.TEXT)


@command("wiki_hello", vfs="wiki", spec=CommandSpec())
async def wiki_hello(accessor, *texts: str, **flags: object):
    return b"hello custom verb\n", IOResult()


def make_io() -> CommandIO:
    return CommandIO(
        readdir=readdir,
        read_bytes=read_bytes,
        read_stream=partial(stream_from_bytes, read_bytes),
        stat=stat,
        is_mounted=lambda a: True,
        local=False,
    )


def make_vfs(**kwargs) -> GenericVFS:
    return GenericVFS(name="wiki",
                      accessor=WikiAccessor(PAGES),
                      io=make_io(),
                      **kwargs)


def command_names(vfs: GenericVFS) -> set[str]:
    return {rc.name for rc in vfs.commands()}


def test_generic_commands_registered():
    names = command_names(make_vfs())
    assert {"ls", "cat", "grep", "find", "head", "wc"} <= names


def test_write_commands_absent_without_write_op():
    names = command_names(make_vfs())
    assert "tee" not in names
    assert "rm" not in names


def test_overrides_suppress_generic():
    names = command_names(make_vfs(overrides={"grep"}))
    assert "grep" not in names
    assert "rg" in names


def test_extra_commands_registered():
    names = command_names(make_vfs(commands=[wiki_hello]))
    assert "wiki_hello" in names


def test_requires_name():
    with pytest.raises(ValueError):
        GenericVFS(name="", accessor=WikiAccessor(PAGES), io=make_io())


def test_get_state():
    assert make_vfs().get_state() == {
        "type": "wiki",
        "needs_override": True,
    }


def test_declaration_flags_forwarded():
    vfs = make_vfs(sizes_always_known=True,
                   supports_snapshot=True,
                   read_revalidatable=True)
    assert vfs.SIZES_ALWAYS_KNOWN is True
    assert vfs.SUPPORTS_SNAPSHOT is True
    assert vfs.READ_REVALIDATABLE is True


def test_declaration_flags_default_off():
    vfs = make_vfs()
    assert vfs.SIZES_ALWAYS_KNOWN is False
    assert vfs.SUPPORTS_SNAPSHOT is False
    assert vfs.READ_REVALIDATABLE is False


def test_prompts_set():
    vfs = make_vfs(prompt="wiki files", write_prompt="writable")
    assert vfs.PROMPT == "wiki files"
    assert vfs.WRITE_PROMPT == "writable"


@pytest.mark.asyncio
async def test_resolve_glob_uses_io_readdir():
    vfs = make_vfs()
    spec = PathSpec(vfs_path="guides/quick*",
                    virtual="/guides/quick*",
                    directory="/guides",
                    pattern="quick*",
                    resolved=False)
    matches = await vfs.resolve_glob([spec])
    assert [m.virtual for m in matches] == ["/guides/quickstart.md"]


@pytest.mark.asyncio
async def test_workspace_execution_end_to_end():
    ws = Workspace({"/wiki/": make_vfs(commands=[wiki_hello])},
                   mode=MountMode.READ)

    result = await ws.shell("ls /wiki/guides")
    assert "quickstart.md" in await result.stdout_str()

    result = await ws.shell("cat /wiki/notes.md")
    assert await result.stdout_str() == "agents speak bash\n"

    result = await ws.shell("grep -r Quickstart /wiki/")
    assert "/wiki/guides/quickstart.md:# Quickstart" in (await
                                                         result.stdout_str())

    result = await ws.shell("find /wiki -name '*.md'")
    out = await result.stdout_str()
    assert "/wiki/guides/quickstart.md" in out
    assert "/wiki/notes.md" in out

    result = await ws.shell("wiki_hello")
    assert await result.stdout_str() == "hello custom verb\n"

    # The derived ops serve the VFS surface too, not just the commands.
    assert "/wiki/guides/quickstart.md" in await ws.readdir("/wiki/guides")
    assert (await ws.stat("/wiki/notes.md")).size == 18


def test_auto_ops_derived_from_table():
    vfs = make_vfs()
    names = {(ro.name, ro.write) for ro in vfs.ops_list()}
    assert names == {("read", False), ("readdir", False), ("stat", False)}


def test_auto_ops_disabled():
    vfs = make_vfs(auto_ops=False)
    assert vfs.ops_list() == []


def test_user_ops_shadow_derived():
    from mirage.ops.registry import RegisteredOp

    async def my_read(accessor, path, *, index=None, **kwargs):
        return b"custom"

    custom = RegisteredOp(name="read", vfs="wiki", filetype=None, fn=my_read)
    vfs = make_vfs(ops=[custom])
    reads = [ro for ro in vfs.ops_list() if ro.name == "read"]
    assert len(reads) == 1
    assert reads[0].fn is my_read


def test_direct_ops_bound_from_table():
    vfs = make_vfs()
    assert set(vfs._ops) == {
        "readdir",
        "read_bytes",
        "read_stream",
        "stat",
    }
    with pytest.raises(AttributeError):
        vfs.write
    with pytest.raises(AttributeError):
        vfs.unlink


@pytest.mark.asyncio
async def test_direct_op_reads_through_accessor():
    vfs = make_vfs()
    spec = PathSpec(vfs_path="notes.md", virtual="/notes.md", directory="/")
    assert await vfs.read_bytes(spec) == b"agents speak bash\n"


def test_direct_ops_cover_the_builtin_vocabulary():
    # A kit backend built on a builtin's own table must publish at least
    # the names that builtin publishes, or an out-of-tree caller that
    # moved off the builtin loses attributes for ops the table still has.
    kit = GenericVFS(name="ram-kit",
                     accessor=RAMAccessor(RAMStore()),
                     io=RAM_IO)
    assert set(RAMVFS._ops) <= set(kit._ops)


@pytest.mark.asyncio
async def test_direct_op_matches_the_builtin_answer():
    builtin = RAMVFS()
    spec = PathSpec(vfs_path="f.txt", virtual="/f.txt", directory="/")
    await builtin.write(spec, b"same bytes\n")
    kit = GenericVFS(name="ram-kit",
                     accessor=RAMAccessor(builtin._store),
                     io=RAM_IO)
    assert await kit.read_bytes(spec) == await builtin.read_bytes(spec)


async def read_range(
    accessor: WikiAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    RANGE_CALLS.append((index, offset, size))
    body = _node(accessor.pages, path.vfs_path).encode()
    return body[offset:] if size is None else body[offset:offset + size]


RANGE_CALLS: list[tuple[IndexCacheStore, int, int | None]] = []


def make_range_vfs() -> GenericVFS:
    RANGE_CALLS.clear()
    io = CommandIO(
        readdir=readdir,
        read_bytes=read_bytes,
        read_range=read_range,
        read_stream=partial(stream_from_bytes, read_bytes),
        stat=stat,
        is_mounted=lambda a: True,
        local=False,
    )
    return GenericVFS(name="wiki", accessor=WikiAccessor(PAGES), io=io)


@pytest.mark.asyncio
async def test_range_read_translates_the_end_exclusive_window():
    # The VFS API asks for [start, end); the table slot takes an
    # offset and a size. Forwarded raw, the table read `start` as its
    # index and `end` as its offset, so an object store answered from
    # `end` to EOF instead of the window that was asked for.
    vfs = make_range_vfs()
    spec = PathSpec(vfs_path="notes.md", virtual="/notes.md", directory="/")
    assert await vfs.range_read(spec, 7, 12) == b"speak"
    assert RANGE_CALLS[-1][1:] == (7, 5)


@pytest.mark.asyncio
async def test_range_read_receives_the_vfs_index():
    vfs = make_range_vfs()
    spec = PathSpec(vfs_path="notes.md", virtual="/notes.md", directory="/")
    await vfs.range_read(spec, 0, 6)
    assert RANGE_CALLS[-1][0] is vfs.index


@pytest.mark.asyncio
async def test_range_read_follows_a_replaced_index():
    # Read per call, not captured: set_index swaps the store and a
    # captured one would keep serving the store the constructor saw.
    vfs = make_range_vfs()
    spec = PathSpec(vfs_path="notes.md", virtual="/notes.md", directory="/")
    before = vfs.index
    vfs.set_index(IndexConfig(ttl=1))
    assert vfs.index is not before
    await vfs.range_read(spec, 0, 6)
    assert RANGE_CALLS[-1][0] is vfs.index


def test_only_a_reshaped_table_field_is_adapted():
    # The rule range_adapter exists for, rather than the one case: a
    # field forwarded as itself must take its arguments in the order the
    # name it publishes under takes them. read_range is the only field
    # that does not, so it is the only one that may come back wrapped.
    # Arity stands in for shape here, which is what the divergence
    # actually was; a future field that reordered without changing count
    # would need its own case.
    ops = direct_ops(S3_IO, lambda: NULL_INDEX)
    checked = 0
    for op, field in _DIRECT_OPS.items():
        published = S3VFS._ops.get(op)
        table_fn = getattr(S3_IO, field)
        if published is None or table_fn is None:
            continue
        checked += 1
        same_arity = (len(inspect.signature(published).parameters) == len(
            inspect.signature(table_fn).parameters))
        assert (ops[op] is table_fn) is same_arity, op
    assert checked > 5


def test_a_script_registered_vfs_is_named_in_the_read_refusal():
    """`vfs.name` is a plain string here, not a `VFSName`.

    ``str()`` of the enum renders its repr, so the refusal builds the
    name through a getattr fallback; only a script-registered backend
    exercises the other side of it.
    """
    vfs = make_vfs(caches_reads=True)
    assert vfs.READ_REVALIDATABLE is False
    with pytest.raises(ValueError) as exc:
        check_read_capability("/w/", vfs, ReadSpec(policy=ReadPolicy.FRESH))
    assert "wiki does not" in str(exc.value)
