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
from pathlib import Path

from mirage import (
    NULL_INDEX,
    Accessor,
    BaseVFS,
    CommandSpec,
    ContentType,
    FileStat,
    FileType,
    IndexCacheStore,
    IOResult,
    MountMode,
    PathSpec,
    Workspace,
    command,
    register_vfs,
)
from mirage.utils.key_prefix import mounted_path

# A whole custom backend in one script: a BaseVFS whose methods answer
# over your data source. readdir, read and stat are enough for every
# generic command (ls, cat, grep, find, head, wc, ...); write and mkdir
# make the mount writable. Versioning works too, in the shape the content
# calls for: the wiki's pages are the VFS's own, so they ride its state
# and a snapshot rebuilds the mount through the registered name with the
# pages as they were; the feed's live in a service, so the VFS is only
# observed and a load asks for it back rather than restoring a copy.

PAGES = {
    "guides": {
        "quickstart.md": "# Quickstart\nMount anything as a filesystem.\n",
        "deploy.md": "# Deploy\nShip the gateway behind HTTP.\n",
    },
    "notes.md": "Remember: agents just speak bash.\n",
}


class WikiAccessor(Accessor):
    def __init__(self, pages: dict, known_sizes: bool = True) -> None:
        self.pages = pages
        self.known_sizes = known_sizes


def _node(pages: dict, key: str):
    node = pages
    for part in [p for p in key.split("/") if p]:
        if not isinstance(node, dict) or part not in node:
            raise FileNotFoundError(key)
        node = node[part]
    return node


def _pages(pages: dict, prefix: str = ""):
    for name, child in pages.items():
        if isinstance(child, dict):
            yield from _pages(child, f"{prefix}{name}/")
        else:
            yield f"{prefix}{name}", child


