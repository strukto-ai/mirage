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
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import aclosing
from dataclasses import replace
from typing import Any
from urllib.parse import quote

import aiohttp
from pydantic import SecretStr

from mirage.accessor.hf_hub import HfAccountAccessor
from mirage.core.api.client import (
    ApiResponse,
    RetryPolicy,
    api_request,
    api_stream,
    status_error,
)
from mirage.core.api.errors import ApiError
from mirage.core.hf_hub.constants import (
    API_BASE,
    API_SEGMENTS,
    MAX_RETRIES,
    RESOLVE_SEGMENTS,
    RETRY_STATUSES,
)
from mirage.types import JsonValue
from mirage.utils.ranges import ByteWindow
from mirage.vfs.secrets import reveal_secret

logger = logging.getLogger(__name__)

RETRY = RetryPolicy(
    statuses=RETRY_STATUSES,
    max_retries=MAX_RETRIES,
    delay_source="header",
    retry_transport=True,
)

# A write (a commit, a repository or a tag) retries only the statuses the
# Hub answers before it acts. A dropped connection may come after the write
# landed, and a resent commit would land twice.
WRITE_RETRY = replace(RETRY, retry_transport=False)


class HfHubError(ApiError):
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

    def __init__(
        self, message: str, status: int, error_code: str = ""
    ) -> None:
        super().__init__(message, status)
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


def resolve_url(
    endpoint: str, repo_type: str, repo_id: str, revision: str, path: str
) -> str:
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
    return (
        f"{base}{repo_id}/resolve/{rev_segment(revision)}/{quote_path(path)}"
    )


def quote_path(path: str) -> str:
    """A repo-relative path percent-encoded per segment, no leading slash.

    A Hub repo or bucket may hold a file whose name carries a space or a
    "#", and pasting it raw truncates the URL at the fragment.

    Args:
        path (str): the repo-relative path.

    Returns:
        str: the encoded path.
    """
    return quote(path.lstrip("/"))


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
    return HfHubError(
        message or (resp.reason or "request failed"),
        resp.status,
        resp.headers.get("X-Error-Code") or "",
    )


async def hub_get(
    account: HfAccountAccessor,
    url: str,
    params: dict[str, Any] | None = None,
) -> JsonValue:
    """One GET against the Hub API, decoded as JSON."""
    data: JsonValue = await api_request(
        "GET",
        url,
        error_of=_error_of,
        headers=hub_headers(account.token),
        params=params,
        retry=RETRY,
        session=account.pool,
    )
    return data


async def hub_get_response(
    account: HfAccountAccessor,
    url: str,
    params: dict[str, Any] | None = None,
) -> ApiResponse:
    """One GET retaining status and headers, which tree pagination reads."""
    response: ApiResponse = await api_request(
        "GET",
        url,
        error_of=_error_of,
        headers=hub_headers(account.token),
        params=params,
        retry=RETRY,
        read="response",
        session=account.pool,
    )
    return response


async def hub_post(
    account: HfAccountAccessor,
    url: str,
    body: JsonValue,
    params: dict[str, Any] | None = None,
    retry: RetryPolicy = RETRY,
) -> JsonValue:
    """One JSON POST against the Hub API.

    Args:
        account (HfAccountAccessor): the token and pool the call rides.
        url (str): the absolute URL.
        body (JsonValue): the JSON body.
        params (dict[str, Any] | None): query parameters.
        retry (RetryPolicy): RETRY for a POST that only reads (paths-info,
            preupload), WRITE_RETRY for one that changes the Hub.
    """
    data: JsonValue = await api_request(
        "POST",
        url,
        error_of=_error_of,
        headers=hub_headers(account.token),
        params=params,
        json_body=body,
        json_body_present=True,
        retry=retry,
        session=account.pool,
    )
    return data


async def hub_request(
    account: HfAccountAccessor,
    method: str,
    url: str,
    body: JsonValue,
    params: dict[str, Any] | None = None,
) -> JsonValue:
    """One arbitrary JSON call against the Hub API.

    An explicit None body is still sent as a body here, because the
    endpoints that need this are DELETEs the Hub expects a JSON object
    on; a caller that means "no body at all" passes None and gets one,
    which those same endpoints tolerate.

    Args:
        account (HfAccountAccessor): the token and pool the call rides.
        method (str): the HTTP method.
        url (str): the absolute URL.
        body (JsonValue): the JSON body.
        params (dict[str, Any] | None): query parameters.

    Returns:
        JsonValue: the decoded body, None for an empty one.
    """
    data: JsonValue = await api_request(
        method.upper(),
        url,
        error_of=_error_of,
        headers=hub_headers(account.token),
        params=params,
        json_body=body,
        json_body_present=body is not None,
        retry=WRITE_RETRY,
        session=account.pool,
    )
    return data


