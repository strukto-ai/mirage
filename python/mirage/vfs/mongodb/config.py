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

from pydantic import BaseModel, ConfigDict, Field, SecretStr

from mirage.vfs.constants import WALK_LIMIT


class MongoDBConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    uri: SecretStr
    """MongoDB connection URI."""
    databases: list[str] | None = None
    """Databases to mount; others are hidden. Unset or empty mounts every
    database except `admin`, `config` and `local`."""
    max_doc_limit: int = 5000
    """Most documents one `tail -n` read of `documents.jsonl` fetches; a
    larger count on a collection that holds more is refused
    (`File too large`)."""
    elide_fields: dict[str, list[str]] = {}
    """Fields dropped from `documents.jsonl`, keyed by
    `<database>.<collection>` (a view's name works too); a dotted path such
    as `nested.path` drops a nested field."""
    walk_limit: int = Field(default=WALK_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit."""
