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

from collections.abc import AsyncIterator

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    dir_aware_stat,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.operands import operands_io, per_operand
from mirage.commands.builtin.utils.stream import stdin_stat, stdin_stream
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.standard import help_page
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import fs_error_line
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import close_stream, open_stream, run_stream
from mirage.shell.bytes import byte_view, encode_text, from_byte_view
from mirage.types import FileType, JsonValue, PathSpec, StatFn
from mirage.utils.quote import shell_quote_always


def _usage_block() -> str:
    """mirage's strings usage, from its ``Usage:`` line on, which binutils
    prints for an encoding or a radix it cannot read."""
    page = help_page("strings", SPECS["strings"]).decode()
    return page[page.index("Usage: ") :]


def _engine_config(fl: FlagView) -> dict[str, JsonValue] | None:
    """The engine's configuration, or None for an encoding or a radix
    binutils refuses.

    Args:
        fl (FlagView): the line's flags.
    """
    encoding = fl.as_str("encoding")
    order = fl.typed_order("radix", "o")
    radix = "o" if order[-1:] == ["o"] else fl.as_str("radix")
    if encoding is not None and (
        len(encoding) != 1 or encoding not in "sSblBL"
    ):
        return None
    if radix is not None and (len(radix) != 1 or radix not in "odx"):
        return None
    min_len = fl.as_text("bytes")
    separator = fl.as_text("output_separator")
    return {
        "min_len": min_len and byte_view(min_len),
        "encoding": encoding,
        "radix": radix,
        "whitespace": fl.as_bool("include_all_whitespace"),
        "separator": None if separator is None else byte_view(separator),
    }


async def _readable(
    paths: list[PathSpec], stat: StatFn
) -> tuple[list[PathSpec], bytes]:
    """The operands strings reads, and its lines for the rest, worded as
    binutils words them: a missing file is ``No such file`` and a
    directory is a warning.

    Args:
        paths (list[PathSpec]): the operands.
        stat (StatFn): their stat.
    """
    readable: list[PathSpec] = []
    err = ""
    for path in paths:
        shown = shell_quote_always(path.raw_path or path.virtual)
        try:
            found = await stat(path)
        except FileNotFoundError:
            err += f"strings: {shown}: No such file\n"
            continue
        except IsADirectoryError:
            err += f"strings: Warning: {shown} is a directory\n"
            continue
        except FS_ERRORS as exc:
            err += fs_error_line("strings", path, exc)
            continue
        if found.type == FileType.DIRECTORY:
            err += f"strings: Warning: {shown} is a directory\n"
            continue
        readable.append(path)
    return readable, encode_text(err)


async def strings(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, spec=SPECS["strings"])
    config = _engine_config(fl)
    if config is None:
        return None, IOResult(exit_code=1, stderr=_usage_block().encode())
    # The engine refuses -n before any operand is touched, as binutils does.
    try:
        await close_stream(open_stream("strings", config))
    except StreamRefusal as refusal:
        return None, IOResult(
            exit_code=1, stderr=from_byte_view(f"{refusal.message}\n")
        )
    files = command_files(ctx, paths)
    resolved = await resolve_or_empty(files, paths)
    # binutils strings never reads `-` as stdin; only /dev/stdin is.
    stat = stdin_stat(dir_aware_stat(files, ctx), dash=False)
    readable, err = await _readable(resolved, stat)
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    io = operands_io(err)
    read = stdin_stream(files.read, ctx.stdin, dash=False)
    names = iter(
        [p.raw_path or p.virtual for p in readable] or ["{standard input}"]
    )
    named = fl.as_bool("print_file_name")

    def each(source: ByteSource) -> AsyncIterator[bytes]:
        name = next(names)
        prefix = byte_view(encode_text(f"{name}: ")) if named else None
        return run_stream("strings", {**config, "prefix": prefix}, source)

    return per_operand(readable, read, ctx.stdin, io, "strings", each), io


BUILDER = GenericCommand("strings", strings, read=True)
