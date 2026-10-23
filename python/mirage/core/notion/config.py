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

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from mirage.vfs.constants import FULL_SCAN_LIMIT


class NotionConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    api_key: SecretStr
    """Notion integration token."""
    base_url: str = "https://api.notion.com/v1"
    """Notion API root; override to point at a fake or proxy."""
    # None means the generation the client is written against. A CLI
    # verb overrides it per line from --notion-version, so the override
    # travels with the config the transport already takes rather than as
    # a second argument every call site would have to thread.
    api_version: str | None = None
    """`Notion-Version` header sent with every request. Unset sends
    `2025-09-03`; `ntn --notion-version` overrides it per line."""
    full_scan_limit: int = Field(default=FULL_SCAN_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit."""
