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

import json
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import aiohttp

from mirage.resource.secrets import reveal_secret
from mirage.types import PathSpec

API_BASE = "https://api.github.com"
API_VERSION = "2022-11-28"


def github_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {reveal_secret(token)}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
    }


def github_url(path: str, **kwargs: str) -> str:
    return API_BASE + path.format(**kwargs)


async def github_get(token: str,
                     path: PathSpec,
                     params: dict | None = None,
                     **kwargs: str) -> dict:
    url = github_url(path, **kwargs)
    headers = github_headers(token)
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers, params=params) as resp:
            resp.raise_for_status()
            return await resp.json()


def github_get_sync(token: str,
                    path: PathSpec,
                    params: dict | None = None,
                    **kwargs: str) -> dict:
    url = github_url(path, **kwargs)
    if params:
        url = f"{url}?{urlencode(params)}"
    req = Request(url, headers=github_headers(token), method="GET")
    with urlopen(req) as resp:
        return json.loads(resp.read())
