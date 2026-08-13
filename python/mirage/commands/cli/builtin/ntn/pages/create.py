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

from mirage.commands.cli.builtin.ntn.util import (content_or_stdin,
                                                  notion_config, pretty_json)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagView
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.pages import create_page
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue

PARENT_KEYS = {
    "page": "page_id",
    "database": "database_id",
    "data-source": "data_source_id",
}


def parse_parent(spec: str) -> dict[str, JsonValue]:
    """Turn a `--parent kind:id` operand into a request parent.

    Args:
        spec (str): the flag value, e.g. ``data-source:<uuid>``.

    Returns:
        dict: the parent object to send.
    """
    kind, _, ident = spec.partition(":")
    key = PARENT_KEYS.get(kind)
    if key is None or ident == "":
        raise UsageError(
            "--parent must be page:<id>, database:<id>, or data-source:<id>")
    return {key: ident}


async def create(
        inv: CLIInvocation[NotionConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    markdown = await content_or_stdin(fl.as_str("content"), inv.stdin)
    body: dict[str, JsonValue] = {"markdown": markdown}
    # The parent really is optional upstream: omitted, the request goes
    # out without one and the API decides whether to refuse it.
    parent = fl.as_str("parent")
    if parent:
        body["parent"] = parse_parent(parent)
    page = await create_page(notion_config(inv), body)
    if fl.as_bool("json"):
        return yield_bytes(pretty_json(page)), IOResult()
    return yield_bytes(f"{page.get('id', '')}\n".encode()), IOResult()
