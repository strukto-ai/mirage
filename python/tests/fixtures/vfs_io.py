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
from collections.abc import Awaitable, Callable
from types import SimpleNamespace
from typing import Any

from mirage.accessor.base import Accessor
from mirage.context import Caller
from mirage.io import IOResult
from mirage.types import (
    LINK_TARGET_KEY,
    FileStat,
    FileType,
    MountMode,
    PathSpec,
)
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS
from mirage.view.types import LinkView, MountView
from mirage.workspace import Workspace
from mirage.workspace.mount import MountEntry


class StubAccessor(SimpleNamespace, Accessor):
    """An accessor carrying whatever fields a test hands it, which a mount
    takes as it takes any other."""


def vfs_over(cls: type[BaseVFS], accessor: Accessor) -> BaseVFS:
    """A ``cls`` VFS over ``accessor``, its constructor and config skipped.

    The VFS's functions use only ``self.accessor`` and the class's facts,
    so a test can drive them with an accessor of its own.

    Args:
        cls (type[BaseVFS]): the backend's VFS class.
        accessor (Accessor): the accessor the test built.
    """
    vfs = cls.__new__(cls)
    BaseVFS.__init__(vfs, accessor=accessor)
    return vfs


def call_over(cls: type[BaseVFS], name: str) -> Callable[..., Awaitable[Any]]:
    """The function ``name`` of a ``cls`` VFS, called with an accessor in
    front, the way a test drove a backend's table.

    Keywords the function does not take (an ``index`` handed to a write)
    are dropped.

    Args:
        cls (type[BaseVFS]): the backend's VFS class.
        name (str): the function name.
    """

    async def call(
        accessor: Accessor, path: PathSpec, *args: Any, **kwargs: Any
    ) -> Any:
        method = getattr(vfs_over(cls, accessor), name)
        takes = inspect.signature(method).parameters
        return await method(
            path, *args, **{k: v for k, v in kwargs.items() if k in takes}
        )

    return call


# Every op name the dispatcher sends to a mount.
DISPATCH_OPS = (
    "read",
    "readdir",
    "stat",
    "write",
    "append",
    "pwrite",
    "create",
    "mkdir",
    "unlink",
    "rmdir",
    "rename",
    "truncate",
    "setattr",
)


def served(vfs: BaseVFS) -> set[str]:
    """The op names the dispatcher serves on a mount of ``vfs``.

    Args:
        vfs (BaseVFS): the VFS under test.
    """
    mount = MountEntry("/", vfs)
    return {op for op in DISPATCH_OPS if mount.answers(op)}


def override(vfs: BaseVFS, name: str, fn: Callable[..., Any]) -> BaseVFS:
    """Replace the function ``name`` of this one ``vfs``.

    ``fn`` takes the accessor in front, as a backend's core functions do,
    and the keywords of the caller's that it names.

    Args:
        vfs (BaseVFS): the VFS to change.
        name (str): the function name.
        fn (Callable[..., Any]): the replacement.
    """
    params = inspect.signature(fn).parameters
    takes_any = any(p.kind is p.VAR_KEYWORD for p in params.values())

    def call(path: PathSpec, *args: Any, **kwargs: Any) -> Any:
        taken = {k: v for k, v in kwargs.items() if takes_any or k in params}
        return fn(vfs.accessor, path, *args, **taken)

    setattr(vfs, name, call)
    return vfs


def render(vfs: BaseVFS, filetype: str, fn: Callable[..., Any]) -> BaseVFS:
    """Have this one ``vfs`` render reads of ``filetype`` with ``fn``.

    Args:
        vfs (BaseVFS): the VFS to change.
        filetype (str): the extension, dot included.
        fn (Callable[..., Any]): the renderer, accessor in front.
    """
    name = "render" + filetype.replace(".", "_")
    override(vfs, name, fn)
    vfs.renderers = {**vfs.renderers, filetype: name}
    return vfs


