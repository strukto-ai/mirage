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


import contextlib
import os
import uuid
from collections.abc import Iterator
from urllib.parse import urlsplit, urlunsplit

import pytest

from mirage.vfs.sql.postgres import PostgresSqlDriver

POSTGRES_DSN = os.environ.get("POSTGRES_DSN", "")

# A driver parametrization's Postgres leg, run only when a server is named.
ON_POSTGRES = pytest.param(
    "postgres",
    marks=pytest.mark.skipif(not POSTGRES_DSN, reason="POSTGRES_DSN not set"),
)


@contextlib.contextmanager
def fresh_database() -> Iterator[str]:
    """A database of its own on the server ``POSTGRES_DSN`` names, so
    tests on parallel workers never share tables, dropped after."""
    name = f"mirage_{uuid.uuid4().hex}"
    admin = PostgresSqlDriver(POSTGRES_DSN)
    try:
        admin.query(f'CREATE DATABASE "{name}"')
        yield urlunsplit(urlsplit(POSTGRES_DSN)._replace(path=f"/{name}"))
    finally:
        admin.query(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        admin.close()
