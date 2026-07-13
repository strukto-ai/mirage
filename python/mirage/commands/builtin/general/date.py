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

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.builtin.generic_bind.provision import pure_provision
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("date", resource=None, spec=SPECS["date"], provision=pure_provision)
async def date(
    accessor: Accessor = NOOPAccessor(),
    paths: list[PathSpec] | None = None,
    *texts: str,
    stdin: bytes | None = None,
    u: bool = False,
    d: str | None = None,
    args_I: bool = False,
    R: bool = False,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if len(texts) > 1:
        raise extra_operand_error(CommandName.DATE, texts[1])
    if d is not None:
        dt = datetime.fromisoformat(d)
        if u and dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    elif u:
        dt = datetime.now(timezone.utc)
    else:
        dt = datetime.now()
    fmt: str | None = None
    for t in texts:
        if t.startswith("+"):
            fmt = t[1:]
            break
    if args_I:
        result = dt.strftime("%Y-%m-%d")
    elif R:
        result = email.utils.format_datetime(dt)
    elif fmt is not None:
        result = dt.strftime(fmt)
    else:
        result = dt.strftime("%a %b %d %H:%M:%S %Z %Y") if u else dt.strftime(
            "%a %b %d %H:%M:%S %Y")
    return (result + "\n").encode(), IOResult()
