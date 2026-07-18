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

import posixpath
from functools import partial

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.sed import sed as generic_sed
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.builtin.generic_bind.provision import make_sed_provision
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


async def _scripts_from_files(ops: CommandIO, accessor: Accessor,
                              index: IndexCacheStore,
                              f_files: list[PathSpec]) -> list[str]:
    """Read each -f script file through the backend reader.

    Args:
        ops (CommandIO): Backend I/O bundle providing ``read_bytes``.
        accessor (Accessor): backend accessor.
        index (IndexCacheStore): optional cache index.
        f_files (list[PathSpec]): -f script-file paths.
    """
    reader = bound_op(ops.read_bytes, accessor, index)
    out: list[str] = []
    for pf in f_files:
        data = await reader(pf)
        text = data.decode(errors="replace")
        if text.endswith("\n"):
            text = text[:-1]
        out.append(text)
    return out


async def sed(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    i: bool = False,
    e: object = None,
    f: object = None,
    n: bool = False,
    E: bool = False,
    r: bool = False,
    cwd: PathSpec | None = None,
    index: IndexCacheStore = NULL_INDEX,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    # The script comes from -e expressions and -f script files (joined
    # with newlines, -e then -f as grep does) when any were given,
    # otherwise from the first positional operand.
    e_list = e if isinstance(e, list) else ([e] if isinstance(e, str) else [])
    f_files = f if isinstance(
        f, list) else ([f] if isinstance(f, PathSpec) else [])
    script_parts = list(e_list) + await _scripts_from_files(
        ops, accessor, index, f_files)
    flag_script = bool(e_list or f_files)
    if not flag_script and texts:
        script_parts.append(texts[0])
    script = "\n".join(script_parts) if script_parts else None
    if script is None:
        raise ValueError("sed: usage: sed EXPRESSION [path]")
    # The default stream-to-stdout path is read-only and works on every
    # backend; only in-place editing needs a write op (#382).
    if i and ops.write is None:
        raise PermissionError("-i not supported on this backend")
    operands = list(paths)
    if flag_script:
        # With -e/-f the positional operand is a file, not the script.
        operands = _positional_as_paths(
            texts, cwd if isinstance(cwd, PathSpec) else None) + operands
    if operands:
        operands = await ops.resolve_glob(accessor, operands, index)
    return await generic_sed(
        operands,
        script,
        read_bytes=bound_op(ops.read_bytes, accessor, index),
        write_bytes=(partial(ops.write, accessor)
                     if ops.write is not None else None),
        stdin=stdin,
        in_place=i,
        suppress=n,
        extended=E or r,
    )


BUILDER = Builder('sed', sed, make_sed_provision)
