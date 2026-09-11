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
from pathlib import Path

from mirage.config import load_config, resolve_secrets
from mirage.utils.ids import new_workspace_id
from mirage.workspace.workspace import Workspace

WORKSPACE_CONFIG_CANDIDATES = (
    ".mirage/workspace.yaml",
    ".mirage/workspace.yml",
    "workspace.yaml",
    "workspace.yml",
    "mirage.yaml",
    "mirage.yml",
)

DEFAULT_ENV_NAMES = ("MIRAGE_CONFIG", )


def _require_config(path: Path) -> Path:
    if not path.exists():
        raise FileNotFoundError(f"Mirage workspace config not found: {path}")
    return path


def resolve_workspace_config(
        config: str | Path | None = None,
        cwd: str | Path | None = None,
        env: dict[str, str] | None = None,
        env_names: tuple[str, ...] = DEFAULT_ENV_NAMES) -> Path:
    """Find the workspace config a command should load.

    An explicit path wins, then the first environment variable that is
    set, then the first candidate filename found walking up from cwd.

    Args:
        config (str | Path | None): explicit path, relative to cwd.
        cwd (str | Path | None): directory to resolve from. Defaults to
            the process working directory.
        env (dict[str, str] | None): environment mapping to read.
            Defaults to ``os.environ``.
        env_names (tuple[str, ...]): variables to consult, in order.

    Returns:
        Path: the resolved config path.

    Raises:
        FileNotFoundError: a named path does not exist, or the walk
            reached the root without finding a candidate.
    """
    base = Path(cwd).resolve() if cwd is not None else Path.cwd().resolve()
    use_env = env if env is not None else dict(os.environ)
    if config is not None:
        return _require_config((base / config).resolve())

    for name in env_names:
        value = use_env.get(name)
        if value is not None:
            return _require_config((base / value).resolve())

    for directory in (base, *base.parents):
        for candidate in WORKSPACE_CONFIG_CANDIDATES:
            path = directory / candidate
            if path.exists():
                return path
    raise FileNotFoundError(
        "No Mirage workspace config found. Pass a config path or set "
        f"{' or '.join(env_names)}.")


async def build_workspace_from_config(config_path: str | Path) -> Workspace:
    """Build a workspace from a config file, kernel mounts included.

    Args:
        config_path (str | Path): path to the YAML config.

    Returns:
        Workspace: the constructed workspace.
    """
    config = await resolve_secrets(load_config(config_path))
    kwargs = config.to_workspace_kwargs()
    kwargs["workspace_id"] = kwargs.get("workspace_id") or new_workspace_id()
    workspace = Workspace(**kwargs)
    try:
        for prefix, (backend, mountpoint) in config.kernel_mounts().items():
            workspace.add_fuse_mount(prefix, mountpoint, backend=backend)
    except Exception:
        await workspace.close()
        raise
    return workspace
