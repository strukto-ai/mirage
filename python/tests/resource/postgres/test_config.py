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

from mirage.resource.postgres.config import PostgresConfig
from mirage.resource.secrets import reveal_secret


def test_defaults():
    cfg = PostgresConfig(dsn="postgres://localhost/db")
    assert reveal_secret(cfg.dsn) == "postgres://localhost/db"
    assert cfg.schemas is None
    assert cfg.default_row_limit == 1000
    assert cfg.max_read_rows == 10_000
    assert cfg.max_read_bytes == 10 * 1024 * 1024
    assert cfg.default_search_limit == 100


def test_schema_filter():
    cfg = PostgresConfig(dsn="postgres://localhost/db", schemas=["public"])
    assert cfg.schemas == ["public"]
