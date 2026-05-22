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

from mirage.resource.secrets import reveal_secret
from mirage.resource.telegram.config import TelegramConfig

TELEGRAM_API = "https://api.telegram.org"
MAX_RETRIES = 3


async def telegram_get(
    config: TelegramConfig,
    method: str,
    params: dict | None = None,
) -> dict:
    url = f"{TELEGRAM_API}/bot{reveal_secret(config.token)}/{method}"
    for attempt in range(MAX_RETRIES):
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params) as resp:
                if resp.status == 429:
                    data = await resp.json()
                    retry = data.get("parameters", {}).get("retry_after", 1)
                    if attempt < MAX_RETRIES - 1:
                        await asyncio.sleep(retry)
                        continue
                    raise RuntimeError(
                        f"Rate limited after {MAX_RETRIES} retries")
                resp.raise_for_status()
                data = await resp.json()
                if not data.get("ok"):
                    raise RuntimeError(
                        f"Telegram API error: {data.get('description', '')}")
                return data.get("result", {})
    return {}


async def telegram_post(
    config: TelegramConfig,
    method: str,
    body: dict | None = None,
) -> dict:
    url = f"{TELEGRAM_API}/bot{reveal_secret(config.token)}/{method}"
    async with aiohttp.ClientSession() as session:
        async with session.post(url, json=body or {}) as resp:
            if resp.status == 429:
                data = await resp.json()
                retry = data.get("parameters", {}).get("retry_after", 1)
                raise RuntimeError(f"Rate limited, retry after {retry}s")
            resp.raise_for_status()
            data = await resp.json()
            if not data.get("ok"):
                raise RuntimeError(
                    f"Telegram API error: {data.get('description', '')}")
            return data.get("result", {})
