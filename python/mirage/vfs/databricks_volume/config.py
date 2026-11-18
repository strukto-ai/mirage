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

import posixpath
from collections.abc import Awaitable, Callable
from urllib.parse import urlsplit

from pydantic import ConfigDict, Field, SecretStr, field_validator

from mirage.core.api.config import TimeoutConfig

TokenProvider = Callable[[], str | SecretStr | Awaitable[str | SecretStr]]


def valid_volume_part(value: str) -> str:
    if not value or "/" in value:
        raise ValueError("must be a non-empty path segment")
    return value


def normalize_host(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
        or any(char.isspace() for char in value)
        or "?" in value
        or "#" in value
        or "\\" in value
    ):
        raise ValueError("host must be an HTTP(S) origin")
    port = parsed.port
    hostname = parsed.hostname
    if ":" in hostname:
        hostname = f"[{hostname}]"
    else:
        hostname = hostname.encode("idna").decode("ascii")
    default_port = 80 if parsed.scheme == "http" else 443
    authority = (
        hostname
        if port is None or port == default_port
        else f"{hostname}:{port}"
    )
    return f"{parsed.scheme}://{authority}"


def normalize_root_path(value: str) -> str:
    stripped = value.strip("/")
    if not stripped:
        return "/"
    if any(part == ".." for part in stripped.split("/")):
        raise ValueError("root_path must not contain '..' segments")
    normalized = posixpath.normpath("/" + stripped)
    return "/" if normalized == "/." else normalized


class DatabricksVolumeConfig(TimeoutConfig):
    model_config = ConfigDict(
        frozen=True,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
        arbitrary_types_allowed=True,
        hide_input_in_errors=True,
    )

    catalog: str
    """Unity Catalog catalog name; one path segment, no `/`."""
    schema_name: str = Field(alias="schema")
    """Unity Catalog schema name, `schema` in a config; one path segment,
    no `/`."""
    volume: str
    """Unity Catalog volume name; one path segment, no `/`."""
    root_path: str = "/"
    """Subdirectory inside the volume that becomes the mount root; `..`
    segments are refused."""
    host: str
    """Workspace origin, `http://` or `https://`, with no path, query,
    fragment or credentials."""
    token: SecretStr | TokenProvider
    """Bearer token as a string, or a function, synchronous or
    asynchronous, that returns one for each request."""

    _valid_volume_part = field_validator("catalog", "schema_name", "volume")(
        valid_volume_part
    )

    _normalize_host = field_validator("host")(normalize_host)

    @field_validator("token")
    @classmethod
    def validate_token(
        cls, value: SecretStr | TokenProvider
    ) -> SecretStr | TokenProvider:
        if isinstance(value, SecretStr):
            token = value.get_secret_value()
            if not token.strip() or "\r" in token or "\n" in token:
                raise ValueError(
                    "token must be nonblank and contain no CR or LF"
                )
        return value

    _normalize_root_path = field_validator("root_path")(normalize_root_path)
