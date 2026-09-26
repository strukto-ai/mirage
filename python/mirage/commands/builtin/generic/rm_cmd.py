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

from collections.abc import Awaitable, Callable
from typing import Any

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.adapter import with_write_guards
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import FS_ERRORS, fs_strerror


def rm_without_operands(force: bool) -> tuple[ByteSource | None, IOResult]:
    """rm's answer to a line with no operand, in GNU's words: nothing at
    all under ``-f``, and a missing-operand usage error otherwise
    (coreutils 9.7).

    Args:
        force (bool): ``-f``, under which a missing operand is no error.

    Raises:
        UsageError: without ``-f``.
    """
    if force:
        return None, IOResult()
    raise UsageError(
        "rm: missing operand\nTry 'rm --help' for more information.", 1)


def make_rm(
    *,
    vfs: str,
    glob_fn: Callable[..., Awaitable[list[PathSpec]]],
    unlink: Callable[..., Awaitable[None]],
) -> Callable[..., Any]:
    """Build a file-only ``rm`` over an index-threaded unlink.

    For backends whose unlink resolves ids through the cache index; the
    factory rm builder calls ``ops.unlink(path)`` without an
    index, so those backends bind this wrapper instead. The unlink is
    wrapped with the same hidden/rule/mode chain the factory gives the
    generic rm's slots, so this family enforces the session's path
    axis like the command it stands in for.

    Args:
        vfs (str): VFS name the command registers under.
        glob_fn (Callable): backend resolve_glob ``(accessor, paths,
            index)``.
        unlink (Callable): backend unlink ``(accessor, path, index)``.
    """
    unlink = with_write_guards(unlink)

    @command("rm", vfs=vfs, spec=SPECS["rm"], write=True, path_guarded=True)
    async def rm(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        opts: CommandOpts,
    ) -> tuple[ByteSource | None, IOResult]:
        fl = FlagView(opts.flags, spec=SPECS["rm"])
        f = fl.as_bool("f")
        v = fl.as_bool("v")
        if not paths:
            return rm_without_operands(f)
        paths = await glob_fn(accessor, paths, opts.index)
        verbose_parts: list[str] = []
        errors: list[str] = []
        removed: dict[str, ByteSource] = {}
        for p in paths:
            try:
                await unlink(accessor, p, opts.index)
            except FS_ERRORS as exc:
                if f and isinstance(exc,
                                    (FileNotFoundError, NotADirectoryError)):
                    continue
                # GNU rm reports the operand and keeps removing the rest.
                errors.append(
                    f"rm: cannot remove '{p.virtual}': {fs_strerror(exc)}")
                continue
            except ValueError:
                if f:
                    continue
                errors.append(f"rm: cannot remove '{p.virtual}': "
                              "No such file or directory")
                continue
            removed[p.mount_path] = b""
            if v:
                verbose_parts.append(f"removed '{p.virtual}'")
        output = format_optional_records(verbose_parts) if v else None
        stderr = ("\n".join(errors) + "\n").encode() if errors else None
        return output, IOResult(writes=removed,
                                stderr=stderr,
                                exit_code=1 if errors else 0)

    return rm
