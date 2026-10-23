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

from collections.abc import Callable

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

from mirage.vfs.constants import FULL_SCAN_LIMIT


class GoogleConfig(BaseModel):
    model_config = ConfigDict(
        arbitrary_types_allowed=True, frozen=True, extra="forbid"
    )

    # Two ways to authenticate, the same two MsGraphConfig offers.
    #
    # A pre-minted token, either a fixed SecretStr or a provider called
    # on every request. The provider is how a caller that already owns
    # the OAuth dance (a service account, a host application's token
    # source) plugs in: it caches and refreshes on its own, so mirage
    # holds no long-lived credential and never contacts the token
    # endpoint. Without it the only way in was `refresh_token`, which a
    # service account cannot produce; a consumer worked around that by
    # monkeypatching `refresh_access_token`.
    access_token: SecretStr | Callable[[], str | SecretStr] | None = None
    """OAuth access token, or a callable that returns one. Takes precedence
    over `client_id` and `refresh_token`."""
    # Or the refresh-token grant, where mirage mints and renews the
    # access token itself through TokenManager.
    client_id: str | None = None
    """Google OAuth client ID. Required with `refresh_token` when
    `access_token` is unset; mirage then mints and renews access tokens
    itself."""
    client_secret: SecretStr | None = None
    """Google OAuth client secret, sent with the refresh-token grant. Omit
    it for a PKCE client."""
    refresh_token: SecretStr | None = None
    """User's OAuth refresh token. Required with `client_id` when
    `access_token` is unset."""
    api_base: str | None = None
    """One base URL that replaces every Google API host and the OAuth token
    endpoint, such as a test server. Unset uses Google's hosts."""
    folder_id: str | None = None
    """Drive folder ID the `gdrive` mount uses as its root instead of My
    Drive; it may be a folder in a Shared Drive. Other Google mounts ignore
    it."""

    @model_validator(mode="after")
    def _one_credential(self) -> "GoogleConfig":
        """Refuse a config that names neither way to authenticate.

        Both fields became optional so either grant can stand alone, so
        this is what keeps a mount from being built with no credential
        at all and failing on the first read instead.

        Returns:
            GoogleConfig: the validated config.

        Raises:
            ValueError: neither an access_token nor a client_id plus
                refresh_token pair was supplied.
        """
        if self.access_token is not None:
            return self
        if self.client_id is not None and self.refresh_token is not None:
            return self
        raise ValueError(
            "GoogleConfig needs either access_token (a token or a provider "
            "callable) or both client_id and refresh_token"
        )


class GoogleAppConfig(GoogleConfig):
    full_scan_limit: int = Field(default=FULL_SCAN_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit and reads every file without asking Drive
    full-text search, which searches a file's text, not the JSON the mount
    renders."""
