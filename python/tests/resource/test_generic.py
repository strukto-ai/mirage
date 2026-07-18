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
from mirage.io.types import IOResult
from mirage.resource.generic import GenericResource
from mirage.types import FileStat, FileType, PathSpec

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
    node = _node(accessor.pages, path.resource_path)
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
    node = _node(accessor.pages, path.resource_path)
    if isinstance(node, dict):
        raise IsADirectoryError(path.virtual)
    return node.encode()


async def stat(
    accessor: WikiAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    node = _node(accessor.pages, path.resource_path)
    name = path.virtual.rstrip("/").rsplit("/", 1)[-1] or "/"
    if isinstance(node, dict):
        return FileStat(name=name, size=None, type=FileType.DIRECTORY)
    return FileStat(name=name, size=len(node.encode()), type=FileType.TEXT)


@command("wiki_hello", resource="wiki", spec=CommandSpec())
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


def make_resource(**kwargs) -> GenericResource:
    return GenericResource(name="wiki",
                           accessor=WikiAccessor(PAGES),
                           io=make_io(),
                           **kwargs)


def command_names(resource: GenericResource) -> set[str]:
    return {rc.name for rc in resource.commands()}


def test_generic_commands_registered():
    names = command_names(make_resource())
    assert {"ls", "cat", "grep", "find", "head", "wc"} <= names


def test_write_commands_absent_without_write_op():
    names = command_names(make_resource())
    assert "tee" not in names
    assert "rm" not in names


def test_overrides_suppress_generic():
    names = command_names(make_resource(overrides={"grep"}))
    assert "grep" not in names
    assert "rg" in names


def test_extra_commands_registered():
    names = command_names(make_resource(commands=[wiki_hello]))
    assert "wiki_hello" in names


def test_requires_name():
    with pytest.raises(ValueError):
        GenericResource(name="", accessor=WikiAccessor(PAGES), io=make_io())


def test_get_state():
    assert make_resource().get_state() == {"type": "wiki"}


def test_prompts_set():
    resource = make_resource(prompt="wiki files", write_prompt="writable")
    assert resource.PROMPT == "wiki files"
    assert resource.WRITE_PROMPT == "writable"


@pytest.mark.asyncio
async def test_resolve_glob_uses_io_readdir():
    resource = make_resource()
    spec = PathSpec(resource_path="guides/quick*",
                    virtual="/guides/quick*",
                    directory="/guides",
                    pattern="quick*",
                    resolved=False)
    matches = await resource.resolve_glob([spec])
    assert [m.virtual for m in matches] == ["/guides/quickstart.md"]


@pytest.mark.asyncio
async def test_workspace_execution_end_to_end():
    ws = Workspace({"/wiki/": make_resource(commands=[wiki_hello])},
                   mode=MountMode.READ)

    result = await ws.execute("ls /wiki/guides")
    assert "quickstart.md" in await result.stdout_str()

    result = await ws.execute("cat /wiki/notes.md")
    assert await result.stdout_str() == "agents speak bash\n"

    result = await ws.execute("grep -r Quickstart /wiki/")
    assert "/wiki/guides/quickstart.md:# Quickstart" in (await
                                                         result.stdout_str())

    result = await ws.execute("find /wiki -name '*.md'")
    out = await result.stdout_str()
    assert "/wiki/guides/quickstart.md" in out
    assert "/wiki/notes.md" in out

    result = await ws.execute("wiki_hello")
    assert await result.stdout_str() == "hello custom verb\n"


def test_auto_ops_derived_from_table():
    resource = make_resource()
    names = {(ro.name, ro.write) for ro in resource.ops_list()}
    assert names == {("read", False), ("readdir", False), ("stat", False)}


def test_auto_ops_disabled():
    resource = make_resource(auto_ops=False)
    assert resource.ops_list() == []


def test_user_ops_shadow_derived():
    from mirage.ops.registry import RegisteredOp

    async def my_read(accessor, path, *, index=None, **kwargs):
        return b"custom"

    custom = RegisteredOp(name="read",
                          resource="wiki",
                          filetype=None,
                          fn=my_read)
    resource = make_resource(ops=[custom])
    reads = [ro for ro in resource.ops_list() if ro.name == "read"]
    assert len(reads) == 1
    assert reads[0].fn is my_read
