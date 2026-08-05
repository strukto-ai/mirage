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

from mirage.commands.cli.builtin.ntn.util import parse_json_flag
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.normalize import to_json_bytes
from mirage.core.notion.pages import query_database
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult


async def query(
        inv: CLIInvocation[NotionConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    body = parse_json_flag(fl.as_str("json"), "--json")
    result = await query_database(inv.config,
                                  fl.as_str("datasource") or "",
                                  body=body)
    return yield_bytes(to_json_bytes(result)), IOResult()
