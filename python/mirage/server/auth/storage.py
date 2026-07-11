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

import os
import secrets
from pathlib import Path

from mirage.server.paths import mirage_home


def default_token_file() -> Path:
    """Default auth token location, under :func:`mirage_home`."""
    return mirage_home() / "auth_token"


def read_token_file(path: Path) -> str | None:
    """Read the token file if present, returning None when missing.

    Args:
        path (Path): location of the token file.

    Returns:
        str | None: stripped file contents, or None if the file does not exist.
    """
    if not path.exists():
        return None
    return path.read_text().strip()


def ensure_token_file(path: Path) -> str:
    """Read the token file if present, else mint and persist a fresh one.

    Args:
        path (Path): location of the token file.

    Returns:
        str: the resolved bearer token.
    """
    existing = read_token_file(path)
    if existing is not None:
        return existing
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    path.write_text(token)
    os.chmod(path, 0o600)
    return token
