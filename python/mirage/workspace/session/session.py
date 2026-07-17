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

import time
from dataclasses import dataclass, field
from typing import Any

from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.shell.types import FunctionBody
from mirage.types import MountMode


@dataclass
class Session:
    session_id: str
    cwd: str = "/"
    env: dict[str, str] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    functions: dict[str, FunctionBody] = field(default_factory=dict)
    last_exit_code: int = 0
    shell_options: dict[str, bool] = field(default_factory=dict)
    readonly_vars: set[str] = field(default_factory=set)
    arrays: dict[str, list[str]] = field(default_factory=dict)
    mount_modes: dict[str, MountMode] | None = None
    generation: int = 0
    pipeline_timeout_seconds: float | None = None
    positional_args: list[str] = field(default_factory=list)
    _stdin_buffer: AsyncLineIterator | None = field(default=None, repr=False)
    _local_vars: dict[str, str | None] | None = field(default=None, repr=False)

    def to_dict(self) -> dict[str, Any]:
        data = {
            "session_id": self.session_id,
            "cwd": self.cwd,
            "env": self.env,
            "created_at": self.created_at,
            "generation": self.generation,
        }
        if self.mount_modes is not None:
            data["mount_modes"] = {
                prefix: mode.value
                for prefix, mode in self.mount_modes.items()
            }
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Session":
        modes = data.get("mount_modes")
        if modes is not None:
            data = dict(data)
            data["mount_modes"] = {
                prefix: MountMode(mode)
                for prefix, mode in modes.items()
            }
        return cls(**data)

    def fork(self, **overrides: Any) -> "Session":
        """Return a copy of this session with overrides applied.

        Mutable containers (env, functions, readonly_vars, arrays,
        shell_options) are shallow-copied so mutations on the fork do
        not leak back into the source. Every field, including
        capability fields like ``mount_modes``, is propagated, so
        callers cannot accidentally forget one when adding new fields.

        Args:
            **overrides: Field-name kwargs to override on the copy.
        """
        defaults: dict[str, Any] = {
            "session_id":
            self.session_id,
            "cwd":
            self.cwd,
            "env":
            dict(self.env),
            "created_at":
            self.created_at,
            "functions":
            dict(self.functions),
            "last_exit_code":
            self.last_exit_code,
            "shell_options":
            dict(self.shell_options),
            "readonly_vars":
            set(self.readonly_vars),
            "arrays": {
                k: list(v)
                for k, v in self.arrays.items()
            },
            "mount_modes":
            (dict(self.mount_modes) if self.mount_modes is not None else None),
            "generation":
            self.generation,
            "pipeline_timeout_seconds":
            self.pipeline_timeout_seconds,
        }
        defaults.update(overrides)
        return Session(**defaults)
