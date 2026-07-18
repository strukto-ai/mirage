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

import asyncio
from functools import partial

from mirage import MountMode, Workspace
from mirage.sdk import (NULL_INDEX, Accessor, CommandIO, CommandSpec, FileStat,
                        GenericResource, IndexCacheStore, IOResult, PathSpec,
                        command, register_resource, stream_from_bytes)
from mirage.types import FileType

# A whole custom backend in one script: three async core functions over
# your data source, one CommandIO table, one GenericResource. Every
# generic command (ls, cat, grep, find, head, wc, ...) works for free.

PAGES = {
    "guides": {
        "quickstart.md": "# Quickstart\nMount anything as a filesystem.\n",
        "deploy.md": "# Deploy\nShip the gateway behind HTTP.\n",
    },
    "notes.md": "Remember: agents just speak bash.\n",
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


# Optional: a bespoke domain verb, registered alongside the generics.
@command("wiki_titles", resource="wiki", spec=CommandSpec())
async def wiki_titles(accessor, *texts: str, **flags: object):
    titles = [
        line[2:] for page in ("guides/quickstart.md", "guides/deploy.md")
        for line in _node(accessor.pages, page).splitlines()
        if line.startswith("# ")
    ]
    return ("\n".join(titles) + "\n").encode(), IOResult()


def make_wiki_resource(pages: dict | None = None) -> GenericResource:
    io = CommandIO(
        readdir=readdir,
        read_bytes=read_bytes,
        read_stream=partial(stream_from_bytes, read_bytes),
        stat=stat,
        is_mounted=lambda a: True,
        local=False,
    )
    return GenericResource(
        name="wiki",
        accessor=WikiAccessor(pages or PAGES),
        io=io,
        prompt="A team wiki rendered as markdown files.",
        commands=[wiki_titles],
    )


class WikiResource(GenericResource):
    """Class form, so the backend is constructible by registry name."""

    def __init__(self, pages: dict | None = None) -> None:
        wired = make_wiki_resource(pages)
        self.__dict__.update(wired.__dict__)


async def main():
    ws = Workspace({"/wiki/": make_wiki_resource()}, mode=MountMode.READ)

    for line in (
            "ls /wiki/guides",
            "cat /wiki/notes.md",
            "grep -r Quickstart /wiki/",
            "find /wiki -name '*.md'",
            "wc -l /wiki/guides/quickstart.md",
            "wiki_titles",
    ):
        result = await ws.execute(line)
        print(f"$ {line}\n{await result.stdout_str()}")

    # Registered names work everywhere builtin names do (YAML, snapshots):
    register_resource("wiki", WikiResource)
    print("registered 'wiki' for registry-name construction")


asyncio.run(main())
