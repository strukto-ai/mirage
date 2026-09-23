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

from pydantic import BaseModel, SecretStr


class DropboxConfig(BaseModel):
    client_id: str
    client_secret: SecretStr
    refresh_token: SecretStr
    root_path: str = "/"
    # Opt-in for grep/rg to narrow recursive scans via /files/search_v2
    # instead of downloading every file. Full-text content search is
    # plan-gated (Dropbox Professional/Essentials/Business and up); on other
    # plans search_v2 silently matches file names only, which would make a
    # narrowed scan miss content matches — so this stays off by default.
    # Search indexing also lags recent writes by a short delay.
    content_search: bool = False
    # Base URL overriding the real Dropbox hosts (integ fakes): one origin
    # serving /oauth2/token, the RPC API under /2, and content downloads
    # under /2. None means the production oauth/api/content hosts.
    endpoint: str | None = None
