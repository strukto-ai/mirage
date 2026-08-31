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
from typing import Any

import aiohttp

from mirage.core.api.client import (RetryPolicy, SessionArg, api_request,
                                    status_error)
from mirage.core.discord.config import DiscordConfig
from mirage.core.discord.constants import DISCORD_API, MAX_RETRIES
from mirage.resource.secrets import reveal_secret

# GET is the only verb that waits out a 429: reads are safe to repeat, and
# the delay comes from the JSON body's retry_after (Discord's convention).
# Mutations surface the 429 immediately so the caller decides.
_RATE_LIMIT_RETRY = RetryPolicy(statuses=frozenset({429}),
                                max_retries=MAX_RETRIES - 1,
                                delay_source="body")


def discord_headers(config: DiscordConfig) -> dict[str, str]:
    return {"Authorization": f"Bot {reveal_secret(config.token)}"}


def discord_base(config: DiscordConfig) -> str:
    # base_url exists so the integ fake can stand in for discord.com; every
    # request must go through it, not the module constant.
    return (config.base_url or DISCORD_API).rstrip("/")


def _retry_after_of(body: str) -> Any:
    try:
        data = json.loads(body)
    except ValueError:
        return 1
    if isinstance(data, dict):
        return data.get("retry_after", 1)
    return 1


def _get_error(resp: aiohttp.ClientResponse, body: str) -> Exception:
    if resp.status == 429:
        return RuntimeError(f"Rate limited after {MAX_RETRIES} retries")
    return status_error(resp, body)


def _mutation_error(resp: aiohttp.ClientResponse, body: str) -> Exception:
    if resp.status == 429:
        retry = _retry_after_of(body)
        return RuntimeError(f"Rate limited, retry after {retry}s")
    return status_error(resp, body)


async def discord_get(
        config: DiscordConfig,
        endpoint: str,
        params: dict[str, Any] | None = None,
        session: SessionArg = None) -> dict[str, Any] | list[Any]:
    data: dict[str, Any] | list[Any] = await api_request(
        "GET",
        f"{discord_base(config)}{endpoint}",
        error_of=_get_error,
        headers=discord_headers(config),
        params=params,
        retry=_RATE_LIMIT_RETRY,
        session=session)
    return data


async def discord_post(config: DiscordConfig,
                       endpoint: str,
                       body: dict[str, Any] | None = None,
                       session: SessionArg = None) -> dict[str, Any]:
    data: dict[str,
               Any] = await api_request("POST",
                                        f"{discord_base(config)}{endpoint}",
                                        error_of=_mutation_error,
                                        headers=discord_headers(config),
                                        json_body=body or {},
                                        session=session)
    return data


async def discord_put(config: DiscordConfig,
                      endpoint: str,
                      session: SessionArg = None) -> None:
    await api_request("PUT",
                      f"{discord_base(config)}{endpoint}",
                      error_of=_mutation_error,
                      headers=discord_headers(config),
                      read="none",
                      session=session)


async def discord_patch(config: DiscordConfig,
                        endpoint: str,
                        body: dict[str, Any] | None = None,
                        session: SessionArg = None) -> dict[str, Any]:
    data: dict[str,
               Any] = await api_request("PATCH",
                                        f"{discord_base(config)}{endpoint}",
                                        error_of=_mutation_error,
                                        headers=discord_headers(config),
                                        json_body=body or {},
                                        session=session)
    return data


async def discord_delete(config: DiscordConfig,
                         endpoint: str,
                         session: SessionArg = None) -> None:
    await api_request("DELETE",
                      f"{discord_base(config)}{endpoint}",
                      error_of=_mutation_error,
                      headers=discord_headers(config),
                      read="none",
                      session=session)
