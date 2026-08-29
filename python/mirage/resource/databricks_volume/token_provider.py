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

from collections.abc import Awaitable
from typing import Protocol, runtime_checkable


@runtime_checkable
class TokenProvider(Protocol):
    """Where a Databricks bearer token comes from, per operation.

    The contract, which every implementation owes its caller:

    - ``get_token`` returns the raw token, without the ``Bearer``
      prefix. It may be sync or async; mirage awaits an awaitable.
    - mirage calls it before each independent Files API operation, so
      one user-visible command may consult it several times. Caching,
      refresh and locking belong to the provider, which is the only
      party that knows how its credential is minted.
    - mirage never stores, serializes or snapshots the provider or the
      token it returns, and never replays a request on 401: an
      on-behalf-of provider cannot re-mint a user's token, and a write
      must not be sent twice. A 401 surfaces as
      :class:`DatabricksVolumeApiError`.
    """

    def get_token(self) -> "str | Awaitable[str]":
        ...


class StaticTokenProvider:
    """A provider for one long-lived token, e.g. a personal access token.

    The only provider mirage ships. Anything that mints, refreshes or
    exchanges a credential (OAuth M2M, on-behalf-of, a CLI profile) is
    application code: it implements :class:`TokenProvider` and keeps its
    own dependencies, which is why mirage needs none of its own.
    """

    def __init__(self, token: str) -> None:
        """Hold one token.

        Args:
            token (str): the raw bearer token, no ``Bearer`` prefix.
        """
        self._token = token

    def get_token(self) -> str:
        return self._token
