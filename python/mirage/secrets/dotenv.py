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

import io

import aiofiles
from dotenv import dotenv_values

from mirage.secrets.config import DotenvConfig
from mirage.secrets.errors import SecretsError
from mirage.secrets.types import ResolvedSecret


async def fetch_dotenv(config: DotenvConfig, ref: str) -> ResolvedSecret:
    """Read one dotenv file as one secret.

    A key declared without a value (a bare ``NAME`` line) parses as
    None and is dropped: an unset entry is not a secret field. Values
    are taken verbatim, never interpolated: python-dotenv's default
    would resolve ``${NAME}`` against the host process environment,
    silently copying a host variable into a secret value, and the
    TypeScript twin's parser keeps the literal text -- so the literal
    is both the safe reading and the shared one.

    Args:
        config (DotenvConfig): holds the default ``path``.
        ref (str): host filesystem path of the file; empty falls back
            to ``config.path``.

    Returns:
        ResolvedSecret: the file's key=value pairs as fields.

    Raises:
        SecretsError: the file does not exist.
    """
    path = ref or config.path
    try:
        async with aiofiles.open(path, encoding="utf-8") as handle:
            text = await handle.read()
    except FileNotFoundError as exc:
        raise SecretsError(f"dotenv file not found: {path}") from exc
    values = dotenv_values(stream=io.StringIO(text), interpolate=False)
    return ResolvedSecret(fields={
        name: value
        for name, value in values.items() if value is not None
    })
