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

from mirage.commands.cli.builtin.linear.util import text_or_stdin
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.linear._client import comment_update
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.normalize import normalize_comment, to_json_bytes
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult


async def update(
        inv: CLIInvocation[LinearConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    body = await text_or_stdin(fl.as_str("body"), inv.stdin,
                               "comment body is required")
    comment = await comment_update(inv.config,
                                   comment_id=fl.as_str("comment") or "",
                                   body=body)
    issue = comment.get("issue") if isinstance(comment, dict) else None
    if isinstance(issue, dict) and issue.get("id"):
        payload = normalize_comment(comment,
                                    issue_id=issue["id"],
                                    issue_key=issue.get("identifier"))
    else:
        payload = comment
    return yield_bytes(to_json_bytes(payload)), IOResult()
