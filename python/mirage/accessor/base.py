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

from types import TracebackType
from typing import Self

import aiohttp

from mirage.core.api.client import SessionPool


class Accessor:

    async def close(self) -> None:
        return None


class SessionAccessor(Accessor):
    """An accessor whose backend is reached over HTTP.

    Owns the connection pool its backend's calls ride (see
    ``SessionPool`` for why per-call sessions are not an option), so a
    resource drains it through the ordinary ``close`` chain. A one-shot
    accessor, which is what a CLI verb builds per invocation, is used
    as an async context manager instead. Callers thread the inert
    ``pool``; ``resolve_session`` materializes it at the request.

    Args:
        timeout (aiohttp.ClientTimeout | None): applied to the pool's
            session at creation; None takes aiohttp's default.
    """

    def __init__(self, timeout: aiohttp.ClientTimeout | None = None) -> None:
        self.pool = SessionPool(timeout=timeout)

    async def close(self) -> None:
        await self.pool.close()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, exc_type: type[BaseException] | None,
                        exc: BaseException | None,
                        tb: TracebackType | None) -> None:
        await self.close()


class NOOPAccessor(Accessor):
    pass