def replaces(
    name: str, filetype: str | None = None
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Mark a test function as a replacement for a VFS function.

    Args:
        name (str): the function it replaces.
        filetype (str | None): the extension a ``read`` replacement
            renders.
    """

    def mark(fn: Callable[..., Any]) -> Callable[..., Any]:
        setattr(fn, "replaces", (name, filetype))
        return fn

    return mark


def install(mount: MountEntry, fns: list[Callable[..., Any]]) -> MountEntry:
    """Register ``fns`` on ``mount``: a function marked by ``replaces``
    takes the place of the VFS function it names, and anything else is a
    command.

    Args:
        mount (MountEntry): the mount to change.
        fns (list[Callable[..., Any]]): replacements and commands.
    """
    commands = []
    for fn in fns:
        marked = getattr(fn, "replaces", None)
        if marked is None:
            commands.append(fn)
        elif marked[1] is not None:
            render(mount.vfs, marked[1], fn)
        else:
            override(mount.vfs, marked[0], fn)
    if commands:
        mount.register_commands(commands)
    return mount


def dispatched(ws: Workspace) -> list[tuple[str, str]]:
    """Record every call the workspace's dispatcher serves from now on,
    by op name and virtual path: where a line's own I/O is judged.

    Args:
        ws (Workspace): the workspace whose dispatcher is watched.
    """
    seen: list[tuple[str, str]] = []
    real = ws._dispatcher._dispatch

    async def recording(
        name: str, path: PathSpec, caller: Caller, /, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        seen.append((name, path.virtual))
        return await real(name, path, caller, **kwargs)

    ws._dispatcher._dispatch = recording
    return seen


class BatchedRAM(RAMVFS):
    """A RAM mount standing in for a remote store: it keeps its reads,
    and reads a batch in one call where ``batched``, counting both."""

    local = False

    def __init__(self, batched: bool = True) -> None:
        super().__init__()
        self.caches_reads = True
        self.batched = batched
        self.reads: list[str] = []
        self.batches: list[list[str]] = []
        self._store.dirs.update({"/", "/secret"})
        self._store.files.update(
            {"/a": b"a\n", "/b": b"b\n", "/secret/c": b"c\n"}
        )

    def supports(self, name: str) -> bool:
        return self.batched if name == "read_many" else super().supports(name)

    async def read(self, path, offset=0, size=None):
        self.reads.append(path.virtual)
        return await super().read(path, offset, size)

    def read_stream(self, path):
        self.reads.append(path.virtual)
        return super().read_stream(path)

    async def read_many(self, paths, limit):
        self.batches.append([path.virtual for path in paths])
        return {
            path.virtual: self._store.files["/" + path.vfs_path.strip("/")]
            for path in paths
        }


async def _missing_target_stat(path: str) -> None:
    return None


def link_view(entries: dict[str, str]) -> LinkView:
    """A link view over a fixed set of targets.

    Args:
        entries (dict[str, str]): virtual link paths and their targets.
    """

    def stat_of(path):
        target = entries[path]
        return FileStat(
            name=path,
            type=FileType.SYMLINK,
            size=len(target),
            extra={LINK_TARGET_KEY: target},
        )

    async def exists(path):
        return path in entries

    return LinkView(
        stat_at=lambda p: stat_of(p) if p in entries else None,
        subtree=lambda p: [
            (k, stat_of(k))
            for k in sorted(entries)
            if k.startswith(p.rstrip("/") + "/")
        ],
        resolve=lambda p: entries.get(p, p),
        exists=exists,
        target_stat=_missing_target_stat,
    )


def mount_view(
    descendants: tuple[str, ...] = (), roots: tuple[str, ...] = ()
) -> MountView:
    """A mount view over fixed roots and descendants.

    Args:
        descendants (tuple[str, ...]): nested mount prefixes.
        roots (tuple[str, ...]): visible mount roots.
    """

    def root_of(path):
        for root in sorted(roots, key=len, reverse=True):
            if path == root or path.startswith(root.rstrip("/") + "/"):
                return root
        return "/"

    return MountView(
        descendants=lambda p: [
            d for d in descendants if d.startswith(p.rstrip("/") + "/")
        ],
        visible_descendants=lambda p: [
            d for d in descendants if d.startswith(p.rstrip("/") + "/")
        ],
        is_root=lambda p: p.rstrip("/") in {r.rstrip("/") for r in roots},
        root_of=root_of,
    )


class OverlayRAM(RAMVFS):
    """RAM VFS with native setattr stripped, standing in for an API
    backend whose chmod/chown/touch live only in the namespace overlay."""

    setattr = BaseVFS.setattr


def metadata_workspace(mode: MountMode = MountMode.WRITE) -> Workspace:
    """A RAM workspace with /data/f.txt for metadata command tests.

    Args:
        mode (MountMode): access mode of the data mount.
    """
    vfs = RAMVFS()
    vfs._store.files["/f.txt"] = b"hello"
    return Workspace({"/data/": (vfs, mode)}, mode=MountMode.WRITE)


async def run_text(ws: Workspace, cmd: str) -> tuple[int, str, str]:
    """Run a shell line and collect its status, stdout, and stderr.

    Args:
        ws (Workspace): workspace under test.
        cmd (str): shell line to run.
    """
    r = await ws.shell(cmd)
    return r.exit_code, await r.stdout_str(), await r.stderr_str()


def overlay_workspace(
    files: dict[str, bytes],
) -> tuple[Workspace, OverlayRAM]:
    """A RAM workspace whose metadata lives in the namespace overlay.

    Args:
        files (dict[str, bytes]): initial files keyed by mount-relative path.
    """
    vfs = OverlayRAM()
    vfs._store.files.update(files)
    ws = Workspace({"/data/": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE)
    return ws, vfs
