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

import aiohttp

from mirage.resource.discord.config import DiscordConfig
from mirage.resource.secrets import reveal_secret

DISCORD_API = "https://discord.com/api/v10"
MAX_RETRIES = 3


def discord_headers(config: DiscordConfig) -> dict[str, str]:
    return {"Authorization": f"Bot {reveal_secret(config.token)}"}


async def discord_get(
    config: DiscordConfig,
    endpoint: str,
    params: dict | None = None,
) -> dict | list:
    url = f"{DISCORD_API}{endpoint}"
    headers = discord_headers(config)
    for attempt in range(MAX_RETRIES):
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers,
                                   params=params) as resp:
                if resp.status == 429:
                    data = await resp.json()
                    retry = data.get("retry_after", 1)
                    if attempt < MAX_RETRIES - 1:
                        await asyncio.sleep(retry)
                        continue
                    raise RuntimeError(
                        f"Rate limited after {MAX_RETRIES} retries")
                resp.raise_for_status()
                return await resp.json()
    return []


async def discord_post(
    config: DiscordConfig,
    endpoint: str,
    body: dict | None = None,
) -> dict:
    url = f"{DISCORD_API}{endpoint}"
    headers = discord_headers(config)
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=body or {}) as resp:
            if resp.status == 429:
                data = await resp.json()
                retry = data.get("retry_after", 1)
                raise RuntimeError(f"Rate limited, retry after {retry}s")
            resp.raise_for_status()
            return await resp.json()


async def discord_put(
    config: DiscordConfig,
    endpoint: str,
) -> None:
    url = f"{DISCORD_API}{endpoint}"
    headers = discord_headers(config)
    async with aiohttp.ClientSession() as session:
        async with session.put(url, headers=headers) as resp:
            if resp.status == 429:
                data = await resp.json()
                retry = data.get("retry_after", 1)
                raise RuntimeError(f"Rate limited, retry after {retry}s")
            resp.raise_for_status()
