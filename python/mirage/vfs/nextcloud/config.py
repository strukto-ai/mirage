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


class NextcloudConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    url: str
    """WebDAV URL of the user's files, such as
    `https://cloud.example.com/remote.php/dav/files/alice/`."""
    username: str | None = None
    """Basic Auth user name; unset sends requests without credentials."""
    password: SecretStr | None = None
    """Basic Auth password; use an app password (Settings → Security)
    rather than the account password."""
    verify_ssl: bool = True
    """Verify the server's TLS certificate on the WebDAV requests mirage
    sends itself (copy, checksum, quota, properties, search, the chunks of
    a large write); reads, other writes and listings go through OpenDAL,
    which always verifies."""
    timeout: int = 30
    """Seconds one WebDAV request mirage sends itself (copy, checksum,
    quota, properties, search, the chunks of a large write) may take; reads,
    other writes and listings go through OpenDAL and its own timeouts."""
