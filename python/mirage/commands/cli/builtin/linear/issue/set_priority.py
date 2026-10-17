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

from mirage.accessor.linear import LinearAccessor
from mirage.commands.cli.builtin.linear.util import first_text, resolve_issue
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.linear.client import issue_update
from mirage.core.linear.normalize import normalize_issue, to_json_bytes
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def set_priority(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    issue_id = await resolve_issue(accessor, first_text(texts, "issue key"))
    issue = await issue_update(
        accessor,
        issue_id=issue_id,
        title=None,
        description=None,
        priority=fl.as_int("priority") or 0,
    )
    return yield_bytes(to_json_bytes(normalize_issue(issue))), IOResult()
