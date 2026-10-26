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

from pydantic import ConfigDict, Field, SecretStr, field_validator

from mirage.core.api.config import TimeoutConfig
from mirage.utils import key_prefix as kp


class GridFSConfig(TimeoutConfig):
    model_config = ConfigDict(frozen=True, extra="forbid")

    uri: SecretStr
    """MongoDB connection URI."""
    database: str
    """Database that holds the GridFS bucket."""
    bucket: str = "fs"
    """GridFS bucket name; its collections are `<bucket>.files` and
    `<bucket>.chunks`."""
    key_prefix: str | None = None
    """Filename prefix the mount treats as its root; files outside it are
    not listed."""
    chunk_size_bytes: int | None = None
    """Chunk size in bytes for files the mount writes; unset uses the
    driver's default, 255 KiB."""
    keep_revisions: int | None = Field(default=None, ge=1)
    """Revisions kept per file, newest first: a write or an `rm` deletes
    the rest, under the file's name and in the trash `rm` moves revisions
    to (`/trash/<filename>`, which no mount path reaches). Unset keeps
    every revision, so a snapshot pinned to any of them still reads."""

    @field_validator("key_prefix")
    @classmethod
    def _normalize_key_prefix(cls, v: str | None) -> str | None:
        return kp.normalize(v) or None
