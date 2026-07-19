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

from pydantic import BaseModel, ConfigDict, SecretStr


class BoxConfig(BaseModel):
    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    # API origin override (e.g. an integ fake: http://127.0.0.1:5096). Token
    # and API URLs derive from it; defaults to the real api.box.com endpoints.
    endpoint: str | None = None
    client_id: str | None = None
    client_secret: SecretStr | None = None
    refresh_token: SecretStr | None = None
    # Box enterprise ID for the client-credentials grant (server auth apps).
    # With client_id + client_secret + enterprise_id set, tokens are minted
    # for the app's service account directly; no refresh token is involved
    # and expired tokens are simply re-fetched.
    enterprise_id: str | None = None
    # Pre-fetched access token (e.g. Box developer token from the app
    # console). Lasts ~60 minutes, can't be refreshed programmatically. When
    # set, the token manager skips the refresh flow entirely.
    access_token: SecretStr | None = None
    # Box folder id to mount as the workspace root instead of the account
    # root ("0"). Folder ids are stable across renames/moves and visible in
    # the Box web URL (box.com/folder/<id>), so a subfolder mount survives
    # reorganization that a path prefix would not.
    root_folder_id: str | None = None
    # Opt in to grep/rg content-search push-down: route recursive literal
    # scans through Box `/search` (name + server-indexed body text) to narrow
    # the file set before scanning locally, instead of walking the whole tree.
    # Off by default because Box's search index lags recent writes, so a
    # freshly-written mount would under-report until the index catches up.
    content_search: bool = False
    refresh_fn: Callable[[str], Awaitable[tuple[str, str, int]]] | None = None
    # Box rotates the refresh token on each refresh. Set
    # on_refresh_token_rotated to persist the new token (e.g. write to disk
    # or a vault) so the next process restart starts from the latest token
    # rather than the original one (which is invalid after first use).
    on_refresh_token_rotated: Callable[[str], Awaitable[None]] | None = None
