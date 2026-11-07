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
from datetime import datetime, timezone, tzinfo

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.builtin.utils.strftime import gnu_strftime
from mirage.commands.config import Context, command
from mirage.commands.errors import UsageError
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import (
    extra_operand_error,
    usage_exit_code,
    usage_hint,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import fs_error_line
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import decode_text, encode_text
from mirage.types import PathSpec
from mirage.utils.clock import system_date
from mirage.utils.dates import (
    iso_timestamp,
    parse_date_expr_async,
    parse_posix_time_async,
)
from mirage.utils.timezone import zone_from_env

# GNU date's output formats, each chosen by one option: -I takes one
# per precision, --rfc-3339 one per its narrower set, -R the RFC 5322
# line, and a line that chooses none gets the C locale's default (`%e`,
# so the 5th is " 5"). All of them render through gnu_strftime, the
# path `+FORMAT` takes.
ISO_8601_FORMATS = {
    "date": "%Y-%m-%d",
    "hours": "%Y-%m-%dT%H%:z",
    "minutes": "%Y-%m-%dT%H:%M%:z",
    "seconds": "%Y-%m-%dT%H:%M:%S%:z",
    "ns": "%Y-%m-%dT%H:%M:%S,%N%:z",
}
RFC_3339_FORMATS = {
    "date": "%Y-%m-%d",
    "seconds": "%Y-%m-%d %H:%M:%S%:z",
    "ns": "%Y-%m-%d %H:%M:%S.%N%:z",
}
RFC_EMAIL_FORMAT = "%a, %d %b %Y %H:%M:%S %z"
DEFAULT_FORMAT = "%a %b %e %H:%M:%S %Z %Y"
MULTIPLE_FORMATS = b"date: multiple output formats specified\n"
# What setting the clock answers: mirage has none to set, which is what
# GNU says for a user without the privilege to.
CANNOT_SET = b"date: cannot set date: Operation not permitted\n"


def option_formats(fl: FlagView) -> list[str]:
    """The output formats the line's options choose, one per option.

    GNU keeps one and refuses a second as it reads it, so any two of
    -I, -R and --rfc-3339 are ``multiple output formats specified``.
    The parser has already resolved a precision to its whole word
    (``-Is`` is ``seconds``). One divergence: the flag bag keeps the
    last of a REPEATED option, so ``date -I -I`` prints where GNU
    refuses it.

    Args:
        fl (FlagView): spec-bound view over date's flags.
    """
    formats: list[str] = []
    iso = fl.raw("iso_8601")
    if iso is True:
        formats.append(ISO_8601_FORMATS["date"])
    elif isinstance(iso, str):
        formats.append(ISO_8601_FORMATS[iso])
    if fl.as_bool("rfc_email"):
        formats.append(RFC_EMAIL_FORMAT)
    rfc_3339 = fl.as_str("rfc_3339")
    if rfc_3339 is not None:
        formats.append(RFC_3339_FORMATS[rfc_3339])
    return formats


def _multiple_formats() -> tuple[ByteSource | None, IOResult]:
    return None, IOResult(exit_code=1, stderr=MULTIPLE_FORMATS)


def invalid_date(text: str) -> tuple[ByteSource | None, IOResult]:
    """GNU's refusal of a date it cannot read, exit 1.

    Args:
        text (str): the expression or operand as typed.
    """
    return None, IOResult(
        exit_code=1,
        stderr=f"date: invalid date '{quote_text(text)}'\n".encode(),
    )


def exclusive_error() -> UsageError:
    """GNU's refusal of two of -d, -f, -r and --resolution, a usage error."""
    return UsageError(
        "date: the options to specify dates for printing are mutually "
        f"exclusive\n{usage_hint(CommandName.DATE)}",
        usage_exit_code(CommandName.DATE),
    )


async def _named(expression: str, zone: tzinfo | None) -> datetime | None:
    """The moment one ``-d`` or ``-f`` expression names, or None.

    A blank expression names today at midnight, as GNU reads it.

    Args:
        expression (str): the expression as typed.
        zone (tzinfo | None): the command's zone; None is the host's.
    """
    if not expression.strip():
        now = system_date(zone)
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    return await parse_date_expr_async(expression, tz=zone)


async def _dated(
    first: bytes,
    rest: AsyncIterator[bytes],
    zone: tzinfo | None,
    fmt: str,
    io: IOResult,
) -> AsyncIterator[bytes]:
    """``-f``'s output, a line at a time as the expressions arrive; what
    names no date goes to ``io``'s stderr, exit 1, once the input ends.

    Args:
        first (bytes): the input's first chunk, already read.
        rest (AsyncIterator[bytes]): the rest of it.
        zone (tzinfo | None): the command's zone; None is the host's.
        fmt (str): the output format.
        io (IOResult): the result the refusals settle into.
    """
    errors: list[str] = []

    async def one(raw: bytes) -> bytes:
        text = decode_text(raw)
        dt = await _named(text, zone)
        if dt is None:
            errors.append(f"date: invalid date '{quote_text(text)}'\n")
            return b""
        return encode_text(
            gnu_strftime(dt if zone else dt.astimezone(), fmt) + "\n"
        )

    held = bytearray()
    chunk = first
    while True:
        start = 0
        while (at := chunk.find(b"\n", start)) != -1:
            held += chunk[start:at]
            if out := await one(bytes(held)):
                yield out
            held.clear()
            start = at + 1
        held += chunk[start:]
        try:
            chunk = await anext(rest)
        except StopAsyncIteration:
            break
    if held and (out := await one(bytes(held))):
        yield out
    if errors:
        io.exit_code = 1
        io.stderr = encode_text("".join(errors))


async def _each_line(
    ctx: Context, datefile: PathSpec, zone: tzinfo | None, fmt: str
) -> tuple[ByteSource | None, IOResult]:
    """``-f``: each line of the file a ``-d`` expression, printed in turn
    as it is read.

    A line that names no date is reported and the next one still
    prints, exit 1; ``-`` reads standard input. A file that cannot be
    opened is reported before anything prints.

    Args:
        ctx (Context): the command's context.
        datefile (PathSpec): the file of expressions.
        zone (tzinfo | None): the command's zone; None is the host's.
        fmt (str): the output format.
    """
    try:
        if datefile.raw_path == "-":
            source = resolve_source(ctx.stdin)
        elif ctx.vfs is not None:
            source = await ctx.vfs.read(datefile, stream=True)
        else:
            raise FileNotFoundError(datefile.raw_path)
        first = await anext(source, b"")
    except FS_ERRORS as exc:
        line = fs_error_line(CommandName.DATE, datefile, exc)
        return None, IOResult(exit_code=1, stderr=encode_text(line))
    io = IOResult()
    return _dated(first, source, zone, fmt, io), io


async def _modified(ctx: Context, reference: PathSpec) -> datetime:
    """``-r``: the moment a file was last modified.

    A backend that reports no time for it answers the epoch.

    Args:
        ctx (Context): the command's context.
        reference (PathSpec): the file.
    """
    if ctx.vfs is None:
        raise FileNotFoundError(reference.raw_path)
    stamp = iso_timestamp((await ctx.vfs.stat(reference)).modified)
    return datetime.fromtimestamp(stamp or 0, timezone.utc)


def lacks_plus_error(operand: str) -> UsageError:
    """GNU's refusal of a non-``+`` operand beside ``-d``, a usage error.

    Args:
        operand (str): the operand as typed.
    """
    return UsageError(
        f"date: the argument '{quote_text(operand)}' lacks a leading '+';\n"
        "when using an option to specify date(s), any non-option\n"
        "argument must be a format string beginning with '+'\n"
        f"{usage_hint(CommandName.DATE)}",
        usage_exit_code(CommandName.DATE),
    )


@command("date", vfs=None, spec=SPECS["date"])
async def date(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """GNU ``date``: the current moment, or the one ``-d`` names,
    rendered in the zone the command runs in.

    The zone is ``-u``'s UTC, else the ``TZ`` of the command's own
    environment (``TZ=Asia/Hong_Kong date`` and an exported ``TZ``
    alike, as GNU reads it), else the host's local zone. It is read
    from ``ctx.env``, never from process state, so concurrent
    workspaces cannot move each other's clock. ``%Z`` is tzdata's
    abbreviation (``HKT``), as GNU prints it; the TypeScript twin reads
    the same names from a table generated off zoneinfo, since Intl has
    none.

    An operand without ``+`` sets the clock, GNU's
    ``MMDDhhmm[[CC]YY][.ss]``: mirage has no clock to set, so it prints
    the date it names and refuses the setting, as GNU does for a user
    without the privilege. Beside ``-d`` it is a usage error.
    """
    fl = FlagView(ctx.flags, spec=SPECS["date"])
    u = fl.as_bool("utc") or fl.as_bool("universal")
    d = fl.as_str("date")
    reference = fl.as_path("reference")
    datefile = fl.as_path("file")
    resolution = fl.as_bool("resolution")
    formats = option_formats(fl)
    if len(formats) > 1:
        return _multiple_formats()
    named = [d is not None, reference is not None, datefile is not None]
    if sum(named) + resolution > 1:
        raise exclusive_error()
    if len(texts) > 1:
        raise extra_operand_error(CommandName.DATE, texts[1])
    setting = texts[0] if texts else None
    if setting is not None and setting.startswith("+"):
        if formats:
            return _multiple_formats()
        formats.append(setting[1:])
        setting = None
    elif setting is not None and (any(named) or resolution):
        raise lacks_plus_error(setting)
    zone = timezone.utc if u else zone_from_env(ctx.env)
    if datefile is not None:
        fmt = formats[0] if formats else DEFAULT_FORMAT
        return await _each_line(ctx, datefile, zone, fmt)
    if resolution and not formats:
        # Times here are kept to the nanosecond, the resolution GNU
        # reports for a filesystem that keeps them so.
        return b"0.000000001\n", IOResult()
    if setting is not None:
        placed = await parse_posix_time_async(setting, tz=zone)
        if placed is None:
            return invalid_date(setting)
        dt = placed
    elif d is not None:
        # GNU ACCEPTS an empty (or blank) expression, exit 0: with no
        # item at all it names today at midnight. Measured on coreutils
        # 9.4: `date -d ''` and `date -d '   '` both print today 00:00:00
        # in the command's zone.
        parsed_d = await _named(d, zone)
        if parsed_d is None:
            # GNU's refusal, exit 1: a wrong answer with exit 0 poisons
            # whatever consumed it (the NaN-timestamp corpus failure).
            return invalid_date(d)
        dt = parsed_d
    elif reference is not None:
        try:
            dt = await _modified(ctx, reference)
        except FS_ERRORS as exc:
            line = fs_error_line(CommandName.DATE, reference, exc)
            return None, IOResult(exit_code=1, stderr=encode_text(line))
        if zone is not None:
            dt = dt.astimezone(zone)
    elif resolution:
        dt = datetime.fromtimestamp(0, zone or timezone.utc)
    else:
        dt = system_date(zone)
    if zone is None:
        dt = dt.astimezone()
    fmt = formats[0] if formats else DEFAULT_FORMAT
    # --resolution names one nanosecond past the epoch.
    tick = 1 if resolution else None
    out = encode_text(gnu_strftime(dt, fmt, nanosecond=tick) + "\n")
    if setting is not None:
        return out, IOResult(exit_code=1, stderr=CANNOT_SET)
    return out, IOResult()
