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
from typing import Any

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.adapter import CommandIO, command_io
from mirage.types import PathSpec
from mirage.vfs.base import BaseVFS
from mirage.workspace.mount import MountEntry


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


def io_for(cls: type[BaseVFS], accessor: Accessor) -> CommandIO:
    """The command table of a ``cls`` VFS over ``accessor``.

    Args:
        cls (type[BaseVFS]): the backend's VFS class.
        accessor (Accessor): the accessor the test built.
    """
    return command_io(vfs_over(cls, accessor))


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


# Every op name the door dispatches to a mount.
DOOR_OPS = (
    "read",
    "readdir",
    "stat",
    "glob",
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
    """The op names the door serves on a mount of ``vfs``.

    Args:
        vfs (BaseVFS): the VFS under test.
    """
    mount = MountEntry("/", vfs)
    return {op for op in DOOR_OPS if mount.has_op(op)}


def override(vfs: BaseVFS, name: str, fn: Callable[..., Any]) -> BaseVFS:
    """Replace the function ``name`` of this one ``vfs``.

    ``fn`` takes the accessor in front, as a backend's core functions do,
    and whatever keywords the caller passes.

    Args:
        vfs (BaseVFS): the VFS to change.
        name (str): the function name.
        fn (Callable[..., Any]): the replacement.
    """

    def call(path: PathSpec, *args: Any, **kwargs: Any) -> Any:
        return fn(vfs.accessor, path, *args, **kwargs)

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


def override_glob(mount: MountEntry, fn: Callable[..., Any]) -> MountEntry:
    """Replace how one ``mount`` expands a glob pattern.

    ``fn`` takes the accessor in front and the pattern spec, as the glob
    op's handler did; the mount stamps the spec's key before calling it.

    Args:
        mount (MountEntry): the mount to change.
        fn (Callable[..., Any]): the replacement.
    """

    async def glob(path: PathSpec, index: Any = None) -> Any:
        return await fn(mount.vfs.accessor, path, index=index)

    mount._glob = glob  # type: ignore[method-assign]
    return mount


def replaces(
    name: str, filetype: str | None = None
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Mark a test function as a replacement for a VFS function.

    Args:
        name (str): the function it replaces (``glob`` for the mount's).
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
        elif marked[0] == "glob":
            override_glob(mount, fn)
        elif marked[1] is not None:
            render(mount.vfs, marked[1], fn)
        else:
            override(mount.vfs, marked[0], fn)
    if commands:
        mount.register_fns(commands)
    return mount
