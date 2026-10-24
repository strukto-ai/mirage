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

from collections.abc import Awaitable, Callable

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from mirage.vfs.constants import WALK_LIMIT


class BoxConfig(BaseModel):
    model_config = ConfigDict(
        frozen=True, arbitrary_types_allowed=True, extra="forbid"
    )

    endpoint: str | None = None
    """Base URL that replaces Box's API, upload and OAuth token hosts, such
    as a test server. Unset uses Box's hosts."""
    client_id: str | None = None
    """Box app client ID. Required with `refresh_token` (OAuth) or with
    `client_secret` and `enterprise_id` (client credentials)."""
    client_secret: SecretStr | None = None
    """Box app client secret. Required for client credentials; the OAuth
    refresh sends it when set, so a PKCE client can omit it."""
    refresh_token: SecretStr | None = None
    """OAuth refresh token; needs `client_id`. Box rotates it on every
    refresh, so persist the new one with `on_refresh_token_rotated`."""
    enterprise_id: str | None = None
    """Box enterprise ID for the client-credentials grant. With `client_id`
    and `client_secret`, tokens are minted for the app's service account
    and no refresh token is involved."""
    access_token: SecretStr | None = None
    """Box developer token, used as is with no refresh flow; it expires
    after about 60 minutes. It wins over every other credential."""
    root_folder_id: str | None = None
    """Box folder ID the mount uses as its root, from the folder's web URL
    (`box.com/folder/<id>`); unlike a path it survives renames and moves.
    Unset mounts the account root, folder `0`."""
    walk_limit: int = Field(default=WALK_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit and reads every file without asking Box
    search, which lags writes."""
    refresh_fn: Callable[[str], Awaitable[tuple[str, str, int]]] | None = None
    """Async callable that takes the current refresh token and returns
    `(access_token, refresh_token, expires_in)`, called instead of Box's
    token endpoint. Needs `client_id` and `refresh_token`."""
    on_refresh_token_rotated: Callable[[str], Awaitable[None]] | None = None
    """Async callable given the new refresh token whenever a refresh rotates
    it, to persist it; the token it replaces stops working after its first
    use."""
