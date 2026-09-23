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

from functools import partial

import pytest

from mirage import MountMode, Workspace
from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic_bind import CommandIO
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.commands.config import command
from mirage.commands.spec import CommandSpec
from mirage.commands.spec.types import FlagValue
from mirage.io.types import IOResult
from mirage.ops.registry import RegisteredOp
from mirage.types import (CapacityState, ContentType, FileStat, FileType,
                          PathSpec, ReadPolicy, ReadSpec)
from mirage.vfs.base import BaseVFS
from mirage.workspace.mount.read_policy import check_read_capability

PAGES = {
    "guides": {
        "quickstart.md": "# Quickstart\nHello.\n",
    },
    "notes.md": "agents speak bash\n",
}


class ClosingAccessor(Accessor):

    def __init__(self) -> None:
        self.close_calls = 0

    async def close(self) -> None:
        self.close_calls += 1


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
async def wiki_hello(accessor, *texts: str, **flags: FlagValue):
    return b"hello custom verb\n", IOResult()


async def my_read(accessor, path, *, index=None, **kwargs):
    return b"custom"


def make_io() -> CommandIO:
    return CommandIO(
        readdir=readdir,
        read_bytes=read_bytes,
        read_stream=partial(stream_from_bytes, read_bytes),
        stat=stat,
        is_mounted=lambda a: True,
        local=False,
    )


def make_vfs(**kwargs) -> BaseVFS:
    return BaseVFS(name="wiki",
                   accessor=WikiAccessor(PAGES),
                   io=make_io(),
                   **kwargs)


def command_names(vfs: BaseVFS) -> set[str]:
    return {rc.name for rc in vfs.commands()}


class Marker:

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.marked = True


class Mixed(BaseVFS, Marker):
    pass


def test_init_is_cooperative():
    assert Mixed().marked is True


def test_missing_accessor_attribute_raises():
    with pytest.raises(AttributeError):
        Accessor().missing_operation


def test_base_serves_no_tables():
    vfs = BaseVFS()
    assert vfs.ops() == []
    assert vfs.commands() == []


def test_base_has_no_storage_location():
    assert BaseVFS().storage_location() is None


@pytest.mark.asyncio
async def test_base_capacity_is_unknown():
    cap = await BaseVFS().capacity()
    assert cap.state == CapacityState.UNKNOWN


def test_base_has_no_delta_hook():
    assert BaseVFS().delta_hook() is None


def test_base_state_is_the_type():
    vfs = BaseVFS()
    assert vfs.get_state() == {"type": "base"}
    vfs.load_state({"type": "base"})


@pytest.mark.asyncio
async def test_close_releases_accessor_once():
    vfs = BaseVFS()
    accessor = ClosingAccessor()
    vfs.accessor = accessor

    assert not vfs.is_closed
    await vfs.close()
    await vfs.close()

    assert accessor.close_calls == 1
    assert vfs.is_closed


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
        BaseVFS(name="", accessor=WikiAccessor(PAGES), io=make_io())


def test_tables_need_io():
    with pytest.raises(ValueError, match="pass io"):
        BaseVFS(name="wiki", commands=[wiki_hello])


def test_table_built_state_asks_to_be_handed_back():
    assert make_vfs().get_state() == {
        "type": "wiki",
        "needs_override": True,
    }


def test_declaration_flags_forwarded():
    vfs = make_vfs(sizes_always_known=True,
                   supports_snapshot=True,
                   read_revalidatable=True)
    assert vfs.sizes_always_known is True
    assert vfs.supports_snapshot is True
    assert vfs.read_revalidatable is True


def test_declaration_flags_default_off():
    vfs = make_vfs()
    assert vfs.sizes_always_known is False
    assert vfs.supports_snapshot is False
    assert vfs.read_revalidatable is False


def test_prompts_set():
    vfs = make_vfs(prompt="wiki files", write_prompt="writable")
    assert vfs.prompt == "wiki files"
    assert vfs.write_prompt == "writable"


@pytest.mark.asyncio
async def test_glob_op_derived_from_io_readdir():
    vfs = make_vfs()
    spec = PathSpec(vfs_path="guides/quick*",
                    virtual="/guides/quick*",
                    directory="/guides",
                    pattern="quick*",
                    resolved=False)
    glob = next(ro for ro in vfs.ops() if ro.name == "glob")
    matches = await glob.fn(vfs.accessor, spec, index=NULL_INDEX)
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
    names = {(ro.name, ro.write) for ro in vfs.ops()}
    assert names == {("glob", False), ("read", False), ("readdir", False),
                     ("stat", False)}


def test_auto_ops_disabled():
    vfs = make_vfs(auto_ops=False)
    assert vfs.ops() == []


def test_user_ops_shadow_derived():
    custom = RegisteredOp(name="read", vfs="wiki", filetype=None, fn=my_read)
    vfs = make_vfs(ops=[custom])
    reads = [ro for ro in vfs.ops() if ro.name == "read"]
    assert len(reads) == 1
    assert reads[0].fn is my_read


def test_a_script_registered_vfs_is_named_in_the_read_refusal():
    """`vfs.name` is a plain string here, not a `VFSName`.

    ``str()`` of the enum renders its repr, so the refusal builds the
    name through a getattr fallback; only a script-registered backend
    exercises the other side of it.
    """
    vfs = make_vfs(caches_reads=True)
    assert vfs.read_revalidatable is False
    with pytest.raises(ValueError) as exc:
        check_read_capability("/w/", vfs, ReadSpec(policy=ReadPolicy.FRESH))
    assert "wiki does not" in str(exc.value)
