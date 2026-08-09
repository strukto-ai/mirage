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

from mirage.commands.cli.types import CLIInvocation
from mirage.core.notion.config import NotionConfig
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.resource.secrets import reveal_secret


async def token(
        inv: CLIInvocation[NotionConfig]
) -> tuple[ByteSource | None, IOResult]:
    secret = reveal_secret(inv.config.api_key)
    return yield_bytes(f"{secret}\n".encode()), IOResult()
