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

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from mirage.utils import key_prefix as kp
from mirage.vfs.constants import WALK_LIMIT


class GridFSConfig(BaseModel):
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
    walk_limit: int = Field(default=WALK_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit."""

    @field_validator("key_prefix")
    @classmethod
    def _normalize_key_prefix(cls, v: str | None) -> str | None:
        return kp.normalize(v) or None
