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
"""Factory for the per-backend ``sed`` commands.

Every backend's ``sed`` is the same logic over the generic engine, differing
only in how bytes are read, whether globs are resolved (and under what
condition), whether the mount is writable, and the ``-i`` rejection.
``make_sed`` captures that so each backend is a small config instead of a
copy-pasted body.
"""

import posixpath
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.sed import sed as generic_sed
from mirage.commands.builtin.generic_bind.provision import make_sed_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of


def _positional_as_paths(texts: tuple[str, ...],
                         cwd: PathSpec | None) -> list[PathSpec]:
    """Treat positional operands as files (GNU rule when -e/-f give script).

    The arg parser routes the first bare arg into the positional ``text``
    (script) slot, so recover it as a path operand carrying the mount prefix.

    Args:
        texts (tuple[str, ...]): positional operands that are really files.
        cwd (PathSpec | None): current directory for relative resolution.
    """
    base = cwd.virtual if cwd is not None else "/"
    prefix = (mount_prefix_of(cwd.virtual, cwd.resource_path)
              if cwd is not None else "")
    out: list[PathSpec] = []
    for t in texts:
        resolved = (posixpath.normpath(t) if t.startswith("/") else
                    posixpath.normpath(posixpath.join(base, t)))
        slash = resolved.rfind("/")
        out.append(
            PathSpec(
                virtual=resolved,
                directory=resolved[:slash + 1] if slash >= 0 else "/",
                resolved=True,
                resource_path=mount_key(resolved, prefix),
            ))
    return out


# (accessor, index, resolved_paths) -> read_bytes callable for generic_sed.
MakeRead = Callable[[object, IndexCacheStore | None, list[PathSpec]], Callable]
# (accessor, index) -> whether to resolve globs (paths already known truthy).
GlobWhen = Callable[[object, IndexCacheStore | None], bool]


async def _scripts_from_files(
    make_read: MakeRead,
    accessor: object,
    index: IndexCacheStore | None,
    f_files: list[PathSpec],
) -> list[str]:
    """Read each -f script file through the backend reader.

    Args:
        make_read (MakeRead): builds the backend read_bytes callable.
        accessor (object): backend accessor.
        index (IndexCacheStore | None): optional cache index.
        f_files (list[PathSpec]): -f script-file paths.
    """
    out: list[str] = []
    for pf in f_files:
        reader = make_read(accessor, index, [pf])
        data = await reader(accessor, pf)
        text = data.decode(errors="replace")
        if text.endswith("\n"):
            text = text[:-1]
        out.append(text)
    return out


def make_sed(
    *,
    resource: str | list[str],
    glob_fn: Callable[..., Awaitable[list[PathSpec]]],
    make_read: MakeRead,
    glob_when: GlobWhen | None = None,
    write_bytes: Callable[..., Awaitable[None]] | None = None,
    inplace_error: tuple[type[Exception], str] | None = None,
    stat_fn: Callable | None = None,
) -> Callable:

    @command(
        "sed",
        resource=resource,
        spec=SPECS["sed"],
        provision=make_sed_provision(stat_fn) if stat_fn is not None else None)
    async def sed(
        accessor: object,
        paths: list[PathSpec],
        *texts: str,
        stdin: AsyncIterator[bytes] | bytes | None = None,
        i: bool = False,
        e: object = None,
        f: object = None,
        n: bool = False,
        E: bool = False,
        index: IndexCacheStore = None,
        **_extra: object,
    ) -> tuple[ByteSource | None, IOResult]:
        # The script comes from -e expressions and -f script files (joined
        # with newlines, -e then -f as grep does) when any were given,
        # otherwise from the first positional operand.
        e_list = e if isinstance(e,
                                 list) else ([e] if isinstance(e, str) else [])
        f_files = f if isinstance(
            f, list) else ([f] if isinstance(f, PathSpec) else [])
        script_parts = list(e_list) + await _scripts_from_files(
            make_read, accessor, index, f_files)
        flag_script = bool(e_list or f_files)
        if not flag_script and texts:
            script_parts.append(texts[0])
        script = "\n".join(script_parts) if script_parts else None
        if script is None:
            raise ValueError("sed: usage: sed EXPRESSION [path]")
        if inplace_error is not None and i:
            exc_type, message = inplace_error
            raise exc_type(message)
        operands = list(paths)
        if flag_script:
            # With -e/-f the positional operand is a file, not the script.
            cwd = _extra.get("cwd")
            operands = _positional_as_paths(
                texts, cwd if isinstance(cwd, PathSpec) else None) + operands
        if operands and (glob_when is None or glob_when(accessor, index)):
            operands = await glob_fn(accessor, operands, index)
        elif inplace_error is None:
            # Writable mounts treat a non-glob invocation as stdin mode; the
            # read-only mounts leave the operands untouched (mirroring the
            # original per-backend wrappers).
            operands = []
        return await generic_sed(
            operands,
            script,
            read_bytes=make_read(accessor, index, operands),
            write_bytes=write_bytes,
            accessor=accessor,
            stdin=stdin,
            in_place=i,
            suppress=n,
            extended=E or bool(_extra.get("r", False)),
            index=index,
        )

    return sed


__all__ = ["make_sed"]
