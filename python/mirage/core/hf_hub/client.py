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

import logging
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import quote

import aiohttp
from pydantic import SecretStr

from mirage.core.api.client import (ApiResponse, RetryPolicy, SessionArg,
                                    api_request, resolve_session, status_error)
from mirage.core.hf_hub.constants import (API_BASE, API_SEGMENTS, MAX_RETRIES,
                                          RESOLVE_SEGMENTS, RETRY_STATUSES)
from mirage.resource.secrets import reveal_secret
from mirage.types import JsonValue
from mirage.utils.ranges import ByteWindow

logger = logging.getLogger(__name__)

RETRY = RetryPolicy(
    statuses=RETRY_STATUSES,
    max_retries=MAX_RETRIES,
    delay_source="header",
    retry_transport=True,
)


class HfHubError(Exception):
    """A Hub call that answered with a status the caller cannot use.

    Args:
        message (str): what the Hub said, its own wording where it gave one.
        status (int): the HTTP status.
        error_code (str): the Hub's ``X-Error-Code``, "" when it sent
            none. The status alone cannot tell its refusals apart: a
            missing repository, a missing revision and a missing file
            are all 404, and only this header says which
            (``RepoNotFound`` / ``RevisionNotFound`` / ``EntryNotFound``).
    """

    def __init__(self,
                 message: str,
                 status: int,
                 error_code: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.error_code = error_code


def hub_headers(token: SecretStr | None) -> dict[str, str]:
    """Auth and accept headers for one Hub call.

    An anonymous call is a first-class case here, unlike GitHub's: the Hub
    serves every public repo without a token, so a mount with no credential
    reads normally and only the write path needs one.

    Args:
        token (SecretStr | None): the user access token, when configured.

    Returns:
        dict[str, str]: headers to send.
    """
    headers = {"Accept": "application/json"}
    secret = reveal_secret(token)
    if secret:
        headers["Authorization"] = f"Bearer {secret}"
    return headers


def rev_segment(revision: str) -> str:
    """One revision, encoded as a single URL path segment.

    A git ref may hold a slash (`feature/foo`, `refs/pr/1`), and every
    Hub route reads the segment after the verb as the whole revision, so
    an unencoded one splits: `/tree/feature/foo` names revision
    `feature` and subtree `foo`. huggingface_hub encodes it the same way
    (`quote(revision, safe="")`).

    Args:
        revision (str): branch, tag or commit.

    Returns:
        str: the revision as one encoded segment.
    """
    return quote(revision, safe="")


def api_url(endpoint: str, repo_type: str, repo_id: str, suffix: str) -> str:
    """The /api URL for one repository-scoped endpoint.

    Args:
        endpoint (str): the Hub origin.
        repo_type (str): "model", "dataset" or "space".
        repo_id (str): "namespace/name".
        suffix (str): what follows the repo id, leading slash included, or
            "" for the repo object itself.

    Returns:
        str: the absolute URL.
    """
    segment = API_SEGMENTS[repo_type]
    return f"{endpoint.rstrip('/')}/api/{segment}/{repo_id}{suffix}"


def repo_url(endpoint: str, repo_type: str, repo_id: str) -> str:
    """The web URL of a repository, which is what the CLI echoes.

    A model sits at the origin root and the other two kinds sit under a
    plural segment, the same split ``resolve_url`` walks.

    Args:
        endpoint (str): the Hub origin.
        repo_type (str): "model", "dataset" or "space".
        repo_id (str): "namespace/name".

    Returns:
        str: the absolute URL of the repository's landing page.
    """
    segment = RESOLVE_SEGMENTS[repo_type]
    base = f"{endpoint.rstrip('/')}/"
    if segment:
        base += f"{segment}/"
    return f"{base}{repo_id}"


def resolve_url(endpoint: str, repo_type: str, repo_id: str, revision: str,
                path: str) -> str:
    """The content URL for one file at one revision.

    The path is percent-encoded per segment: a Hub repo may hold a file
    whose name carries a space or a "#", and pasting it raw truncates the
    URL at the fragment.

    Args:
        endpoint (str): the Hub origin.
        repo_type (str): "model", "dataset" or "space".
        repo_id (str): "namespace/name".
        revision (str): branch, tag or commit.
        path (str): the repo-relative file path.

    Returns:
        str: the absolute URL, which answers a 302/307 to the CDN.
    """
    segment = RESOLVE_SEGMENTS[repo_type]
    base = f"{endpoint.rstrip('/')}/"
    if segment:
        base += f"{segment}/"
    return (f"{base}{repo_id}/resolve/{rev_segment(revision)}/"
            f"{quote(path.lstrip('/'))}")


def _error_of(resp: aiohttp.ClientResponse, text: str) -> Exception:
    """Map a failing Hub response to the backend's own exception.

    The Hub reports its reason in an ``X-Error-Message`` header as well as
    in the body, and the header is the one that survives a HEAD, so it is
    preferred. Falling back to the body keeps the wording the Hub chose
    rather than inventing one.

    Args:
        resp (aiohttp.ClientResponse): the >= 400 response.
        text (str): the response body.

    Returns:
        Exception: an HfHubError carrying the status and error code.
    """
    message = resp.headers.get("X-Error-Message") or text.strip()
    return HfHubError(message or (resp.reason or "request failed"),
                      resp.status,
                      resp.headers.get("X-Error-Code") or "")


async def hub_get(
    token: SecretStr | None,
    url: str,
    params: dict[str, Any] | None = None,
    *,
    session: SessionArg = None,
) -> JsonValue:
    """One GET against the Hub API, decoded as JSON."""
    data: JsonValue = await api_request(
        "GET",
        url,
        error_of=_error_of,
        headers=hub_headers(token),
        params=params,
        retry=RETRY,
        session=session,
    )
    return data


async def hub_get_response(
    token: SecretStr | None,
    url: str,
    params: dict[str, Any] | None = None,
    *,
    session: SessionArg = None,
) -> ApiResponse:
    """One GET retaining status and headers, which tree pagination reads."""
    response: ApiResponse = await api_request(
        "GET",
        url,
        error_of=_error_of,
        headers=hub_headers(token),
        params=params,
        retry=RETRY,
        read="response",
        session=session,
    )
    return response


async def hub_post(
    token: SecretStr | None,
    url: str,
    body: JsonValue,
    params: dict[str, Any] | None = None,
    *,
    session: SessionArg = None,
) -> JsonValue:
    """One JSON POST against the Hub API."""
    data: JsonValue = await api_request(
        "POST",
        url,
        error_of=_error_of,
        headers=hub_headers(token),
        params=params,
        json_body=body,
        json_body_present=True,
        retry=RETRY,
        session=session,
    )
    return data


async def hub_request(
    token: SecretStr | None,
    method: str,
    url: str,
    body: JsonValue,
    params: dict[str, Any] | None = None,
    *,
    session: SessionArg = None,
) -> JsonValue:
    """One arbitrary JSON call against the Hub API.

    An explicit None body is still sent as a body here, because the
    endpoints that need this are DELETEs the Hub expects a JSON object
    on; a caller that means "no body at all" passes None and gets one,
    which those same endpoints tolerate.

    Args:
        token (SecretStr | None): the user access token.
        method (str): the HTTP method.
        url (str): the absolute URL.
        body (JsonValue): the JSON body.
        params (dict[str, Any] | None): query parameters.
        session (SessionArg): pool or live session to ride.

    Returns:
        JsonValue: the decoded body, None for an empty one.
    """
    data: JsonValue = await api_request(
        method.upper(),
        url,
        error_of=_error_of,
        headers=hub_headers(token),
        params=params,
        json_body=body,
        json_body_present=body is not None,
        retry=RETRY,
        session=session,
    )
    return data


async def hub_post_ndjson(
    token: SecretStr | None,
    url: str,
    payload: bytes,
    params: dict[str, Any] | None = None,
    *,
    session: SessionArg = None,
) -> JsonValue:
    """One newline-delimited-JSON POST, which is the commit endpoint's shape.

    Args:
        token (SecretStr | None): the user access token.
        url (str): the commit URL.
        payload (bytes): the already-serialized ndjson body.
        params (dict[str, Any] | None): query parameters.
        session (SessionArg): pool or live session to ride.

    Returns:
        JsonValue: the decoded commit response.
    """
    headers = {
        **hub_headers(token),
        "Content-Type": "application/x-ndjson",
    }
    data: JsonValue = await api_request(
        "POST",
        url,
        error_of=_error_of,
        headers=headers,
        params=params,
        data=payload,
        retry=RETRY,
        session=session,
    )
    return data


async def hub_bytes(
    token: SecretStr | None,
    url: str,
    window: ByteWindow | None = None,
    *,
    session: SessionArg = None,
) -> bytes:
    """Fetch file content, optionally a byte window of it.

    ``/resolve`` answers a redirect to the CDN and aiohttp follows it by
    default, carrying the Range along, so a window costs no extra round
    trip.

    Args:
        token (SecretStr | None): the user access token.
        url (str): the resolve URL.
        window (ByteWindow | None): the byte range to ask for.
        session (SessionArg): pool or live session to ride.

    Returns:
        bytes: the content, trimmed to the window when the CDN ignored
        the Range header.
    """
    content: bytes = await api_request(
        "GET",
        url,
        error_of=_error_of,
        headers=hub_headers(token),
        retry=RETRY,
        read="bytes",
        window=window,
        session=session,
    )
    return content


async def hub_stream(
    token: SecretStr | None,
    url: str,
    chunk_size: int,
    *,
    session: SessionArg = None,
) -> AsyncIterator[bytes]:
    """Stream file content without holding it whole in memory.

    Not routed through ``api_request``: that reads the body to completion
    before returning, which is the opposite of what a stream is for. The
    redirect to the CDN is followed by aiohttp itself.

    Args:
        token (SecretStr | None): the user access token.
        url (str): the resolve URL.
        chunk_size (int): bytes per yielded chunk.
        session (SessionArg): pool or live session to ride.

    Yields:
        bytes: the next chunk of content.

    Raises:
        HfHubError: the Hub or the CDN refused.
    """
    sess, own = resolve_session(session)
    try:
        async with sess.get(url, headers=hub_headers(token)) as resp:
            if resp.status >= 400:
                raise _error_of(resp, await resp.text())
            async for chunk in resp.content.iter_chunked(chunk_size):
                yield chunk
    finally:
        if own:
            await sess.close()


__all__ = [
    "HfHubError",
    "api_url",
    "hub_bytes",
    "hub_get",
    "hub_get_response",
    "hub_headers",
    "hub_post",
    "hub_post_ndjson",
    "hub_request",
    "hub_stream",
    "resolve_url",
    "status_error",
    "API_BASE",
]
