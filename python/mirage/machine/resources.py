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

import re

from mirage.execution.types import CpuShares, MachineResources, TaskCounts
from mirage.machine.constants import RESOURCE_MARK

_SWAP_UNITS = {"K": 1024, "M": 1024**2, "G": 1024**3}
_SWAP_FIELD = re.compile(r"(total|used|free) = ([0-9.]+)([KMG])")
_BOOT_SECONDS = re.compile(r"sec = ([0-9]+)")
_PAGE_SIZE = re.compile(r"page size of ([0-9]+)")
_VM_FIELD = re.compile(r"^(.*?):\s+([0-9]+)\.$")
_PROCESS_COUNT = re.compile(r"([0-9]+) (total|running|sleeping|stuck)")
_CPU_SHARE = re.compile(r"([0-9.]+)% (user|sys|idle)")


def _rows_of(text: str) -> tuple[dict[str, str], list[tuple[str, str]]]:
    """A line's marked rows: the last value of each key, and every
    (key, value) in order.

    Args:
        text (str): what the line printed.
    """
    facts: dict[str, str] = {}
    rows: list[tuple[str, str]] = []
    for line in text.splitlines():
        mark, _, rest = line.partition(" ")
        if mark != RESOURCE_MARK:
            continue
        key, _, value = rest.partition(" ")
        facts[key] = value
        rows.append((key, value))
    return facts, rows


def _cpu_info(rows: list[tuple[str, str]]) -> str:
    """What ``lscpu`` printed, as it printed it.

    Args:
        rows (list[tuple[str, str]]): the line's marked rows.
    """
    return "".join(f"{value}\n" for key, value in rows if key == "lscpu")


def _words(text: str) -> list[str]:
    """A row's blank-separated fields.

    Args:
        text (str): the row.
    """
    return text.split()


def _need(facts: dict[str, str], key: str) -> str:
    """A row the machine always prints.

    Args:
        facts (dict[str, str]): the marked rows.
        key (str): the row's key.

    Raises:
        KeyError: it printed no such row.
    """
    return facts[key]


def _load_of(text: str) -> tuple[float, float, float]:
    """The three load averages a row starts with.

    Args:
        text (str): the row.
    """
    one, five, fifteen = _words(text)[:3]
    return float(one), float(five), float(fifteen)


def _time_facts(facts: dict[str, str]) -> tuple[float, str, str]:
    """The machine's clock as its row says it: epoch seconds, ``HH:MM:SS``
    and ``+hhmm``.

    Args:
        facts (dict[str, str]): the marked rows.

    Raises:
        KeyError: the machine printed no clock.
        ValueError: the row does not read as one.
    """
    epoch, clock, offset = _words(_need(facts, "clock"))
    return float(epoch), clock, offset


def _shares(before: str, after: str) -> CpuShares:
    """Where the processors' time went between two reads of
    ``/proc/stat``'s first row.

    Args:
        before (str): the first read.
        after (str): the second read.
    """
    first = [int(field) for field in _words(before)[1:9]]
    second = [int(field) for field in _words(after)[1:9]]
    spent = [b - a for a, b in zip(first, second, strict=True)]
    whole = sum(spent) or 1
    user, nice, system, idle, wait, hardware, software, stolen = (
        100 * share / whole for share in spent
    )
    return CpuShares(
        user, system, idle, nice, wait, hardware, software, stolen
    )


def _tasks_of(states: str) -> TaskCounts:
    """How many processes do what, from their state letters.

    Args:
        states (str): one letter a process.
    """
    running = states.count("R")
    stopped = states.count("T") + states.count("t")
    zombie = states.count("Z")
    total = len(states)
    return TaskCounts(
        total, running, total - running - stopped - zombie, stopped, zombie
    )


