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
from collections.abc import AsyncGenerator
from typing import Any, cast
from urllib.parse import urlencode

import aiohttp
from pydantic import SecretStr

from mirage.core.api.client import (
    ApiResponse,
    SessionArg,
    api_request,
    api_stream,
    status_error,
)
from mirage.core.github.config import GitHubConfig
from mirage.core.github.constants import (
    API_BASE,
    API_VERSION,
    GRAPHQL_PATH,
    RAW_MEDIA_TYPE,
)
from mirage.types import JsonValue
from mirage.vfs.secrets import reveal_secret


class _NoBody:
    pass


_NO_BODY = _NoBody()


def github_headers(token: SecretStr) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {reveal_secret(token)}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
    }


def github_url(path: str, base_url: str | None = None, **kwargs: str) -> str:
    return (base_url or API_BASE) + path.format(**kwargs)


def graphql_url(base_url: str | None = None) -> str:
    """The GraphQL endpoint of the install whose REST base is ``base_url``.

    gh pairs the two by host (internal/ghinstance, GraphQLEndpoint and
    RESTPrefix): github.com serves REST at https://api.github.com/ and
    GraphQL at https://api.github.com/graphql, while a GitHub Enterprise
    Server serves REST at https://HOST/api/v3/ and GraphQL at
    https://HOST/api/graphql, which is not under the REST base.
    Octokit's own graphql client draws the same line.

    Args:
        base_url (str | None): the REST base, defaulting to github.com's.
    """
    base = (base_url or API_BASE).rstrip("/")
    if base.endswith("/api/v3"):
        return base.removesuffix("/v3") + "/graphql"
    return base + "/graphql"


