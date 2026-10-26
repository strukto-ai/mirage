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

from pydantic import ConfigDict, SecretStr, field_validator

from mirage.core.api.config import TimeoutConfig


class TiDBFilesystemConfig(TimeoutConfig):
    model_config = ConfigDict(
        frozen=True,
        extra="forbid",
        hide_input_in_errors=True,
    )

    host: str
    """The file system's endpoint, such as
    `https://aws-us-east-1.drive9.ai` for its region, or the origin of a
    self-hosted drive9 server."""
    token: SecretStr
    """The file system token, sent as a bearer token."""
    root_path: str = "/"
    """Directory inside the file system that becomes the mount root, such
    as `/projects/a` for a token scoped to it; `..` segments are refused."""

    @field_validator("host")
    @classmethod
    def strip_host(cls, value: str) -> str:
        return value.rstrip("/")

    @field_validator("root_path")
    @classmethod
    def normalize_root_path(cls, value: str) -> str:
        stripped = value.strip("/")
        if not stripped:
            return "/"
        if any(part == ".." for part in stripped.split("/")):
            raise ValueError("root_path must not contain '..' segments")
        normalized = posixpath.normpath("/" + stripped)
        return "/" if normalized == "/." else normalized
