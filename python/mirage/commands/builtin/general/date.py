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

from datetime import datetime, timezone

from mirage.accessor.base import Accessor
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
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.dates import parse_date_expr, parse_posix_time
from mirage.utils.timezone import zone_from_env

# GNU date's output formats (date.c), each chosen by one option: -I
# takes one per precision, --rfc-3339 one per its narrower set, -R the
# RFC 5322 line, and a line that chooses none gets the C locale's
# default (`%e`, so the 5th is " 5"). All of them render through
# gnu_strftime, the path `+FORMAT` takes.
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


def invalid_date(text: str) -> tuple[ByteSource | None, IOResult]:
    """GNU's refusal of a date it cannot read, exit 1.

    Args:
        text (str): the expression or operand as typed.
    """
    return None, IOResult(
        exit_code=1,
        stderr=f"date: invalid date '{quote_text(text)}'\n".encode(),
    )


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
    formats = option_formats(fl)
    if len(formats) > 1:
        return None, IOResult(exit_code=1, stderr=MULTIPLE_FORMATS)
    if len(texts) > 1:
        raise extra_operand_error(CommandName.DATE, texts[1])
    setting = texts[0] if texts else None
    if setting is not None and setting.startswith("+"):
        if formats:
            return None, IOResult(exit_code=1, stderr=MULTIPLE_FORMATS)
        formats.append(setting[1:])
        setting = None
    elif setting is not None and d is not None:
        raise lacks_plus_error(setting)
    zone = timezone.utc if u else zone_from_env(ctx.env)
    if setting is not None:
        placed = parse_posix_time(setting, tz=zone)
        if placed is None:
            return invalid_date(setting)
        dt = placed
    elif d is not None and not d.strip():
        # GNU ACCEPTS an empty (or blank) expression, exit 0: gnulib's
        # parse-datetime sees no component at all and falls through to
        # "a date with no time", which is today at midnight. Measured on
        # coreutils 9.4: `date -d ''` and `date -d '   '` both print
        # today 00:00:00 in the command's zone.
        now = datetime.now(zone)
        dt = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif d is not None:
        parsed_d = parse_date_expr(d, tz=zone)
        if parsed_d is None:
            # GNU's refusal, exit 1: a wrong answer with exit 0 poisons
            # whatever consumed it (the NaN-timestamp corpus failure).
            return invalid_date(d)
        dt = parsed_d
    else:
        dt = datetime.now(zone)
    if zone is None:
        dt = dt.astimezone()
    fmt = formats[0] if formats else DEFAULT_FORMAT
    out = (gnu_strftime(dt, fmt) + "\n").encode()
    if setting is not None:
        return out, IOResult(exit_code=1, stderr=CANNOT_SET)
    return out, IOResult()