class GitHubApiError(Exception):
    """A GitHub call that answered with a status the caller cannot use.

    Args:
        message (str): what GitHub said, its own wording where it gave one.
        status (int): the HTTP status.
        body (str): the response text, preserved for CLI output.
        url (str): the final request URL, including query parameters.
        headers (dict[str, str] | None): the response's headers,
            lowercased, which `gh api -i` prints for a failing response as
            for any other.
    """

    def __init__(
        self,
        message: str,
        status: int,
        *,
        body: str = "",
        url: str = "",
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.body = body
        self.url = url
        self.headers = headers or {}
        try:
            self.data: JsonValue = json.loads(body) if body else None
        except ValueError:
            self.data = body


class GitHubConnectionError(Exception):
    """A GitHub call that got no response.

    The connection was refused, the host did not resolve, or the
    transport failed before any status arrived. It is not a
    ``GitHubApiError``, because there is no status to report, and it is
    never retried. The wording is gh's: a host that does not resolve
    reads "error connecting to HOST" with a pointer at GitHub's status
    page (gh's ``printError``), a refused connection reads as Go's client
    reports one, ``Get "URL": dial tcp ADDR: connect: connection
    refused``, and anything else as the transport said it.

    Args:
        message (str): the failure, as gh would print it.
    """


async def github_get(
    token: SecretStr,
    path: str,
    params: dict[str, Any] | None = None,
    *,
    base_url: str | None = None,
    session: SessionArg = None,
    **kwargs: str,
) -> dict[str, Any]:
    url = github_url(path, base_url, **kwargs)
    data: dict[str, Any] = await api_request(
        "GET",
        url,
        error_of=status_error,
        headers=github_headers(token),
        params=params,
        session=session,
    )
    return data


async def github_request(
    token: SecretStr,
    method: str,
    path: str,
    body: "JsonValue | _NoBody" = _NO_BODY,
    params: dict[str, str] | None = None,
    *,
    base_url: str | None = None,
    headers: dict[str, str] | None = None,
    session: SessionArg = None,
) -> "JsonValue":
    """One arbitrary API call, the shape `gh api` needs.

    A GET carries its fields in the query string and every other method in
    a JSON body, which is gh's own rule; a call with neither sends no body
    at all, so a bare DELETE stays a bare DELETE rather than an empty JSON
    object. The path is used verbatim, never format-expanded, because it
    arrives from a command line and may hold braces of its own.

    Args:
        token (SecretStr): the API token.
        method (str): the HTTP method.
        path (str): the endpoint path, leading slash included.
        body (JsonValue | _NoBody): the JSON body; omitted sends none, while
            an explicit None sends JSON null.
        params (dict[str, str] | None): query parameters.
        base_url (str | None): API base, defaulting to github.com's.
        session (SessionArg): pool or live session to ride.

    Returns:
        JsonValue: the decoded body, None for an empty one.

    Raises:
        GitHubApiError: the call answered with a non-2xx status.
    """
    response = await github_request_response(
        token,
        method,
        path,
        body,
        params,
        base_url=base_url,
        headers=headers,
        session=session,
    )
    return cast(JsonValue, response.data)


async def github_request_response(
    token: SecretStr,
    method: str,
    path: str,
    body: "JsonValue | _NoBody" = _NO_BODY,
    params: dict[str, str] | None = None,
    *,
    base_url: str | None = None,
    headers: dict[str, str] | None = None,
    session: SessionArg = None,
) -> ApiResponse:
    """One GitHub call retaining status and headers for CLI pagination."""
    url = (
        graphql_url(base_url)
        if path == GRAPHQL_PATH
        else (base_url or API_BASE) + path
    )
    merged = github_headers(token)
    for key, value in (headers or {}).items():
        prior = next(
            (name for name in merged if name.lower() == key.lower()), None
        )
        if prior is not None:
            merged.pop(prior)
        merged[key] = value
    present = body is not _NO_BODY
    try:
        raw: ApiResponse = await api_request(
            method.upper(),
            url,
            error_of=_error_of,
            headers=merged,
            params=params,
            json_body=None if not present else cast(JsonValue, body),
            json_body_present=present,
            read="bytes_response",
            session=session,
        )
    except aiohttp.ClientConnectorDNSError as exc:
        raise GitHubConnectionError(
            f"error connecting to {exc.host}\n"
            "check your internet connection or https://githubstatus.com"
        ) from exc
    except aiohttp.ClientConnectorError as exc:
        if not isinstance(exc.os_error, ConnectionRefusedError):
            raise GitHubConnectionError(str(exc)) from exc
        target = (
            f"{url}{'&' if '?' in url else '?'}{urlencode(params)}"
            if params
            else url
        )
        host = f"[{exc.host}]" if ":" in exc.host else exc.host
        raise GitHubConnectionError(
            f'{method.capitalize()} "{target}": dial tcp {host}:{exc.port}: '
            "connect: connection refused"
        ) from exc
    except aiohttp.ClientConnectionError as exc:
        raise GitHubConnectionError(str(exc)) from exc
    return ApiResponse(
        _decoded(raw.data, raw.headers.get("content-type", "")),
        raw.status,
        raw.headers,
    )


def _decoded(body: bytes, content_type: str) -> "JsonValue | bytes":
    """A body as the caller reads it, decided by its type as Octokit does.

    JSON is decoded (and read as text when it does not parse), no type, a
    text type or a UTF-8 charset reads as text, and anything else, such as
    a run's log archive, stays bytes. An empty body is None.

    Args:
        body (bytes): the body as it arrived.
        content_type (str): the response's Content-Type, empty if none.
    """
    if not body:
        return None
    mime, _, rest = content_type.partition(";")
    mime = mime.strip().lower()
    charset = next(
        (
            part.split("=", 1)[1].strip().strip('"').lower()
            for part in rest.split(";")
            if part.strip().lower().startswith("charset=")
        ),
        "",
    )
    if not mime:
        return body.decode("utf-8", errors="replace")
    if mime in ("application/json", "application/scim+json"):
        text = body.decode("utf-8", errors="replace")
        try:
            return cast(JsonValue, json.loads(text))
        except ValueError:
            return text
    if mime.startswith("text/") or charset == "utf-8":
        return body.decode("utf-8", errors="replace")
    return body


def _error_of(resp: aiohttp.ClientResponse, text: str) -> Exception:
    return GitHubApiError(
        _api_message(text, resp.reason),
        resp.status,
        body=text,
        url=str(resp.url),
        headers={
            key.lower(): ", ".join(resp.headers.getall(key))
            for key in resp.headers.keys()
        },
    )


def _api_message(text: str, reason: str | None) -> str:
    """GitHub's own wording for a failure, or the status reason.

    Args:
        text (str): the response body.
        reason (str | None): the HTTP reason phrase.

    Returns:
        str: the message to report.
    """
    try:
        payload = json.loads(text)
    except ValueError:
        return reason or text
    if isinstance(payload, dict):
        message = payload.get("message")
        if isinstance(message, str):
            return message
    return reason or text


def blob_path(owner: str, repo: str, sha: str) -> str:
    """The blob endpoint for ``sha`` in ``owner/repo``.

    Args:
        owner (str): the repository's owner.
        repo (str): the repository.
        sha (str): the blob's sha.
    """
    return f"/repos/{owner}/{repo}/git/blobs/{sha}"


def stream_blob(
    config: GitHubConfig,
    owner: str,
    repo: str,
    sha: str,
    session: SessionArg = None,
) -> AsyncGenerator[bytes, None]:
    """A blob's bytes as they download, in GitHub's raw media type.

    Args:
        config (GitHubConfig): the token and API base.
        owner (str): the repository's owner.
        repo (str): the repository.
        sha (str): the blob's sha.
        session (SessionArg): pool or live session to ride.
    """
    return api_stream(
        github_url(blob_path(owner, repo, sha), config.base_url),
        error_of=status_error,
        headers={**github_headers(config.token), "Accept": RAW_MEDIA_TYPE},
        session=session,
    )
