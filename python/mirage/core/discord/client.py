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
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import aiohttp

from mirage.accessor.discord import DiscordAccessor
from mirage.core.api.client import RetryPolicy, api_request, status_error
from mirage.core.api.errors import ApiError
from mirage.core.discord.config import DiscordConfig
from mirage.core.discord.constants import (
    DISCORD_API,
    GONE_STATUS,
    MAX_RETRIES,
    REFUSED_STATUSES,
)
from mirage.errors.fs import eacces, enoent
from mirage.types import PathSpec
from mirage.utils.filetype import mime_type_for
from mirage.vfs.secrets import reveal_secret

logger = logging.getLogger(__name__)

# GET is the only verb that waits out a 429: reads are safe to repeat, and
# the delay comes from the JSON body's retry_after (Discord's convention).
# Mutations surface the 429 immediately so the caller decides.
_RATE_LIMIT_RETRY = RetryPolicy(
    statuses=frozenset({429}), max_retries=MAX_RETRIES - 1, delay_source="body"
)


@contextmanager
def refusals_denied(path_spec: PathSpec) -> Iterator[None]:
    """Report a channel Discord will not show as permission denied.

    A 401 or 403 (Missing Access) is Discord declining to show what the
    path names, never the channel saying it is empty, so the path answers
    the way a directory the caller may not open does: ls names it and
    fails, find reports it and walks on. A 404 is the channel gone since
    it was listed. Any other failure, a 429 that outlasted its retries
    among them, propagates.

    Args:
        path_spec (PathSpec): the path the operation was asked about.
    """
    try:
        yield
    except ApiError as exc:
        if exc.status in REFUSED_STATUSES:
            logger.debug("discord %s refused: %s", path_spec.virtual, exc)
            raise eacces(path_spec) from exc
        if exc.status == GONE_STATUS:
            raise enoent(path_spec) from exc
        raise


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
        return ApiError(f"Rate limited after {MAX_RETRIES} retries", 429)
    return status_error(resp, body)


def _mutation_error(resp: aiohttp.ClientResponse, body: str) -> Exception:
    if resp.status == 429:
        retry = _retry_after_of(body)
        return ApiError(f"Rate limited, retry after {retry}s", 429)
    return status_error(resp, body)


async def discord_get(
    accessor: DiscordAccessor,
    endpoint: str,
    params: dict[str, Any] | None = None,
) -> dict[str, Any] | list[Any]:
    data: dict[str, Any] | list[Any] = await api_request(
        "GET",
        f"{discord_base(accessor.config)}{endpoint}",
        error_of=_get_error,
        headers=discord_headers(accessor.config),
        params=params,
        retry=_RATE_LIMIT_RETRY,
        session=accessor.pool,
    )
    return data


async def discord_post(
    accessor: DiscordAccessor,
    endpoint: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await api_request(
        "POST",
        f"{discord_base(accessor.config)}{endpoint}",
        error_of=_mutation_error,
        headers=discord_headers(accessor.config),
        json_body=body or {},
        session=accessor.pool,
    )
    return data


async def discord_post_files(
    accessor: DiscordAccessor,
    endpoint: str,
    body: dict[str, Any],
    files: list[tuple[str, bytes]],
) -> dict[str, Any]:
    """POST a message with attachments, as Discord takes them: a
    multipart body whose ``payload_json`` part is the JSON body and whose
    ``files[n]`` parts are the files, each named by an ``attachments``
    entry of the same id.

    Args:
        accessor (DiscordAccessor): Discord accessor.
        endpoint (str): API path, e.g. ``/channels/{id}/messages``.
        body (dict[str, Any]): the message fields.
        files (list[tuple[str, bytes]]): each file's name and bytes.
    """
    form = aiohttp.FormData()
    payload = {
        **body,
        "attachments": [
            {"id": i, "filename": name} for i, (name, _) in enumerate(files)
        ],
    }
    form.add_field(
        "payload_json", json.dumps(payload), content_type="application/json"
    )
    for i, (name, blob) in enumerate(files):
        form.add_field(
            f"files[{i}]",
            blob,
            filename=name,
            content_type=mime_type_for(name),
        )
    data: dict[str, Any] = await api_request(
        "POST",
        f"{discord_base(accessor.config)}{endpoint}",
        error_of=_mutation_error,
        headers=discord_headers(accessor.config),
        data=form,
        session=accessor.pool,
    )
    return data


async def discord_put(accessor: DiscordAccessor, endpoint: str) -> None:
    await api_request(
        "PUT",
        f"{discord_base(accessor.config)}{endpoint}",
        error_of=_mutation_error,
        headers=discord_headers(accessor.config),
        read="none",
        session=accessor.pool,
    )


async def discord_patch(
    accessor: DiscordAccessor,
    endpoint: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = await api_request(
        "PATCH",
        f"{discord_base(accessor.config)}{endpoint}",
        error_of=_mutation_error,
        headers=discord_headers(accessor.config),
        json_body=body or {},
        session=accessor.pool,
    )
    return data


async def discord_delete(accessor: DiscordAccessor, endpoint: str) -> None:
    await api_request(
        "DELETE",
        f"{discord_base(accessor.config)}{endpoint}",
        error_of=_mutation_error,
        headers=discord_headers(accessor.config),
        read="none",
        session=accessor.pool,
    )
