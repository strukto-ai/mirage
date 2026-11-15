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

import asyncio
import time
from collections.abc import Awaitable, Callable

import jwt

from mirage.core.github.config import GitHubAppAuth
from mirage.vfs.secrets import reveal_secret

# GitHub refuses an App JWT that lives longer than ten minutes, and checks
# `iat` against its own clock, so the JWT is backdated a minute and expires
# in nine: a host clock a little off either way still mints.
JWT_BACKDATE = 60
JWT_LIFETIME = 540
# An installation token lasts an hour. It is replaced five minutes before
# it expires, so a call that starts on an old token still finishes on it.
REFRESH_MARGIN = 300.0

# A minted token and its expiry, in epoch seconds.
MintedToken = tuple[str, float]


def app_jwt(app: GitHubAppAuth, now: float | None = None) -> str:
    """The JWT an App signs to mint installation tokens: RS256, issued by
    the App.

    Args:
        app (GitHubAppAuth): the App, its ID and private key.
        now (float | None): the clock, in epoch seconds; unset reads it.
    """
    issued = int(time.time() if now is None else now)
    payload = {
        "iat": issued - JWT_BACKDATE,
        "exp": issued + JWT_LIFETIME,
        "iss": str(app.app_id),
    }
    # A key kept on one line, as an env var or a dotenv entry holds it,
    # spells its newlines `\n`; PEM needs real ones.
    key = reveal_secret(app.private_key).replace("\\n", "\n")
    return jwt.encode(payload, key, algorithm="RS256")


class AppTokens:
    """The current installation token of one App installation.

    Shared by every account riding the same installation, so they mint
    one token between them rather than one each.

    Args:
        app (GitHubAppAuth): the installation the tokens act for.
    """

    def __init__(self, app: GitHubAppAuth) -> None:
        self.app = app
        self._token: str | None = None
        self._expires = 0.0
        # One mint at a time: concurrent first calls wait for the token
        # the first one mints instead of each minting their own.
        self._lock = asyncio.Lock()

    async def token(self, mint: Callable[[], Awaitable[MintedToken]]) -> str:
        """The cached token, or a new one from ``mint`` when there is none
        or it is within five minutes of expiring.

        Args:
            mint (Callable[[], Awaitable[MintedToken]]): mints a
                token, returning it and its expiry in epoch seconds.
        """
        async with self._lock:
            if (
                self._token is None
                or time.time() >= self._expires - REFRESH_MARGIN
            ):
                self._token, self._expires = await mint()
            return self._token
