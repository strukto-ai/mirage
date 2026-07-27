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

# This layer reports what the server said and never decides whether that is an
# error: curl treats a 404 as a successful transfer (exit 0, body on stdout)
# while wget treats it as exit 8, so the status has to reach the command. An
# earlier version called raise_for_status() here, which made both tools fail on
# any 4xx and leaked httpx's exception text (complete with a documentation URL)
# onto stderr.

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

# httpx is the [http] extra, so it stays optional: top-level import guarded the
# same way the databricks accessor guards its SDK.
httpx: Any
try:
    import httpx as _httpx
except ImportError:
    httpx = None
else:
    httpx = _httpx

DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; mirage/1.0)"
DEFAULT_PORTS = {"http": 80, "https": 443}
MISSING_HTTPX = "httpx is required for curl/wget: pip install 'mirage[http]'"


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    reason: str
    body: bytes
    url: str

    @property
    def is_error(self) -> bool:
        return self.status >= 400


class HttpConnectError(Exception):
    """The request never got an HTTP response.

    Carries the host and port instead of an errno: the errno for a refused
    connection differs by platform (61 on macOS, 111 on Linux), so a message
    built from it cannot be asserted in a cross-platform test.

    Args:
        host (str): host from the requested URL.
        port (int): port from the requested URL, defaulted by scheme.
    """

    def __init__(self, host: str, port: int) -> None:
        super().__init__(f"Failed to connect to {host} port {port}")
        self.host = host
        self.port = port


def _with_default_ua(headers: dict[str, str] | None) -> dict[str, str]:
    merged = {"User-Agent": DEFAULT_USER_AGENT}
    if headers:
        merged.update(headers)
    return merged


def _endpoint(url: str) -> tuple[str, int]:
    parts = urlsplit(url)
    host = parts.hostname or ""
    port = parts.port or DEFAULT_PORTS.get(parts.scheme, 80)
    return host, port


def _response(resp: Any, url: str) -> HttpResponse:
    return HttpResponse(status=resp.status_code,
                        reason=resp.reason_phrase,
                        body=resp.content,
                        url=url)


def _http_request(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: int = 30,
    follow_redirects: bool = False,
) -> HttpResponse:
    if httpx is None:
        raise ImportError(MISSING_HTTPX)
    with httpx.Client(timeout=timeout,
                      follow_redirects=follow_redirects) as client:
        try:
            resp = client.request(method,
                                  url,
                                  headers=_with_default_ua(headers),
                                  content=data)
        except httpx.TransportError as exc:
            host, port = _endpoint(url)
            raise HttpConnectError(host, port) from exc
        return _response(resp, url)


def _http_form_request(
    url: str,
    method: str = "POST",
    form_data: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
    follow_redirects: bool = False,
) -> HttpResponse:
    if httpx is None:
        raise ImportError(MISSING_HTTPX)
    with httpx.Client(timeout=timeout,
                      follow_redirects=follow_redirects) as client:
        try:
            resp = client.request(method,
                                  url,
                                  data=form_data or {},
                                  headers=_with_default_ua(headers))
        except httpx.TransportError as exc:
            host, port = _endpoint(url)
            raise HttpConnectError(host, port) from exc
        return _response(resp, url)


def _http_get(
    url: str,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
    follow_redirects: bool = True,
) -> HttpResponse:
    return _http_request(url,
                         method="GET",
                         headers=headers,
                         timeout=timeout,
                         follow_redirects=follow_redirects)
