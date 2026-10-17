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

from pydantic import BaseModel, ConfigDict, SecretStr


class TrelloConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    api_key: SecretStr
    api_token: SecretStr
    workspace_id: str | None = None
    board_ids: list[str] | None = None
    base_url: str = "https://api.trello.com/1"
    # Let grep -w and rg -w read only the cards Trello's search names, and
    # those whose other fields hold the word (`files_containing`). Off by
    # default: Trello indexes a write some time after it lands.
    content_search: bool = False
