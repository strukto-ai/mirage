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

from mirage.commands.cli.builtin.linear.util import first_text, resolve_issue
from mirage.commands.spec.types import FlagView
from mirage.core.linear._client import get_issue, issue_update
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.normalize import normalize_issue, to_json_bytes
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def add_label(
    config: LinearConfig,
    paths: list[PathSpec],
    *texts: str,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags)
    issue_id = await resolve_issue(config, first_text(texts, "issue key"))
    label_id = fl.as_str("label") or ""
    issue = await get_issue(config, issue_id)
    nodes = issue.get("labels", {}).get("nodes", [])
    existing = [n["id"] for n in nodes]
    if label_id not in existing:
        existing.append(label_id)
    updated = await issue_update(config,
                                 issue_id=issue_id,
                                 title=None,
                                 description=None,
                                 label_ids=existing)
    return yield_bytes(to_json_bytes(normalize_issue(updated))), IOResult()
