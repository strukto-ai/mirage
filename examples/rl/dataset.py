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

import tomllib
from pathlib import Path

from examples.rl.constants import DEFAULT_FIXTURE
from examples.rl.schemas import MirageTask
from mirage.types import JsonValue


def _parse_backends(cfg: dict[str, JsonValue]) -> dict[str, str]:
    raw = cfg.get("backends")
    if not isinstance(raw, dict):
        return {}
    backends: dict[str, str] = {}
    for service, spec in raw.items():
        if isinstance(spec, dict):
            backends[str(service)] = str(spec.get("fixture", DEFAULT_FIXTURE))
        elif isinstance(spec, str):
            backends[str(service)] = spec
    return backends


def load_mirage_tasks(data_dir: Path) -> list[MirageTask]:
    """Load Harbor-compatible Mirage tasks from ``data_dir / 'tasks'``.

    Args:
        data_dir (Path): Root data directory holding ``tasks/<name>/``.

    Returns:
        list[MirageTask]: Sorted list of discovered tasks.
    """
    tasks_root = data_dir / "tasks"
    tasks: list[MirageTask] = []
    for task_dir in sorted(tasks_root.iterdir()):
        if not task_dir.is_dir():
            continue
        instruction = (task_dir / "instruction.md").read_text().strip()
        toml_path = task_dir / "task.toml"
        cfg = (
            tomllib.loads(toml_path.read_text()) if toml_path.exists() else {}
        )
        tasks.append(
            MirageTask(
                task_name=task_dir.name,
                instruction=instruction,
                task_dir=task_dir,
                backends=_parse_backends(cfg),
                config=cfg,
            )
        )
    return tasks
