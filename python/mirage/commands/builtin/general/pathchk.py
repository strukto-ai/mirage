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
import re

from mirage.accessor.base import Accessor
from mirage.commands.config import Context, command
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.usage import missing_operand_error
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec
from mirage.utils.quote import shell_quote_always

NAME_MAX = 255
PATH_MAX = 4096
PORTABLE_NAME_MAX = 14
PORTABLE_PATH_MAX = 255
NON_PORTABLE = re.compile(rb"[^A-Za-z0-9._/-]")


def _lexical(name: str, portable: bool, dashes: bool) -> str | None:
    """Why a name fails the checks that need no file system.

    Args:
        name (str): the operand.
        portable (bool): ``-p``, the POSIX limits and characters.
        dashes (bool): ``-P``, leading dashes and empty names.
    """
    raw = encode_text(name)
    if not raw and (portable or dashes):
        return "empty file name"
    shown = shell_quote_always(name)
    if dashes and any(p.startswith(b"-") for p in raw.split(b"/")):
        return f"leading '-' in a component of file name {shown}"
    if portable and (bad := NON_PORTABLE.search(raw)) is not None:
        char = quote_text(bad.group(0).decode("utf-8", "surrogateescape"))
        return f"non-portable character '{char}' in file name {shown}"
    if portable and len(raw) > PORTABLE_PATH_MAX:
        return (
            f"limit {PORTABLE_PATH_MAX} exceeded by length {len(raw)} "
            f"of file name {shown}"
        )
    return None


def _long_component(name: str, limit: int) -> tuple[int, bytes] | None:
    """The first component past a length limit, with its index.

    Args:
        name (str): the operand.
        limit (int): the longest a component may be.
    """
    for index, part in enumerate(encode_text(name).split(b"/")):
        if len(part) > limit:
            return index, part
    return None


def _component_refusal(part: bytes, limit: int) -> str:
    shown = shell_quote_always(part.decode("utf-8", "surrogateescape"))
    return (
        f"limit {limit} exceeded by length {len(part)} "
        f"of file name component {shown}"
    )


async def _on_system(ctx: Context, name: str) -> str | None:
    """Why this system refuses a name, or None: too long for a parent that
    exists, past the limits, or under a file.

    Args:
        ctx (Context): the command's context.
        name (str): the operand.
    """
    raw = encode_text(name)
    if not raw:
        return "'': No such file or directory"
    if len(raw) >= PATH_MAX:
        return f"{name}: File name too long"
    long = _long_component(name, NAME_MAX)
    if ctx.vfs is None:
        return None if long is None else _component_refusal(long[1], NAME_MAX)
    if long is not None:
        parent = "/".join(name.split("/")[: long[0]]) or (
            "/" if name.startswith("/") else "."
        )
        spec = PathSpec.from_str_path(parent, cwd=ctx.cwd.virtual)
        if await ctx.vfs.is_dir(spec):
            return f"{name}: File name too long"
        return _component_refusal(long[1], NAME_MAX)
    try:
        await ctx.vfs.stat(PathSpec.from_str_path(name, cwd=ctx.cwd.virtual))
    except FS_ERRORS as exc:
        if isinstance(exc, NotADirectoryError):
            return f"{name}: {fs_strerror(exc)}"
    return None


@command("pathchk", vfs=None, spec=SPECS["pathchk"])
async def pathchk(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Check that names are valid: for this system by default, for every
    POSIX system under ``-p``, for shells under ``-P``. Pinned against
    coreutils 9.7.
    """
    if not texts:
        raise missing_operand_error("pathchk", None)
    fl = FlagView(ctx.flags, spec=SPECS["pathchk"])
    both = fl.as_bool("portability")
    portable = both or fl.as_bool("p")
    dashes = both or fl.as_bool("P")
    err: list[str] = []
    for name in texts:
        why = _lexical(name, portable, dashes)
        long = _long_component(name, PORTABLE_NAME_MAX) if portable else None
        if why is None and long is not None:
            why = _component_refusal(long[1], PORTABLE_NAME_MAX)
        if why is None and not (portable or dashes):
            why = await _on_system(ctx, name)
        if why is not None:
            err.append(f"pathchk: {why}\n")
    if err:
        return None, IOResult(exit_code=1, stderr="".join(err).encode())
    return None, IOResult()
