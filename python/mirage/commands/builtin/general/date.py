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

import email.utils
from datetime import datetime, timezone

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.provision import pure_provision
from mirage.commands.builtin.utils.strftime import gnu_strftime
from mirage.commands.config import CommandOpts
from mirage.commands.quote import quote_text
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import CommandName, FlagView
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.dates import parse_date_expr
from mirage.utils.timezone import zone_from_env


@command("date", resource=None, spec=SPECS["date"], provision=pure_provision)
async def date(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    """GNU ``date``: the current moment, or the one ``-d`` names,
    rendered in the zone the command runs in.

    The zone is ``-u``'s UTC, else the ``TZ`` of the command's own
    environment (``TZ=Asia/Hong_Kong date`` and an exported ``TZ``
    alike, as GNU reads it), else the host's local zone. It is read
    from ``opts.env``, never from process state, so concurrent
    workspaces cannot move each other's clock. ``%Z`` is tzdata's
    abbreviation (``HKT``), as GNU prints it; the TypeScript twin reads
    the same names from a table generated off zoneinfo, since Intl has
    none.
    """
    fl = FlagView(opts.flags, spec=SPECS["date"])
    u = fl.as_bool("u")
    d = fl.as_str("d")
    if len(texts) > 1:
        raise extra_operand_error(CommandName.DATE, texts[1])
    zone = timezone.utc if u else zone_from_env(opts.env)
    if d is not None and not d.strip():
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
            return None, IOResult(
                exit_code=1,
                stderr=f"date: invalid date '{quote_text(d)}'\n".encode())
        dt = parsed_d
    else:
        dt = datetime.now(zone)
    if zone is None:
        dt = dt.astimezone()
    fmt: str | None = None
    for t in texts:
        if t.startswith("+"):
            fmt = t[1:]
            break
    if fl.as_bool("args_I"):
        result = dt.strftime("%Y-%m-%d")
    elif fl.as_bool("R"):
        result = email.utils.format_datetime(dt)
    elif fmt is not None:
        result = gnu_strftime(dt, fmt)
    else:
        result = dt.strftime("%a %b %d %H:%M:%S %Z %Y")
    return (result + "\n").encode(), IOResult()
