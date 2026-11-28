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

# The URL facts tvly 1.0.2 reads off WHATWG's URL (src/ui/text.ts and
# src/ui/render/crawl.ts; MIT, see licenses/third_party/tavily-cli.txt):
# the host a saved file is named after and the slug a crawled page is
# saved under.

import re
from typing import NamedTuple
from urllib.parse import quote

SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.\-]*:")
EDGE = re.compile(r"^[\x00-\x20]+|[\x00-\x20]+$")
TAB_OR_NEWLINE = re.compile(r"[\t\n\r]")
DEFAULT_PORTS = {
    "http": "80",
    "https": "443",
    "ws": "80",
    "wss": "443",
    "ftp": "21",
}
PATH_SAFE = "/!$%&'()*+,-.:;=@[]^_|~"
QUERY_SAFE = "!$%&'()*+,-./:;=?@[\\]^_`{|}~"
SLUG_UNSAFE = re.compile(r"[^\w\-.]")


class ParsedURL(NamedTuple):
    """The parts of a special-scheme URL tvly reads.

    Args:
        hostname (str): the host without its port.
        host (str): the host and any port that is not the default.
        pathname (str): the path, percent-encoded.
        search (str): ``?`` and the query, or empty.
    """

    hostname: str
    host: str
    pathname: str
    search: str


def parse_url(url: str) -> ParsedURL | None:
    """A URL with a special scheme (http, https, ws, wss, ftp), split as
    WHATWG's parser splits it; None when it would not parse.

    Args:
        url (str): the URL as given.
    """
    text = TAB_OR_NEWLINE.sub("", EDGE.sub("", url))
    match = SCHEME.match(text)
    if match is None:
        return None
    scheme = match.group()[:-1].lower()
    if scheme not in DEFAULT_PORTS:
        return None
    rest = text[match.end() :].replace("\\", "/").lstrip("/")
    rest = rest.split("#", 1)[0]
    cut = min(
        (i for i in (rest.find("/"), rest.find("?")) if i >= 0),
        default=len(rest),
    )
    authority, tail = rest[:cut], rest[cut:]
    authority = authority.rsplit("@", 1)[-1]
    hostname, port = authority, ""
    if authority.startswith("["):
        close = authority.find("]")
        if close < 0:
            return None
        hostname, port = (
            authority[: close + 1],
            authority[close + 1 :].lstrip(":"),
        )
    elif ":" in authority:
        hostname, port = authority.rsplit(":", 1)
    if not hostname or (port and not port.isdigit()):
        return None
    if not hostname.startswith("["):
        try:
            hostname = hostname.encode("idna").decode("ascii").lower()
        except UnicodeError:
            return None
    if port:
        port = str(int(port))
    host = (
        hostname
        if port in ("", DEFAULT_PORTS[scheme])
        else f"{hostname}:{port}"
    )
    path, _, query = tail.partition("?")
    pathname = quote(path or "/", safe=PATH_SAFE)
    search = f"?{quote(query, safe=QUERY_SAFE)}" if query else ""
    return ParsedURL(hostname, host, pathname, search)


def hostname_of(url: str) -> str:
    """The URL's host without its port, empty when it does not parse.

    Args:
        url (str): the URL.
    """
    parsed = parse_url(url)
    return parsed.hostname if parsed is not None else ""


def host_of(url: str) -> str:
    """The URL's host with any port, the input when it does not parse.

    Args:
        url (str): the URL.
    """
    parsed = parse_url(url)
    return parsed.host if parsed is not None else url


def page_slug(url: str) -> str:
    """``<host><path><query>`` with anything outside ``[\\w.-]`` as
    ``_``, trimmed of ``_``; ``index`` when that leaves nothing.

    Args:
        url (str): the page's URL.
    """
    parsed = parse_url(url)
    location = url
    if parsed is not None:
        location = parsed.host + parsed.pathname.rstrip("/") + parsed.search
    return SLUG_UNSAFE.sub("_", location).strip("_") or "index"
