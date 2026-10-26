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

from typing import TYPE_CHECKING

from mirage.utils.loader import lazy_exports

if TYPE_CHECKING:
    from mirage.shell.job_table.constants import KILLED_EXIT_CODE
    from mirage.shell.job_table.ram import RAMJobStore
    from mirage.shell.job_table.redis import RedisJobStore
    from mirage.shell.job_table.store import JobStore
    from mirage.shell.job_table.table import JobTable, cancel_job
    from mirage.shell.job_table.types import Job, JobRunner, JobStatus
    from mirage.shell.job_table.waits import JobWaits

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.shell.job_table.constants": ("KILLED_EXIT_CODE",),
    "mirage.shell.job_table.ram": ("RAMJobStore",),
    "mirage.shell.job_table.redis": ("RedisJobStore",),
    "mirage.shell.job_table.store": ("JobStore",),
    "mirage.shell.job_table.table": ("JobTable", "cancel_job"),
    "mirage.shell.job_table.types": ("Job", "JobRunner", "JobStatus"),
    "mirage.shell.job_table.waits": ("JobWaits",),
}

__all__ = [
    "KILLED_EXIT_CODE",
    "Job",
    "JobRunner",
    "JobStatus",
    "JobStore",
    "JobTable",
    "JobWaits",
    "RAMJobStore",
    "RedisJobStore",
    "cancel_job",
]

__getattr__ = lazy_exports(__name__, _EXPORTS)
