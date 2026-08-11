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

from mirage.commands.cli.builtin.linear.util import (first_text, resolve_issue,
                                                     resolve_label_id)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.linear._client import get_issue, issue_update
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.normalize import normalize_issue, to_json_bytes
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult


async def add_label(
        inv: CLIInvocation[LinearConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    issue_id = await resolve_issue(inv.config,
                                   first_text(inv.texts, "issue key"))
    issue = await get_issue(inv.config, issue_id)
    team_id = (issue.get("team") or {}).get("id") or ""
    label_id = await resolve_label_id(inv.config, team_id, fl.as_str("label"),
                                      fl.as_str("label_name"))
    nodes = issue.get("labels", {}).get("nodes", [])
    existing = [n["id"] for n in nodes]
    if label_id not in existing:
        existing.append(label_id)
    updated = await issue_update(inv.config,
                                 issue_id=issue_id,
                                 title=None,
                                 description=None,
                                 label_ids=existing)
    return yield_bytes(to_json_bytes(normalize_issue(updated))), IOResult()
