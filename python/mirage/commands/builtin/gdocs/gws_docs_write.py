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

import json

from mirage.accessor.gdocs import GDocsAccessor
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.gdocs.write import append_text
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(long="--document", value_kind=OperandKind.TEXT),
    Option(long="--text", value_kind=OperandKind.TEXT),
), )


@command("gws docs +write",
         resource=["gdocs", "gdrive"],
         spec=SPEC,
         write=True)
async def gws_docs_write(
    accessor: GDocsAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    doc_id = _extra.get("document", "")
    text = _extra.get("text", "")
    if not doc_id or not isinstance(doc_id, str):
        raise ValueError("--document is required")
    if not text or not isinstance(text, str):
        raise ValueError("--text is required")
    result = await append_text(accessor.token_manager, doc_id, text)
    out = json.dumps(result, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
