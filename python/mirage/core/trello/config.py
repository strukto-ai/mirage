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

from pydantic import ConfigDict, SecretStr

from mirage.core.api.config import TimeoutConfig


class TrelloConfig(TimeoutConfig):
    model_config = ConfigDict(frozen=True, extra="forbid")

    api_key: SecretStr
    """Trello API key."""
    api_token: SecretStr
    """Trello API token."""
    workspace_id: str | None = None
    """Only this workspace and its boards are listed or readable. Unset
    shows every workspace of the token's member."""
    board_ids: list[str] | None = None
    """Only these boards are listed or readable. Unset shows every open
    board of the shown workspaces."""
    base_url: str = "https://api.trello.com/1"
    """Trello API root; override to point at a fake or proxy."""
