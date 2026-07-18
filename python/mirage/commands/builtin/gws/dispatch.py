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

from collections.abc import AsyncIterator, Callable
from typing import Any

from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.gdocs.gws_docs_write import gws_docs_write
from mirage.commands.builtin.gsheets.gws_sheets_append import gws_sheets_append
from mirage.commands.builtin.gsheets.gws_sheets_read import gws_sheets_read
from mirage.commands.builtin.gsheets.gws_sheets_write import gws_sheets_write
from mirage.commands.builtin.gws.factory import run_gws_method
from mirage.commands.builtin.gws.methods import GWS_METHODS
from mirage.commands.registry import command
from mirage.commands.spec.types import (CommandSpec, Operand, OperandKind,
                                        Option)
from mirage.core.google.tree_ops import DriveItemAccessor
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# `gws` mirrors the official CLI: `gws <service> <resource> <method>` and
# `gws <service> +<helper>`. The mirage parser does the flag parsing from this
# spec; the body reconstructs the target command name from the operands and
# looks it up in the method table (or the helper map). No per-method routing.
GWS_SPEC = CommandSpec(
    options=(
        Option(long="--params", value_kind=OperandKind.TEXT),
        Option(long="--json", value_kind=OperandKind.TEXT),
        Option(long="--spreadsheet", value_kind=OperandKind.TEXT),
        Option(long="--spreadsheet-id", value_kind=OperandKind.TEXT),
        Option(long="--range", value_kind=OperandKind.TEXT),
        Option(long="--values", value_kind=OperandKind.TEXT),
        Option(long="--json-values", value_kind=OperandKind.TEXT),
        Option(long="--document", value_kind=OperandKind.TEXT),
        Option(long="--document-id", value_kind=OperandKind.TEXT),
        Option(long="--text", value_kind=OperandKind.TEXT),
    ),
    rest=Operand(kind=OperandKind.TEXT),
)

_METHOD_BY_NAME = {m.command_name: m for m in GWS_METHODS}

_HELPERS: dict[str, Callable[..., Any]] = {
    "gws-docs-write": gws_docs_write,
    "gws-sheets-read": gws_sheets_read,
    "gws-sheets-write": gws_sheets_write,
    "gws-sheets-append": gws_sheets_append,
}

# The official CLI accepts --spreadsheet-id/--document-id; the helper commands
# take the short form.
_FLAG_ALIASES = {"spreadsheet-id": "spreadsheet", "document-id": "document"}


def normalize_flags(flags: dict[str, object]) -> dict[str, object]:
    return {_FLAG_ALIASES.get(k, k): v for k, v in flags.items()}


@command("gws",
         resource=["gdocs", "gsheets", "gslides", "gdrive"],
         spec=GWS_SPEC,
         write=True)
async def gws(
    accessor: DriveItemAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    index: IndexCacheStore | None = None,
    prefix: str = "",
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    words = [t for t in texts if t]
    if len(words) < 2:
        raise ValueError(
            "Usage: gws <service> <resource> <method> [--params JSON] "
            "[--json JSON] | gws <service> +<helper> [flags]")
    service, second = words[0], words[1]
    if second.startswith("+"):
        helper = _HELPERS.get(f"gws-{service}-{second[1:]}")
        if helper is None:
            raise ValueError(f"gws: unknown command {service} {second}")
        return await helper(accessor, paths, **normalize_flags(flags))
    if len(words) < 3:
        raise ValueError(f"gws: missing method for {service} {second}")
    method = _METHOD_BY_NAME.get(f"gws-{service}-{words[1]}-{words[2]}")
    if method is None:
        raise ValueError(f"gws: unknown method {' '.join(words[:3])}")
    return await run_gws_method(method, accessor, paths, **flags)
