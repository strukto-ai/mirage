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

from collections.abc import Mapping, Sequence

from mirage.commands.builtin.generic.compressor import (
    CREATE,
    DIRECTORY,
    HAS_SUFFIX,
    LINK,
    OPEN,
    OUTPUT_EXISTS,
    UNKNOWN_SUFFIX,
    CompressorFiles,
    CompressorFlags,
    Refused,
    Tool,
    compress_files,
    last_typed,
)
from mirage.commands.builtin.utils.links import LinkResolver
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.compress import GzipDataError

# The sizes, keyed as the spec names them.
LEVELS = {"fast": 1, **{str(n): n for n in range(2, 9)}, "best": 9}
WORDS: Mapping[str, tuple[str, int]] = {
    OPEN: ("{p}: Can't open input file {name}: {why}.", 1),
    DIRECTORY: ("{p}: Input file {name} is a directory.", 1),
    LINK: ("{p}: Input file {name} is not a normal file.", 1),
    HAS_SUFFIX: ("{p}: Input file {name} already has {suffix} suffix.", 1),
    UNKNOWN_SUFFIX: (
        "{p}: Can't guess original name for {name} -- using {name}.out",
        0,
    ),
    OUTPUT_EXISTS: ("{p}: Output file {out} already exists.", 1),
    CREATE: ("{p}: Can't create output file {out}: {why}.", 1),
}
SUFFIXES: Sequence[tuple[str, str]] = (
    (".bz2", ""),
    (".bz", ""),
    (".tbz2", ".tar"),
    (".tbz", ".tar"),
)
GUESSED_ENDING = ".out"
RECOVER_HINT = (
    "\nYou can use the `bzip2recover' program to attempt to recover\n"
    "data from undamaged sections of corrupted files."
)
READS_NOT = "is not a bzip2 file"
READS_ENDS = "ends unexpectedly"
NOSUCH = "No such file or directory"
TTY_WORDS = "Inappropriate ioctl for device"


def parse_flags(fl: FlagView, command: str) -> CompressorFlags:
    """bzip2's options as ``command`` reads them; ``-z``, ``-d`` and
    ``-t`` are a family where the last typed wins.

    Args:
        fl (FlagView): the line's flags.
        command (str): ``bzip2`` or ``bunzip2``.
    """
    mode = last_typed(fl, "compress", "decompress", "test")
    level = last_typed(fl, *LEVELS)
    return CompressorFlags(
        decompress=mode == "decompress"
        or (mode is None and command == "bunzip2"),
        test=mode == "test",
        keep=fl.as_bool("keep"),
        force=fl.as_bool("force"),
        to_stdout=fl.as_bool("stdout"),
        quiet=1 if fl.as_bool("quiet") else 0,
        verbose=fl.as_int("verbose") or 0,
        level=-1 if level is None else LEVELS[level],
    )


def decode_failed(
    exc: GzipDataError,
    program: str,
    name: str,
    out: str | None,
    test: bool,
) -> Refused:
    """bzip2's lines for an input that will not decode. ``-t`` names what
    was wrong and goes on; ``-d`` stops at a broken stream, as it does at
    anything but an input that is no bzip2 at all.

    Args:
        exc (GzipDataError): what the decoder said.
        program (str): the name it was run under.
        name (str): the input.
        out (str | None): its output, None for standard output.
        test (bool): whether the run only tests.
    """
    reason = "".join(exc.reasons)
    not_bzip2 = READS_NOT in reason
    ends = READS_ENDS in reason
    if test:
        said = (
            "bad magic number (file not created by bzip2)"
            if not_bzip2
            else "file ends unexpectedly"
            if ends
            else "data integrity (CRC) error in data"
        )
        return Refused(f"{program}: {name}: {said}\n{RECOVER_HINT}\n\n", 2)
    if not_bzip2:
        return Refused(f"{program}: {name} is not a bzip2 file.", 2)
    if out is None:
        text = reason.replace("({})", name).replace("bzip2:", f"{program}:")
        return Refused(text, 2, fatal=True)
    text = (
        reason.replace("({})", name)
        .replace("(stdout)", out)
        .replace(TTY_WORDS, NOSUCH)
        .replace("bzip2:", f"{program}:")
    )
    return Refused(
        f"{text}\n{program}: Deleting output file {out}, if it exists.",
        2,
        fatal=True,
    )


def _spaced(name: str, longest: int) -> str:
    return f"  {name}: {' ' * (longest - len(name))}"


def summary(name: str, read_in: int, written: int, longest: int) -> str:
    """``bzip2 -v``'s line for an input compressed.

    Args:
        name (str): the input.
        read_in (int): the bytes it held.
        written (int): the bytes it became.
        longest (int): the name column's width.
    """
    if read_in == 0:
        return f"{_spaced(name, longest)} no data compressed."
    ratio = read_in / written
    bits = written * 8 / read_in
    saved = (1 - written / read_in) * 100
    return (
        f"{_spaced(name, longest)}{ratio:6.3f}:1, {bits:6.3f} bits/byte, "
        f"{saved:5.2f}% saved, {read_in} in, {written} out."
    )


def decoded_note(name: str, longest: int, test: bool) -> str:
    """``bzip2 -v``'s line for an input tested or decompressed.

    Args:
        name (str): the input.
        longest (int): the name column's width.
        test (bool): whether the run only tests.
    """
    return f"{_spaced(name, longest)}{'ok' if test else 'done'}"


async def bzip2_generic(
    paths: list[PathSpec],
    ctx: Context,
    files: CompressorFiles,
    resolver: LinkResolver | None,
    command: str,
) -> tuple[ByteSource | None, IOResult]:
    """Run bzip2 or bunzip2 over resolved operands. Pinned against bzip2
    1.0.8.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        ctx (Context): Flags and stdin from the dispatcher.
        files (CompressorFiles): the mount's operations.
        resolver (LinkResolver | None): the namespace's links.
        command (str): ``bzip2`` or ``bunzip2``.
    """
    parsed = parse_flags(FlagView(ctx.flags, spec=SPECS[command]), command)
    tool = Tool(
        program=command,
        codec="bzip2",
        words=WORDS,
        suffixes=SUFFIXES,
        first_error_sticks=False,
        decode_failed=decode_failed,
        silenced_at={0: 1},
        guessed_ending=GUESSED_ENDING,
        summary=summary,
        decoded_note=decoded_note,
    )
    return await compress_files(
        paths, tool, parsed, files, ctx.stdin, resolver
    )


__all__ = ["bzip2_generic"]