async def hub_post_ndjson(
    account: HfAccountAccessor,
    url: str,
    payload: bytes,
    params: dict[str, Any] | None = None,
) -> JsonValue:
    """One newline-delimited-JSON POST, which is the commit endpoint's shape.

    Args:
        account (HfAccountAccessor): the token and pool the call rides.
        url (str): the commit URL.
        payload (bytes): the already-serialized ndjson body.
        params (dict[str, Any] | None): query parameters.

    Returns:
        JsonValue: the decoded commit response.
    """
    headers = {
        **hub_headers(account.token),
        "Content-Type": "application/x-ndjson",
    }
    data: JsonValue = await api_request(
        "POST",
        url,
        error_of=_error_of,
        headers=headers,
        params=params,
        data=payload,
        retry=WRITE_RETRY,
        session=account.pool,
    )
    return data


async def hub_bytes(
    account: HfAccountAccessor,
    url: str,
    window: ByteWindow | None = None,
) -> bytes:
    """Fetch file content, optionally a byte window of it.

    ``/resolve`` answers a redirect to the CDN and aiohttp follows it by
    default, carrying the Range along, so a window costs no extra round
    trip.

    Args:
        account (HfAccountAccessor): the token and pool the call rides.
        url (str): the resolve URL.
        window (ByteWindow | None): the byte range to ask for.

    Returns:
        bytes: the content, trimmed to the window when the CDN ignored
        the Range header.
    """
    content: bytes = await api_request(
        "GET",
        url,
        error_of=_error_of,
        headers=hub_headers(account.token),
        retry=RETRY,
        read="bytes",
        window=window,
        session=account.pool,
    )
    return content


async def hub_bytes_tagged(
    account: HfAccountAccessor,
    url: str,
    window: ByteWindow | None = None,
) -> tuple[bytes, str]:
    """Fetch file content together with the ETag the bytes came with.

    The ETag is the final response's, after the redirect to the CDN: the
    first hop answers for the LFS object, the last one for the bytes
    actually served, which is the only one that can vouch for them.

    Args:
        account (HfAccountAccessor): the token and pool the call rides.
        url (str): the resolve URL.
        window (ByteWindow | None): the byte range to ask for.

    Returns:
        tuple[bytes, str]: the content, trimmed to the window when the CDN
        ignored the Range header, and the raw ETag header ("" when none).
    """
    response: ApiResponse = await api_request(
        "GET",
        url,
        error_of=_error_of,
        headers=hub_headers(account.token),
        retry=RETRY,
        read="bytes_response",
        window=window,
        session=account.pool,
    )
    return response.data, response.headers.get("etag", "")


def etag_value(raw: str) -> str:
    """An ETag header's value, without the weak marker or the quotes.

    Args:
        raw (str): the header as sent, e.g. ``W/"abc"``.

    Returns:
        str: the bare value, e.g. ``abc``.
    """
    value = raw.strip()
    if value.startswith("W/"):
        value = value[2:]
    return value.strip('"')


async def hub_stream(
    account: HfAccountAccessor,
    url: str,
    chunk_size: int,
    *,
    on_response: Callable[[Mapping[str, str]], None] | None = None,
) -> AsyncIterator[bytes]:
    """Stream file content without holding it whole in memory.

    Routed through ``api_stream``, which retries opening the response
    under RETRY and never once a chunk has reached the caller. The
    redirect to the CDN is followed by aiohttp itself.

    Args:
        account (HfAccountAccessor): the token and pool the call rides.
        url (str): the resolve URL.
        chunk_size (int): bytes per yielded chunk.
        on_response (Callable | None): told the final response's headers,
            lower-cased, once and before the first chunk, so an empty file
            reports them too.

    Yields:
        bytes: the next chunk of content.

    Raises:
        HfHubError: the Hub or the CDN refused.
    """
    source = api_stream(
        url,
        error_of=_error_of,
        headers=hub_headers(account.token),
        session=account.pool,
        retry=RETRY,
        chunk_size=chunk_size,
        on_response=on_response,
    )
    async with aclosing(source):
        async for chunk in source:
            yield chunk


__all__ = [
    "HfHubError",
    "api_url",
    "etag_value",
    "hub_bytes",
    "hub_bytes_tagged",
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
