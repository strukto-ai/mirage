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

import dataclasses
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass

from mirage.commands.builtin.generic.cmp import (
    CmpFlags,
    cmp_generic,
)
from mirage.commands.builtin.generic.cmp import parse_flags as cmp_flags
from mirage.commands.builtin.generic.diff import (
    DiffFlags,
    diff_generic,
)
from mirage.commands.builtin.generic.diff import parse_flags as diff_flags
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    resolve_source,
    stdin_stat,
)
from mirage.commands.config import Context
from mirage.commands.quote import quote_text
from mirage.errors.constants import FS_ERRORS
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import utf8_locale
from mirage.types import FileStat, PathSpec, ReaddirFn, ReadStreamFn, StatFn
from mirage.utils.compress import gunzip_stream

# The names zdiff's script reads as compressed, by their ending.
COMPRESSED_NAME = re.compile(r".*(?:[-.]gz.*|[-.][zZ]|\.t[ga]z)\Z", re.DOTALL)
# The names the same script takes a single operand's partner from.
STRIPPED_ENDING = re.compile(r"(?:\.t[ga]z|[-.](?:gz|[zZ]))\Z")
NOT_A_FILE = "No such file"
PROGRAM = "/usr/bin/zdiff"
FIRST_LINE = 92
SECOND_LINE = 96


def _refusal(line: str) -> tuple[None, IOResult]:
    return None, IOResult(exit_code=2, stderr=f"{PROGRAM}: {line}\n".encode())


@dataclass(frozen=True, slots=True)
class _Plan:
    """The two sides the comparison runs on, with what each stands for.

    Args:
        paths (list[PathSpec]): the sides, each named as the comparison
            prints it.
        decoded (set[str]): the sides read through gzip, by virtual path.
    """

    paths: list[PathSpec]
    decoded: set[str]


async def _unsized(path: PathSpec) -> int | None:
    return None


def _respelled(path: PathSpec, raw_path: str) -> PathSpec:
    return dataclasses.replace(path, raw_path=raw_path)


def _partner(path: PathSpec, cwd: str) -> PathSpec | None:
    """The file a lone operand is compared with: its name as typed,
    unzipped, as the operand itself may be a link to anything.

    Args:
        path (PathSpec): the operand.
        cwd (str): the directory a relative name is under.
    """
    ending = STRIPPED_ENDING.search(path.raw_path)
    if ending is None:
        return None
    swap = ".tar" if ending.group().startswith(".t") else ""
    unzipped = STRIPPED_ENDING.sub(swap, path.raw_path)
    return PathSpec.from_str_path(unzipped, cwd=cwd)


def _plan(first: PathSpec, second: PathSpec, lone: bool) -> _Plan:
    """Name the sides as the comparison sees them: the second compressed
    side is standard input, the first ``/dev/fd/5``, and with only one
    compressed, that one is standard input.

    Args:
        first (PathSpec): the first file.
        second (PathSpec): the second file.
        lone (bool): the second is the first's own name unzipped.
    """
    zipped_second = (
        not lone and COMPRESSED_NAME.fullmatch(second.raw_path) is not None
    )
    zipped_first = COMPRESSED_NAME.fullmatch(first.raw_path) is not None or (
        first.raw_path == "-" and zipped_second
    )
    decoded = {
        p.virtual
        for p, zipped in ((first, zipped_first), (second, zipped_second))
        if zipped
    }
    if zipped_first and zipped_second:
        sides = [
            _respelled(first, raw_path="/dev/fd/5"),
            _respelled(second, raw_path="-"),
        ]
    elif zipped_first:
        sides = [_respelled(first, raw_path="-"), second]
    elif zipped_second:
        sides = [first, _respelled(second, raw_path="-")]
    else:
        sides = [first, second]
    return _Plan(sides, decoded)


async def zcompare_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read: ReadStreamFn,
    stat: StatFn,
    readdir: ReaddirFn,
    command: str,
) -> tuple[ByteSource | None, IOResult]:
    """Compare files through gzip, ``cmp`` for zcmp and ``diff`` for zdiff.

    Args:
        paths (list[PathSpec]): Glob-resolved operands.
        texts (list[str]): Non-path words.
        ctx (Context): Flags and stdin from the dispatcher.
        read (ReadStreamFn): the mount's reader.
        stat (StatFn): the mount's stat.
        readdir (ReaddirFn): the mount's readdir.
        command (str): ``zcmp`` or ``zdiff``.
    """
    cmp_parsed = cmp_flags(ctx.flags, texts) if command == "zcmp" else None
    diff_parsed = (
        diff_flags(ctx.flags, utf8_locale(ctx.env))
        if command == "zdiff"
        else None
    )
    for refused in (cmp_parsed, diff_parsed):
        if isinstance(refused, IOResult):
            return None, refused
    if not paths:
        return _refusal("missing operand")
    if len(paths) > 2:
        return _refusal(f"extra operand '{quote_text(paths[2].raw_path)}'")
    if len(paths) == 2:
        first, second, lone = paths[0], paths[1], False
    else:
        partner = _partner(paths[0], ctx.cwd.virtual)
        if partner is None:
            name = paths[0].raw_path
            return _refusal(f"{name}: unknown compressed file extension")
        first, second, lone = paths[0], partner, True
    checks = [(first, FIRST_LINE)] + ([] if lone else [(second, SECOND_LINE)])
    for operand, line in checks:
        if is_stdin(operand):
            continue
        try:
            await stat(operand)
        except FS_ERRORS:
            name = operand.raw_path
            return _refusal(f"{line}: cannot open {name}: {NOT_A_FILE}")
    plan = _plan(first, second, lone)
    piped = next((p for p in plan.paths if p.raw_path == "-"), None)

    def is_dash_side(path: PathSpec) -> bool:
        return (
            first.raw_path == "-"
            and path.virtual == first.virtual
            and path.virtual in plan.decoded
        )

    def reading(path: PathSpec) -> AsyncIterator[bytes]:
        if path.virtual not in plan.decoded:
            return read(path)
        if is_dash_side(path):
            return gunzip_stream(resolve_source(ctx.stdin), passthrough=True)
        return gunzip_stream(read(path), passthrough=True)

    stat_stdin = stdin_stat(stat)

    async def stat_side(path: PathSpec) -> FileStat:
        return await stat_stdin(first if is_dash_side(path) else path)

    side = ctx
    if piped is not None and piped.virtual in plan.decoded:
        side = dataclasses.replace(ctx, stdin=reading(piped))

    if isinstance(cmp_parsed, CmpFlags):
        return await cmp_generic(
            cmp_parsed, plan.paths, texts, side, reading, _unsized, _unsized
        )
    if isinstance(diff_parsed, DiffFlags):
        return await diff_generic(
            diff_parsed,
            plan.paths,
            texts,
            side,
            reading,
            readdir,
            stat_side,
            _unsized,
        )
    raise ValueError(f"no comparison for {command}")


__all__ = ["zcompare_generic"]