class PagesVFS(BaseVFS):
    """Markdown pages read from the accessor's dict."""

    accessor: WikiAccessor

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        node = _node(self.accessor.pages, path.vfs_path)
        if not isinstance(node, dict):
            raise NotADirectoryError(path.virtual)
        parent = path.virtual.rstrip("/")
        return [
            f"{parent}/{name}" + ("/" if isinstance(child, dict) else "")
            for name, child in node.items()
        ]

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        # reads_ranges stays False, so a byte window is cut from the whole
        # page for us and offset and size can be ignored here.
        node = _node(self.accessor.pages, path.vfs_path)
        if isinstance(node, dict):
            raise IsADirectoryError(path.virtual)
        return node.encode()

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        node = _node(self.accessor.pages, path.vfs_path)
        name = path.virtual.rstrip("/").rsplit("/", 1)[-1] or "/"
        if isinstance(node, dict):
            return FileStat(name=name, size=None, type=FileType.DIRECTORY)
        data = node.encode()
        # The fingerprint is the content's own hash: the stable identity a
        # snapshot records for every read and a load checks for drift.
        return FileStat(
            name=name,
            size=len(data) if self.accessor.known_sizes else None,
            type=FileType.FILE,
            content=ContentType.TEXT,
            fingerprint=hashlib.sha256(data).hexdigest()[:16],
        )

    # Optional: say which pages may hold a text, and grep and rg read
    # only those. What they print is unchanged; None reads every page.
    # mounted_path names a page key at the prefix the walk runs under.
    async def files_containing(
        self,
        text: str,
        under: list[PathSpec],
        *,
        whole_word: bool,
        ignore_case: bool,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[PathSpec]:
        fold = str.lower if ignore_case else str
        return [
            mounted_path(under[0], "/" + key)
            for key, page in _pages(self.accessor.pages)
            if fold(text) in fold(page)
        ]


# Optional: a bespoke domain verb, registered alongside the generics.
@command("wiki_titles", vfs="wiki", spec=CommandSpec())
async def wiki_titles(accessor, paths, texts, opts):
    titles = [
        line[2:]
        for page in ("guides/quickstart.md", "guides/deploy.md")
        for line in _node(accessor.pages, page).splitlines()
        if line.startswith("# ")
    ]
    return ("\n".join(titles) + "\n").encode(), IOResult()


class WikiVFS(PagesVFS):
    """The writable backend, a class so the registry can build it by name."""

    def __init__(self, pages: dict | None = None) -> None:
        # A copy, so a live workspace and one loaded from its snapshot
        # never share pages.
        self.wiki = WikiAccessor(deepcopy(PAGES if pages is None else pages))
        super().__init__(
            name="wiki",
            accessor=self.wiki,
            prompt="A team wiki rendered as markdown files.",
            commands=[wiki_titles],
            supports_snapshot=True,
        )

    async def write(self, path: PathSpec, data: bytes) -> None:
        *folders, name = (p for p in path.vfs_path.split("/") if p)
        node = self.wiki.pages
        for part in folders:
            node = node.setdefault(part, {})
            if not isinstance(node, dict):
                raise NotADirectoryError(path.virtual)
        node[name] = data.decode()

    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        parts = [p for p in path.vfs_path.split("/") if p]
        node = self.wiki.pages
        for i, part in enumerate(parts):
            leaf = i == len(parts) - 1
            if part not in node:
                if not leaf and not parents:
                    raise FileNotFoundError(path.virtual)
                node[part] = {}
            elif leaf and (not parents or not isinstance(node[part], dict)):
                raise FileExistsError(path.virtual)
            node = node[part]
            if not isinstance(node, dict):
                raise NotADirectoryError(path.virtual)
        if not parts and not parents:
            raise FileExistsError(path.virtual)

    # The pages are this VFS's own content, not a remote backend's,
    # so they ride its state: a snapshot or a version rebuilds the mount
    # with them and nothing has to be handed back by hand. A backend over
    # a remote service keeps the default state instead and is only
    # observed, through the fingerprints its stat reports.
    def get_state(self) -> dict:
        return {"type": self.name, "pages": deepcopy(self.wiki.pages)}

    def load_state(self, state: dict) -> None:
        self.wiki.pages = deepcopy(state.get("pages", {}))


# The other half of the design: content that lives in a remote service.
# This dict stands in for that service. The VFS holds no copy of
# it and keeps the default state, which says the mount has to be handed
# back live, so a snapshot pins what it read (through the fingerprints
# stat reports) and a load without the live VFS is refused rather
# than answered with an empty mount. Nothing registers it: a mount that
# is handed back needs no name in any registry. It defines no write, so
# the mount is read-only.
FEED = {"status.md": "All systems go.\n"}


class FeedVFS(PagesVFS):
    def __init__(self) -> None:
        super().__init__(
            name="feed",
            accessor=WikiAccessor(FEED, known_sizes=False),
            prompt="A status feed rendered as markdown.",
            supports_snapshot=True,
        )


async def show(ws: Workspace, line: str, prompt: str = "$") -> None:
    result = await ws.shell(line)
    out = await result.stdout_str()
    if result.exit_code != 0:
        out = f"{await result.stderr_str()}exit {result.exit_code}\n"
    print(f"{prompt} {line}\n{out}", flush=True)


async def main():
    # Registered up front: the name is what a snapshot rebuilds the
    # mount through, the same way workspace YAML names it.
    register_vfs("wiki", WikiVFS)
    ws = Workspace(
        {
            "/wiki/": WikiVFS(),
            "/nested/wiki/": (WikiVFS(), MountMode.READ),
            "/feed/": FeedVFS(),
        },
        mode=MountMode.WRITE,
    )

    for line in (
        "ls /wiki/guides",
        "cat /wiki/notes.md",
        "grep -r Quickstart /wiki/",
        "find /wiki -name '*.md'",
        "wc -l /wiki/guides/quickstart.md",
        "wiki_titles",
        "cat /wiki/missing.md",
        "cat /feed/status.md",
        "cat /wiki/guides/*.md",
        "cat /nested/wiki/notes.md",
        "echo changed > /nested/wiki/notes.md",
        "cat /nested/wiki/notes.md",
        "wc -c /feed/status.md",
        "rm /feed/status.md",
        "gzip -c /feed/status.md | gunzip",
        "mkdir /wiki/new/child",
        "test ! -e /wiki/new && echo no-partial-parent",
        "mkdir -p /wiki/new/child",
        "mkdir /wiki/new/child",
        "mkdir -p /wiki/new/child",
        "mkdir -p /wiki/notes.md/child",
        "mkdir /wiki/guides/empty",
        "cp -r /wiki/guides /wiki/copied",
        "ls /wiki/copied",
        "cat /wiki/copied/quickstart.md",
        "rm -r /wiki/copied /wiki/notes.md",
        "rm -d /wiki/copied/empty /wiki/notes.md",
        "cp -r /nested/wiki/guides /nested/wiki/copied",
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
    restored = await Workspace.load(tar, mounts={"/feed/": FeedVFS()})
    print("load: ok with /feed/ handed back\n", flush=True)
    await show(ws, "cat /wiki/runbook.md", prompt="live$")
    await show(restored, "cat /wiki/runbook.md", prompt="restored$")
    await show(restored, "cat /feed/status.md", prompt="restored$")

    await restored.close()
    await ws.close()


asyncio.run(main())
