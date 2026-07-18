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
from mirage.commands.builtin.gdocs.gws_docs_documents_batchUpdate import \
    gws_docs_documents_batchUpdate
from mirage.commands.builtin.gdocs.gws_docs_documents_create import \
    gws_docs_documents_create
from mirage.commands.builtin.gdocs.gws_docs_write import gws_docs_write
from mirage.commands.builtin.gsheets.gws_sheets_append import gws_sheets_append
from mirage.commands.builtin.gsheets.gws_sheets_read import gws_sheets_read
from mirage.commands.builtin.gsheets.gws_sheets_spreadsheets_batchUpdate import \
    gws_sheets_spreadsheets_batchUpdate  # noqa: E501
from mirage.commands.builtin.gsheets.gws_sheets_spreadsheets_create import \
    gws_sheets_spreadsheets_create  # noqa: E501
from mirage.commands.builtin.gsheets.gws_sheets_write import gws_sheets_write
from mirage.commands.builtin.gslides.gws_slides_presentations_batchUpdate import \
    gws_slides_presentations_batchUpdate  # noqa: E501
from mirage.commands.builtin.gslides.gws_slides_presentations_create import \
    gws_slides_presentations_create  # noqa: E501
from mirage.commands.builtin.gws.factory import (invalidate_mount_listing,
                                                 run_gws_method)
from mirage.commands.builtin.gws.methods import GWS_METHODS
from mirage.commands.registry import command
from mirage.commands.spec.types import (CommandSpec, Operand, OperandKind,
                                        Option)
from mirage.core.google.tree_ops import DriveItemAccessor
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# The top-level `gws` command accepts the official CLI syntax
# (`gws docs documents get --params '...'`) and routes to the per-method
# mirage commands, so agent playbooks written against the official CLI run
# verbatim on a mounted Google resource. `+` convenience commands map to
# the bespoke helpers; Discovery methods map to the passthrough factory.
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

_API_METHODS = {(m.service, m.resource, m.method): m for m in GWS_METHODS}

_BESPOKE: dict[tuple[str, str, str], Callable[..., Any]] = {
    ("docs", "documents", "create"):
    gws_docs_documents_create,
    ("docs", "documents", "batchUpdate"):
    gws_docs_documents_batchUpdate,
    ("sheets", "spreadsheets", "create"):
    gws_sheets_spreadsheets_create,
    ("sheets", "spreadsheets", "batchUpdate"):
    gws_sheets_spreadsheets_batchUpdate,
    ("slides", "presentations", "create"):
    gws_slides_presentations_create,
    ("slides", "presentations", "batchUpdate"):
    gws_slides_presentations_batchUpdate,
}

_PLUS: dict[tuple[str, str], Callable[..., Any]] = {
    ("docs", "+write"): gws_docs_write,
    ("sheets", "+read"): gws_sheets_read,
    ("sheets", "+append"): gws_sheets_append,
    ("sheets", "+write"): gws_sheets_write,
}

# The official CLI accepts both --spreadsheet-id/--spreadsheet and
# --document-id/--document; the bespoke helpers take the short form.
_FLAG_ALIASES = {
    "spreadsheet-id": "spreadsheet",
    "document-id": "document",
}


def normalize_flags(flags: dict[str, object]) -> dict[str, object]:
    out: dict[str, object] = {}
    for key, value in flags.items():
        out[_FLAG_ALIASES.get(key, key)] = value
    return out


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
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    words = [t for t in texts if t]
    if len(words) < 2:
        raise ValueError(
            "Usage: gws <service> <resource> <method> [--params JSON] "
            "[--json JSON] | gws <service> +<helper> [flags]")
    service = words[0]
    flags = dict(_extra)
    if words[1].startswith("+"):
        plus = _PLUS.get((service, words[1]))
        if plus is None:
            raise ValueError(f"gws: unknown command {service} {words[1]}")
        result = await plus(accessor, paths, **normalize_flags(flags))
        if words[1] != "+read":
            await invalidate_mount_listing()
        return result
    if len(words) < 3:
        raise ValueError(f"gws: missing method for {service} {words[1]}")
    key = (service, words[1], words[2])
    api = _API_METHODS.get(key)
    if api is not None:
        return await run_gws_method(api, accessor, paths, **flags)
    bespoke = _BESPOKE.get(key)
    if bespoke is not None:
        result = await bespoke(accessor, paths, **flags)
        await invalidate_mount_listing()
        return result
    raise ValueError(f"gws: unknown method {' '.join(key)}")
