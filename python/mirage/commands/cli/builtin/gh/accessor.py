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

import json

from mirage.core.github.config import GhConfig
from mirage.core.github.repo import RepoRef, parse_repo
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue


def gh_repo(config: GhConfig, spec: str | None) -> RepoRef:
    """The repository a line is about.

    The operand when it named one, the install's own otherwise. Real gh
    resolves this from the current git remote, which a workspace has no
    equivalent of, so the config carries it.

    Args:
        config (GhConfig): the install's configuration.
        spec (str | None): the repository the line named, if any.

    Returns:
        RepoRef: the owner and repository names.

    Raises:
        ValueError: neither the line nor the install named one.
    """
    named = spec if spec else config.repo
    if not named:
        raise ValueError(
            "no repository given; pass one or set `repo` on the install")
    return parse_repo(named)


def json_out(
        value: JsonValue,
        mutated: bool | None = None) -> tuple[ByteSource | None, IOResult]:
    text = "" if value is None else f"{json.dumps(value, indent=2)}\n"
    return yield_bytes(text.encode()), IOResult(mutated=mutated)


def text_out(text: str) -> tuple[ByteSource | None, IOResult]:
    return yield_bytes(text.encode()), IOResult()
