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
from collections.abc import AsyncGenerator, Iterator
from contextlib import contextmanager
from functools import partial
from typing import Any

import aiohttp

from mirage.accessor.slack import SlackAccessor
from mirage.core.api.client import api_request, api_stream, status_error
from mirage.core.api.errors import ApiError
from mirage.core.slack.config import SlackConfig
from mirage.errors.fs import eacces
from mirage.types import PathSpec
from mirage.utils.ranges import window_for
from mirage.vfs.secrets import reveal_secret

logger = logging.getLogger(__name__)

REFUSED_ERRORS = frozenset(
    (
        "not_in_channel",
        "channel_not_found",
        "missing_scope",
        "is_archived",
        "not_authed",
    )
)


def _auth_token(config: SlackConfig, method: str) -> str:
    if method.startswith("search."):
        search_token: str = reveal_secret(config.search_token)
        if search_token:
            return search_token
    token: str = reveal_secret(config.token)
    return token


def slack_search_available(config: SlackConfig) -> bool:
    if reveal_secret(config.search_token):
        return True
    token: str = reveal_secret(config.token)
    return token.startswith("xoxp-")


def slack_headers(config: SlackConfig, method: str) -> dict[str, str]:
    auth_token = _auth_token(config, method)
    return {
        "Authorization": f"Bearer {auth_token}",
        "Content-Type": "application/json; charset=utf-8",
    }


class SlackApiError(ApiError):
    """A Slack call that failed: an ``ok: false`` payload, or a status
    that carried none.

    Args:
        message (str): the failure, in Slack's words where it gave any.
        status (int | None): the HTTP status, None for an ``ok: false``
            payload.
        slack_error (str): Slack's ``error`` code (``not_in_channel``),
            '' when the reply carried none.
    """

    def __init__(
        self, message: str, status: int | None = None, slack_error: str = ""
    ) -> None:
        super().__init__(message, status)
        self.slack_error = slack_error


def _format_slack_error_message(method: str, data: dict[str, Any]) -> str:
    err = data.get("error", "unknown_error")
    base = f"Slack API error ({method}): {err}"
    if err != "missing_scope":
        return base
    needed = data.get("needed") or ""
    if not needed:
        return base
    provided = data.get("provided") or "(none)"
    return f"{base} (needed: {needed}; provided: {provided})"


def _error_of(
    resp: aiohttp.ClientResponse, text: str, *, method: str
) -> Exception:
    # Slack reports failures as ok:false payloads, usually with a 200; a
    # non-2xx that still carries one keeps Slack's own wording.
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    if isinstance(data, dict):
        return SlackApiError(
            _format_slack_error_message(method, data),
            resp.status,
            str(data.get("error", "unknown_error")),
        )
    return SlackApiError(
        f"Slack API error ({method}): HTTP {resp.status}", resp.status
    )


def _checked(method: str, data: Any) -> dict[str, Any]:
    payload = data if isinstance(data, dict) else {}
    if not payload.get("ok"):
        raise SlackApiError(
            _format_slack_error_message(method, payload),
            slack_error=str(payload.get("error", "unknown_error")),
        )
    return payload


@contextmanager
def refusals_denied(path_spec: PathSpec) -> Iterator[None]:
    """Report a conversation Slack will not show as permission denied.

    ``not_in_channel``, ``missing_scope`` and the rest are Slack declining
    to show what the path names, never the conversation saying it is
    empty, so the path answers the way a directory the caller may not
    open does: ls names it and fails, find reports it and walks on.

    Args:
        path_spec (PathSpec): the path the operation was asked about.
    """
    try:
        yield
    except SlackApiError as exc:
        if exc.slack_error not in REFUSED_ERRORS:
            raise
        logger.debug("slack %s refused: %s", path_spec.virtual, exc)
        raise eacces(path_spec) from exc


async def slack_get(
    accessor: SlackAccessor,
    method: str,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    url = f"{accessor.config.base_url.rstrip('/')}/{method}"
    data = await api_request(
        "GET",
        url,
        error_of=partial(_error_of, method=method),
        headers=slack_headers(accessor.config, method),
        params=params,
        session=accessor.pool,
    )
    return _checked(method, data)


async def slack_post(
    accessor: SlackAccessor,
    method: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    url = f"{accessor.config.base_url.rstrip('/')}/{method}"
    data = await api_request(
        "POST",
        url,
        error_of=partial(_error_of, method=method),
        headers=slack_headers(accessor.config, method),
        json_body=body or {},
        session=accessor.pool,
    )
    return _checked(method, data)


async def download_file(
    accessor: SlackAccessor,
    url: str,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Download a Slack-hosted file blob, optionally only a byte range.

    Takes the window rather than a prepared header so the answer can be
    checked against it: Slack serves files from a CDN, and a server is
    free to ignore Range and reply 200 with the whole file, which
    ``api_request`` then trims.

    Args:
        accessor (SlackAccessor): Slack accessor.
        url (str): Slack file URL (typically url_private_download).
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.

    Returns:
        bytes: raw file content.
    """
    token = reveal_secret(accessor.config.token)
    data: bytes = await api_request(
        "GET",
        url,
        error_of=status_error,
        headers={"Authorization": f"Bearer {token}"},
        read="bytes",
        window=window_for(offset, size),
        session=accessor.pool,
    )
    return data


async def upload_bytes(accessor: SlackAccessor, url: str, data: bytes) -> None:
    """Send a file's bytes to the URL ``files.getUploadURLExternal`` issued.

    The URL is presigned, so the request carries no token.

    Args:
        accessor (SlackAccessor): Slack accessor.
        url (str): the issued ``upload_url``.
        data (bytes): the file's bytes.
    """
    await api_request(
        "POST",
        url,
        error_of=status_error,
        data=data,
        read="none",
        session=accessor.pool,
    )


def download_file_stream(
    accessor: SlackAccessor, url: str
) -> AsyncGenerator[bytes, None]:
    """Stream an attachment with bounded reads and response cleanup.

    Args:
        accessor (SlackAccessor): Slack accessor.
        url (str): attachment download URL.
    """
    token = reveal_secret(accessor.config.token)
    return api_stream(
        url,
        error_of=status_error,
        headers={"Authorization": f"Bearer {token}"},
        session=accessor.pool,
    )
