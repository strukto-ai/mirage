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

from typing import Any

import aiohttp
from pydantic import SecretStr

from mirage.core.github._client import github_headers, github_url


async def ci_get(token: SecretStr,
                 path: str,
                 params: dict[str, Any] | None = None,
                 **kwargs: str) -> dict[str, Any]:
    url = github_url(path, **kwargs)
    headers = github_headers(token)
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers, params=params) as resp:
            resp.raise_for_status()
            return await resp.json()


async def ci_get_bytes(token: SecretStr, path: str, **kwargs: str) -> bytes:
    url = github_url(path, **kwargs)
    headers = github_headers(token)
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers,
                               allow_redirects=True) as resp:
            resp.raise_for_status()
            return await resp.read()


async def ci_get_paginated(token: SecretStr,
                           path: str,
                           list_key: str,
                           params: dict[str, Any] | None = None,
                           max_results: int | None = None,
                           **kwargs: str) -> list[dict[str, Any]]:
    params = dict(params or {})
    params.setdefault("per_page", 100)
    page = 1
    results: list[dict[str, Any]] = []
    url = github_url(path, **kwargs)
    headers = github_headers(token)
    async with aiohttp.ClientSession() as session:
        while True:
            params["page"] = page
            async with session.get(url, headers=headers,
                                   params=params) as resp:
                resp.raise_for_status()
                data = await resp.json()
            batch = data[list_key]
            results.extend(batch)
            if max_results is not None and len(results) >= max_results:
                results = results[:max_results]
                break
            if len(batch) < params["per_page"]:
                break
            page += 1
    return results
