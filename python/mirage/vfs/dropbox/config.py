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


class DropboxConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    client_id: str
    """Dropbox app key."""
    client_secret: SecretStr
    """Dropbox app secret."""
    refresh_token: SecretStr
    """Long-lived OAuth refresh token; mirage mints short-lived access
    tokens from it."""
    root_path: str = "/"
    """Dropbox folder the mount uses as its root, such as `/Projects`; `/`
    is the account root. `..` segments are rejected."""
    endpoint: str | None = None
    """Base URL that replaces Dropbox's OAuth, API and content hosts, such
    as a test server. Unset uses Dropbox's hosts."""