def parse_resources(text: str, machine: str) -> MachineResources:
    """What ``resources_line`` printed on a Linux machine.

    Args:
        text (str): what it printed.
        machine (str): the machine, as ``ps`` shows it.

    Raises:
        KeyError: a row it always prints is missing.
        ValueError: a row does not read as what it should be.
    """
    facts, rows = _rows_of(text)
    memory: dict[str, int] = {}
    for key, value in rows:
        if key != "mem":
            continue
        name, _, size = value.partition(" ")
        if size.isdigit():
            memory[name.rstrip(":")] = int(size) * 1024
    epoch, clock, offset = _time_facts(facts)
    cpus, all_cpus = _words(_need(facts, "cpus"))
    free = memory["MemFree"]
    cached = memory.get("Cached", 0) + memory.get("SReclaimable", 0)
    buffers = memory.get("Buffers", 0)
    has_sample = "before" in facts and "after" in facts
    return MachineResources(
        machine=machine,
        cpus=int(cpus),
        all_cpus=int(all_cpus),
        epoch=epoch,
        clock=clock,
        offset=offset,
        up_seconds=float(_need(facts, "up")),
        load=_load_of(_need(facts, "load")),
        users=int(facts.get("users") or 0),
        mem_total=memory["MemTotal"],
        mem_free=free,
        mem_available=memory.get("MemAvailable", free + cached + buffers),
        swap_total=memory.get("SwapTotal", 0),
        swap_free=memory.get("SwapFree", 0),
        shared=memory.get("Shmem", 0),
        buffers=buffers,
        cached=cached,
        commit_limit=memory.get("CommitLimit", 0),
        committed=memory.get("Committed_AS", 0),
        low_total=memory.get("LowTotal", memory["MemTotal"]),
        low_free=memory.get("LowFree", free),
        high_total=memory.get("HighTotal", 0),
        high_free=memory.get("HighFree", 0),
        tasks=_tasks_of(facts["states"]) if "states" in facts else None,
        cpu=_shares(facts["before"], facts["after"]) if has_sample else None,
        hostname=facts.get("host", ""),
        cpu_info=_cpu_info(rows),
    )


def _darwin_tasks(line: str) -> TaskCounts:
    """How many processes a Mac holds, from ``top``'s ``Processes:`` row.

    Args:
        line (str): the row.
    """
    counts = {name: int(n) for n, name in _PROCESS_COUNT.findall(line)}
    return TaskCounts(
        counts.get("total", 0),
        counts.get("running", 0),
        counts.get("sleeping", 0),
    )


def _darwin_shares(line: str) -> CpuShares:
    """Where a Mac's processors' time went, from ``top``'s ``CPU usage:``
    row, which has no more than user, system and idle.

    Args:
        line (str): the row.
    """
    shares = {name: float(n) for n, name in _CPU_SHARE.findall(line)}
    return CpuShares(
        shares.get("user", 0.0),
        shares.get("sys", 0.0),
        shares.get("idle", 0.0),
    )


def parse_darwin_resources(text: str, machine: str) -> MachineResources:
    """What ``darwin_resources_line`` printed on a Mac. Inactive and
    speculative pages are the cache, which memory pressure takes back,
    so they count as available, as Linux's cache does.

    Args:
        text (str): what it printed.
        machine (str): the machine, as ``ps`` shows it.

    Raises:
        KeyError: a row it always prints is missing.
        ValueError: a row does not read as what it should be.
    """
    facts, rows = _rows_of(text)
    page = 4096
    pages: dict[str, int] = {}
    tasks: TaskCounts | None = None
    cpu: CpuShares | None = None
    for key, value in rows:
        if key == "vm":
            size = _PAGE_SIZE.search(value)
            field = _VM_FIELD.match(value)
            if size is not None:
                page = int(size.group(1))
            elif field is not None:
                pages[field.group(1)] = int(field.group(2))
        elif key == "top" and value.startswith("Processes:"):
            tasks = _darwin_tasks(value)
        elif key == "top" and value.startswith("CPU usage:"):
            cpu = _darwin_shares(value)
    swap = {
        name: int(float(amount) * _SWAP_UNITS[unit])
        for name, amount, unit in _SWAP_FIELD.findall(_need(facts, "swap"))
    }
    boot = _BOOT_SECONDS.search(_need(facts, "boot"))
    if boot is None:
        raise ValueError(f"no boot time in {facts['boot']!r}")
    epoch, clock, offset = _time_facts(facts)
    free = pages["Pages free"] * page
    cache = (
        pages.get("Pages inactive", 0) + pages.get("Pages speculative", 0)
    ) * page
    cpus, all_cpus = _words(_need(facts, "cpus"))
    return MachineResources(
        machine=machine,
        cpus=int(cpus),
        all_cpus=int(all_cpus),
        epoch=epoch,
        clock=clock,
        offset=offset,
        up_seconds=max(0.0, epoch - int(boot.group(1))),
        load=_load_of(_need(facts, "load").strip("{} ")),
        users=int(facts.get("users") or 0),
        mem_total=int(_need(facts, "memsize")),
        mem_free=free,
        mem_available=free + cache,
        swap_total=swap.get("total", 0),
        swap_free=swap.get("free", 0),
        cached=cache,
        tasks=tasks,
        cpu=cpu,
        hostname=facts.get("host", ""),
        cpu_info=_cpu_info(rows),
    )
