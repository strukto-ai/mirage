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

DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; mirage/1.0)"


def _with_default_ua(headers: dict[str, str] | None) -> dict[str, str]:
    merged = {"User-Agent": DEFAULT_USER_AGENT}
    if headers:
        merged.update(headers)
    return merged


def _http_request(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: int = 30,
) -> bytes:
    try:
        import httpx
    except ImportError:
        raise ImportError(
            "httpx is required for curl/wget: pip install 'mirage[http]'")
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        resp = client.request(method,
                              url,
                              headers=_with_default_ua(headers),
                              content=data)
        resp.raise_for_status()
        return resp.content


def _http_form_request(
    url: str,
    method: str = "POST",
    form_data: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
) -> bytes:
    try:
        import httpx
    except ImportError:
        raise ImportError(
            "httpx is required for curl/wget: pip install 'mirage[http]'")
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        resp = client.request(method,
                              url,
                              data=form_data or {},
                              headers=_with_default_ua(headers))
        resp.raise_for_status()
        return resp.content


def _http_get(
    url: str,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
) -> bytes:
    return _http_request(url, method="GET", headers=headers, timeout=timeout)
