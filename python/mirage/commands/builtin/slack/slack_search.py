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

from mirage.accessor.slack import SlackAccessor
from mirage.commands.registry import command
from mirage.commands.spec.types import CommandSpec, OperandKind, Option
from mirage.core.slack.search import search_messages
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

SPEC = CommandSpec(options=(
    Option(
        long="--query",
        value_kind=OperandKind.TEXT,
        description=("Slack search query "
                     "(supports operators like 'from:@user', "
                     "'in:#channel')"),
    ),
    Option(
        long="--count",
        value_kind=OperandKind.TEXT,
        description="Results per page (1-100, default 20)",
    ),
    Option(
        long="--page",
        value_kind=OperandKind.TEXT,
        description="1-based page number (default 1)",
    ),
), )


def _parse_int(raw: object, name: str, default: int, lo: int,
               hi: int | None) -> int:
    if raw is None or raw == "":
        return default
    if not isinstance(raw, str):
        raise ValueError(f"--{name} must be an integer")
    try:
        value = int(raw)
    except ValueError as e:
        raise ValueError(f"--{name} must be an integer") from e
    if value < lo:
        raise ValueError(f"--{name} must be >= {lo}")
    if hi is not None and value > hi:
        raise ValueError(f"--{name} must be <= {hi}")
    return value


@command("slack-search", resource="slack", spec=SPEC)
async def slack_search(
    accessor: SlackAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    query = _extra.get("query", "")
    if not query or not isinstance(query, str):
        raise ValueError("--query is required")
    count = _parse_int(_extra.get("count"), "count", default=20, lo=1, hi=100)
    page = _parse_int(_extra.get("page"), "page", default=1, lo=1, hi=None)
    result = await search_messages(accessor.config,
                                   query,
                                   count=count,
                                   page=page)
    return result, IOResult()
