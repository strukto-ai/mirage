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

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from mirage.cache.index.config import IndexConfig, IndexType, RedisIndexConfig
from mirage.commands.cli.types import CLISpec
from mirage.types import MountMode, WritePolicy
from mirage.vfs.secrets import REDACTED_SECRET, has_redacted_secret


@dataclass
class MountArgs:
    """Constructor inputs derived from a state dict.

    Workspace.load uses this to instantiate a fresh Workspace; snapshot
    code never constructs Workspace itself.
    """

    mount_args: dict[str, Any]
    default_session_id: str
    default_agent_id: str | None
    clis: dict[str, tuple[str | CLISpec, dict[str, Any] | None]] | None = None
    write_default: WritePolicy = WritePolicy.UNCONDITIONAL
    # The saved scratch root's mode, for the one the new workspace adds.
    anchor_mode: MountMode | None = None


def index_config_dump(
    config: IndexConfig | None, *, reveal: bool = False
) -> dict[str, Any] | None:
    """Serialize index placement without exposing URL credentials.

    Args:
        config (IndexConfig | None): the effective mount index config.
        reveal (bool): keep credentials for an in-memory workspace copy.
    """
    if config is None:
        return None
    data = config.model_dump(mode="json")
    if isinstance(config, RedisIndexConfig) and not reveal:
        url = urlsplit(config.url)
        if url.username or url.password:
            data["url"] = REDACTED_SECRET
    return data


def restore_index_config(
    data: dict[str, Any] | None, override: IndexConfig | None, prefix: str
) -> IndexConfig | None:
    """Restore index settings, requiring fresh credentials when redacted.

    Args:
        data (dict[str, Any] | None): saved index config.
        override (IndexConfig | None): an explicit replacement config.
        prefix (str): the mount prefix for diagnostics.
    """
    if override is not None:
        return override
    if data is None:
        return None
    if has_redacted_secret(data):
        raise ValueError(
            f"Workspace.load: mount {prefix!r} needs a Mount "
            "override with fresh index credentials"
        )
    model = (
        RedisIndexConfig
        if data.get("type") == IndexType.REDIS
        else IndexConfig
    )
    return model.model_validate(data)
