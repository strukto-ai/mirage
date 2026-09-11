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
import hashlib
import tempfile
from copy import deepcopy
from functools import partial
from pathlib import Path

from mirage import (NULL_INDEX, Accessor, CommandIO, CommandSpec, ContentType,
                    FileStat, FileType, GenericResource, IndexCacheStore,
                    IOResult, MountMode, PathSpec, Workspace, command,
                    register_resource, stream_from_bytes)

# A whole custom backend in one script: four async core functions over
# your data source, one CommandIO table, one GenericResource. Every
# generic command (ls, cat, grep, find, head, wc, ...) works for free,
# and so does versioning, in the shape the content calls for: the wiki's
# pages are the resource's own, so they ride its state and a snapshot
# rebuilds the mount through the registered name with the pages as they
# were; the feed's live in a service, so the resource is only observed
# and a load asks for it back rather than restoring a copy.

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
    data = node.encode()
    # The fingerprint is the content's own hash: the stable identity a
    # snapshot records for every read and a load checks for drift.
    return FileStat(name=name,
                    size=len(data),
                    type=FileType.FILE,
                    content=ContentType.TEXT,
                    fingerprint=hashlib.sha256(data).hexdigest()[:16])


async def write(accessor: WikiAccessor, path: PathSpec, data: bytes) -> None:
    *folders, name = (p for p in path.resource_path.split("/") if p)
    node = accessor.pages
    for part in folders:
        node = node.setdefault(part, {})
        if not isinstance(node, dict):
            raise NotADirectoryError(path.virtual)
    node[name] = data.decode()


# Optional: a bespoke domain verb, registered alongside the generics.
@command("wiki_titles", resource="wiki", spec=CommandSpec())
async def wiki_titles(accessor, *texts: str, **flags: object):
    titles = [
        line[2:] for page in ("guides/quickstart.md", "guides/deploy.md")
        for line in _node(accessor.pages, page).splitlines()
        if line.startswith("# ")
    ]
    return ("\n".join(titles) + "\n").encode(), IOResult()


def make_io() -> CommandIO:
    return CommandIO(
        readdir=readdir,
        read_bytes=read_bytes,
        read_stream=partial(stream_from_bytes, read_bytes),
        stat=stat,
        write=write,
        is_mounted=lambda a: True,
        local=False,
    )


class WikiResource(GenericResource):
    """The backend as a class, so the registry can build it by name."""

    def __init__(self, pages: dict | None = None) -> None:
        # A copy, so a live workspace and one loaded from its snapshot
        # never share pages.
        self.wiki = WikiAccessor(deepcopy(PAGES if pages is None else pages))
        super().__init__(
            name="wiki",
            accessor=self.wiki,
            io=make_io(),
            prompt="A team wiki rendered as markdown files.",
            commands=[wiki_titles],
            supports_snapshot=True,
        )

    # The pages are this resource's own content, not a remote backend's,
    # so they ride its state: a snapshot or a version rebuilds the mount
    # with them and nothing has to be handed back by hand. A backend over
    # a remote service keeps the default state instead and is only
    # observed, through the fingerprints its stat reports.
    def get_state(self) -> dict:
        return {"type": self.name, "pages": deepcopy(self.wiki.pages)}

    def load_state(self, state: dict) -> None:
        self.wiki.pages = deepcopy(state.get("pages", {}))


# The other half of the design: content that lives in a remote service.
# This dict stands in for that service. The resource holds no copy of
# it and keeps the default state, which says the mount has to be handed
# back live, so a snapshot pins what it read (through the fingerprints
# stat reports) and a load without the live resource is refused rather
# than answered with an empty mount. Nothing registers it: a mount that
# is handed back needs no name in any registry.
FEED = {"status.md": "All systems go.\n"}


class FeedResource(GenericResource):

    def __init__(self) -> None:
        super().__init__(name="feed",
                         accessor=WikiAccessor(FEED),
                         io=make_io(),
                         prompt="A status feed rendered as markdown.",
                         supports_snapshot=True)


async def show(ws: Workspace, line: str, prompt: str = "$") -> None:
    result = await ws.execute(line)
    out = await result.stdout_str()
    if result.exit_code != 0:
        out = f"{await result.stderr_str()}exit {result.exit_code}\n"
    print(f"{prompt} {line}\n{out}", flush=True)


async def main():
    # Registered up front: the name is what a snapshot rebuilds the
    # mount through, the same way workspace YAML names it.
    register_resource("wiki", WikiResource)
    ws = Workspace({
        "/wiki/": WikiResource(),
        "/feed/": FeedResource()
    },
                   mode=MountMode.WRITE)

    for line in (
            "ls /wiki/guides",
            "cat /wiki/notes.md",
            "grep -r Quickstart /wiki/",
            "find /wiki -name '*.md'",
            "wc -l /wiki/guides/quickstart.md",
            "wiki_titles",
            "cat /wiki/missing.md",
            "cat /feed/status.md",
    ):
        await show(ws, line)

    # The pages are versioned state: write one, snapshot, change it, and
    # the workspace loaded from the snapshot serves the page as it was
    # while the live one keeps the change. The registered name rebuilds
    # /wiki/ with no override; /feed/ is only observed, so a load that
    # does not hand it back is refused, naming the mount, and never
    # restores it as an empty directory.
    await show(ws, "echo '# Runbook' > /wiki/runbook.md")
    tar = Path(tempfile.mkdtemp(prefix="wiki-")) / "wiki.tar"
    await ws.snapshot(tar)
    await show(ws, "echo '# Runbook, revised' > /wiki/runbook.md")
    try:
        await Workspace.load(tar)
    except ValueError as exc:
        assert "/feed/" in str(exc)
        print("load: refused, /feed/ must be handed back live", flush=True)
    else:
        raise AssertionError("a load without /feed/ was not refused")
    restored = await Workspace.load(tar, resources={"/feed/": FeedResource()})
    print("load: ok with /feed/ handed back\n", flush=True)
    await show(ws, "cat /wiki/runbook.md", prompt="live$")
    await show(restored, "cat /wiki/runbook.md", prompt="restored$")
    await show(restored, "cat /feed/status.md", prompt="restored$")

    await restored.close()
    await ws.close()


asyncio.run(main())
