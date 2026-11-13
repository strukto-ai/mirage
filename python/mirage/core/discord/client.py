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
from functools import partial
from typing import Any

import aiohttp

from mirage.accessor.discord import DiscordAccessor
from mirage.core.api.client import (
    NO_RETRY,
    RetryPolicy,
    api_request,
    status_error,
)
from mirage.core.api.errors import ApiError
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


def _discord_error(
    resp: aiohttp.ClientResponse, body: str, *, retried: bool
) -> Exception:
    if resp.status != 429:
        return status_error(resp, body)
    if retried:
        return ApiError(f"Rate limited after {MAX_RETRIES} retries", 429)
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    retry = data.get("retry_after", 1) if isinstance(data, dict) else 1
    return ApiError(f"Rate limited, retry after {retry}s", 429)


async def discord_request(
    accessor: DiscordAccessor,
    method: str,
    endpoint: str,
    params: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
    form: aiohttp.FormData | None = None,
) -> Any:
    """One Discord call, sent to the config's ``base_url`` when it names
    one (the integ fake stands in for discord.com that way).

    POST and PATCH send a JSON body, ``{}`` when none is given, or a
    multipart ``form`` in its place; PUT and DELETE send none and read no
    answer.

    Args:
        accessor (DiscordAccessor): Discord accessor.
        method (str): the HTTP method.
        endpoint (str): API path, e.g. ``/channels/{id}/messages``.
        params (dict[str, Any] | None): query parameters.
        body (dict[str, Any] | None): the JSON body of a POST or PATCH.
        form (aiohttp.FormData | None): a multipart body sent in place of
            the JSON one.
    """
    sends_json = method in ("POST", "PATCH") and form is None
    return await api_request(
        method,
        f"{(accessor.config.base_url or DISCORD_API).rstrip('/')}{endpoint}",
        error_of=partial(_discord_error, retried=method == "GET"),
        headers={
            "Authorization": f"Bot {reveal_secret(accessor.config.token)}"
        },
        params=params,
        json_body=(body or {}) if sends_json else None,
        data=form,
        retry=_RATE_LIMIT_RETRY if method == "GET" else NO_RETRY,
        read="none" if method in ("PUT", "DELETE") else "json",
        session=accessor.pool,
    )


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
    data: dict[str, Any] = await discord_request(
        accessor, "POST", endpoint, form=form
    )
    return data
