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
from collections.abc import Mapping, Sequence

from mirage.commands.builtin.generic.compressor import (
    BAD_FORMAT,
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
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.compress import GzipDataError

# The presets, keyed as the spec names them.
PRESETS = {
    "fast": 0,
    "args_1": 1,
    **{str(n): n for n in range(2, 9)},
    "best": 9,
}
DEFAULT_PRESET = 6
THREADS = re.compile(r"[0-9]+(?:[kKmMgG](?:i?B)?)?")
CHECKS = frozenset({"none", "crc32", "crc64", "sha256"})
FORMATS = frozenset({"auto", "xz"})
MAGIC = b"\xfd7zXZ\x00"
WORDS: Mapping[str, tuple[str, int]] = {
    BAD_FORMAT: ("{p}: {name}: File format not recognized", 1),
    OPEN: ("{p}: {name}: {why}", 1),
    DIRECTORY: ("{p}: {name}: Is a directory, skipping", 2),
    LINK: ("{p}: {name}: Is a symbolic link, skipping", 2),
    HAS_SUFFIX: (
        "{p}: {name}: File already has '{suffix}' suffix, skipping",
        2,
    ),
    UNKNOWN_SUFFIX: (
        "{p}: {name}: Filename has an unknown suffix, skipping",
        2,
    ),
    OUTPUT_EXISTS: ("{p}: {out}: File exists", 1),
    CREATE: ("{p}: {out}: {why}", 1),
}
SUFFIXES: Sequence[tuple[str, str]] = (
    (".xz", ""),
    (".txz", ".tar"),
    (".lzma", ""),
    (".tlz", ".tar"),
)


def parse_flags(
    fl: FlagView, command: str
) -> CompressorFlags | tuple[str, int]:
    """xz's options as ``command`` reads them; ``-z``, ``-d`` and ``-t``
    are a family where the last typed wins. A value xz refuses answers
    its line.

    Args:
        fl (FlagView): the line's flags.
        command (str): ``xz`` or ``unxz``.
    """
    for name, valid, why in (
        ("threads", None, "Value is not a non-negative decimal integer"),
        ("check", CHECKS, "Unsupported integrity check type"),
        ("format", FORMATS, "Unknown file format type"),
    ):
        given = fl.as_str(name)
        if given is None:
            continue
        good = (
            THREADS.fullmatch(given) is not None
            if valid is None
            else given in valid
        )
        if not good:
            return f"{command}: {quote_text(given)}: {why}", 1
    suffix = fl.as_str("suffix")
    if suffix is not None and (suffix == "" or "/" in suffix):
        return f"{command}: {quote_text(suffix)}: Invalid filename suffix", 1
    mode = last_typed(fl, "compress", "decompress", "test")
    preset = last_typed(fl, *PRESETS)
    return CompressorFlags(
        decompress=mode == "decompress"
        or (mode is None and command == "unxz"),
        test=mode == "test",
        keep=fl.as_bool("keep"),
        force=fl.as_bool("force"),
        to_stdout=fl.as_bool("stdout"),
        quiet=fl.as_int("quiet") or 0,
        verbose=fl.as_int("verbose") or 0,
        level=DEFAULT_PRESET if preset is None else PRESETS[preset],
        suffix=suffix,
    )


def decode_failed(
    exc: GzipDataError,
    program: str,
    name: str,
    out: str | None,
    test: bool,
) -> Refused:
    """xz's line for an input that will not decode: the name typed in
    place of the stream's stand-in, and on to the next input.

    Args:
        exc (GzipDataError): what the decoder said.
        program (str): the name it was run under.
        name (str): the input.
        out (str | None): its output, unused.
        test (bool): unused.
    """
    text = "".join(reason.replace("({})", name) for reason in exc.reasons)
    return Refused(program + text.removeprefix("xz"), 1)


async def xz_generic(
    paths: list[PathSpec],
    ctx: Context,
    files: CompressorFiles,
    resolver: LinkResolver | None,
    command: str,
) -> tuple[ByteSource | None, IOResult]:
    """Run xz or unxz over resolved operands. Pinned against xz 5.8.1.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        ctx (Context): Flags and stdin from the dispatcher.
        files (CompressorFiles): the mount's operations.
        resolver (LinkResolver | None): the namespace's links.
        command (str): ``xz`` or ``unxz``.
    """
    parsed = parse_flags(FlagView(ctx.flags, spec=SPECS[command]), command)
    if isinstance(parsed, tuple):
        line, code = parsed
        return None, IOResult(exit_code=code, stderr=f"{line}\n".encode())
    tool = Tool(
        program=command,
        codec="xz",
        words=WORDS,
        suffixes=SUFFIXES,
        first_error_sticks=True,
        decode_failed=decode_failed,
        silenced_at={1: 2, 2: 1},
        magic=MAGIC,
    )
    return await compress_files(
        paths, tool, parsed, files, ctx.stdin, resolver
    )


__all__ = ["xz_generic"]
