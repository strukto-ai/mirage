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

from pydantic import BaseModel, ConfigDict, SecretStr


class PostgresConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    dsn: SecretStr
    """Postgres connection string."""
    schemas: list[str] | None = None
    """Schemas to show in the tree; others are hidden. Unset shows every
    schema except `pg_catalog`, `information_schema` and `pg_*`."""
    default_row_limit: int = 1000
    """Rows a windowed read returns when it passes an offset but no limit,
    and the rows one page of a streamed `rows.jsonl` fetches."""
    max_read_rows: int = 10_000
    """Most rows one read returns. A whole read past it is refused, and so
    is a `head -n` / `tail -n` count past it on a table that long
    (`File too large`); `wc -l` counts past it."""
    max_read_bytes: int = 10 * 1024 * 1024
    """Most bytes of `rows.jsonl` one read returns; a whole read past it is
    refused (`File too large`)."""
