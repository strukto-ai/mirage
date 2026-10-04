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

import importlib
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mirage.shell.job_table.constants import KILLED_EXIT_CODE
    from mirage.shell.job_table.table import JobTable, cancel_job
    from mirage.shell.job_table.types import (
        ConsoleFactory,
        Job,
        JobRunner,
        JobStatus,
    )
    from mirage.shell.job_table.waits import JobWaits

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.shell.job_table.constants": ("KILLED_EXIT_CODE",),
    "mirage.shell.job_table.table": ("JobTable", "cancel_job"),
    "mirage.shell.job_table.types": (
        "ConsoleFactory",
        "Job",
        "JobRunner",
        "JobStatus",
    ),
    "mirage.shell.job_table.waits": ("JobWaits",),
}
_MODULE_OF = {
    name: module for module, names in _EXPORTS.items() for name in names
}

__all__ = [
    "KILLED_EXIT_CODE",
    "ConsoleFactory",
    "Job",
    "JobRunner",
    "JobStatus",
    "JobTable",
    "JobWaits",
    "cancel_job",
]


def __getattr__(name: str) -> Any:
    module = _MODULE_OF.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(importlib.import_module(module), name)
    globals()[name] = value
    return value
