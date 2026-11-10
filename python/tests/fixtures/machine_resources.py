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

from mirage.execution.job import JobTable
from mirage.execution.types import MachineResources


def resources(machine: str = "docker:a", **fields) -> MachineResources:
    base = {
        "machine": machine,
        "cpus": 4,
        "all_cpus": 8,
        "epoch": 1762745722.0,
        "clock": "03:35:54",
        "offset": "+0000",
        "up_seconds": 0.5,
        "load": (0.0, 0.1, 0.2),
        "users": 0,
        "mem_total": 8000000 * 1024,
        "mem_free": 1234567 * 1024,
        "mem_available": 6543210 * 1024,
        "swap_total": 2097148 * 1024,
        "swap_free": 2000000 * 1024,
        "shared": 12345 * 1024,
        "buffers": 54321 * 1024,
        "cached": 2456789 * 1024,
        "commit_limit": 6097148 * 1024,
        "committed": 3000000 * 1024,
        "low_total": 8000000 * 1024,
        "low_free": 1234567 * 1024,
        "high_total": 0,
        "high_free": 0,
    }
    return MachineResources(**{**base, **fields})


def table_of(
    *rows: MachineResources, ids: list[str] | None = None
) -> JobTable:
    table = JobTable()
    by_id = {row.machine: row for row in rows}

    async def read(machine: str, cpu: bool) -> MachineResources:
        if machine not in by_id:
            raise OSError("down")
        return by_id[machine]

    table.processes.machine_ids = lambda: ids or list(by_id)
    table.processes.machine_resources = read
    return table
