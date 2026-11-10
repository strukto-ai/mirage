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

import pytest

from mirage.machine.constants import (
    RESOURCE_MARK,
    darwin_resources_line,
    resources_line,
)
from mirage.machine.resources import parse_darwin_resources, parse_resources

M = RESOURCE_MARK
LINUX = f"""{M} cpus 5 8
{M} clock 1762745722 03:35:22 +0000
{M} load 0.16 0.03 0.01 2/103 102
{M} up 3661.50
{M} users 2
{M} mem MemTotal: 8000000
{M} mem MemFree: 1234567
{M} mem MemAvailable: 6543210
{M} mem Buffers: 54321
{M} mem Cached: 2345678
{M} mem SwapTotal: 2097148
{M} mem SwapFree: 2000000
{M} mem Shmem: 12345
{M} mem SReclaimable: 111111
{M} mem CommitLimit: 6097148
{M} mem Committed_AS: 3000000
provider banner that is not a row
"""
DARWIN = f"""{M} cpus 14 14
{M} clock 1762745722 19:35:22 -0800
{M} load {{ 3.54 3.94 5.27 }}
{M} boot {{ sec = 1762700000, usec = 1 }} Sun Nov  9 06:53:20 2025
{M} users 2
{M} memsize 51539607552
{M} swap total = 7168.00M  used = 6045.00M  free = 1123.00M  (encrypted)
{M} vm Mach Virtual Memory Statistics: (page size of 16384 bytes)
{M} vm Pages free:                               716727.
{M} vm Pages inactive:                           844469.
{M} vm Pages speculative:                         43344.
{M} top Processes: 875 total, 5 running, 870 sleeping, 6000 threads
{M} top CPU usage: 15.10% user, 8.30% sys, 76.60% idle
"""


def test_resources_line_samples_only_when_asked():
    assert "/proc/stat" not in resources_line(False)
    assert "/proc/stat" in resources_line(True)


def test_darwin_line_samples_only_when_asked():
    assert "top -l" not in darwin_resources_line(False)
    assert "top -l" in darwin_resources_line(True)


def test_parse_reads_a_linux_machine():
    found = parse_resources(LINUX, "docker:a")
    assert (found.machine, found.cpus, found.all_cpus) == ("docker:a", 5, 8)
    assert (found.clock, found.offset) == ("03:35:22", "+0000")
    assert found.load == (0.16, 0.03, 0.01)
    assert (found.up_seconds, found.users) == (3661.5, 2)
    assert found.mem_total == 8000000 * 1024
    assert found.mem_available == 6543210 * 1024
    assert found.cached == (2345678 + 111111) * 1024
    assert found.low_total == found.mem_total
    assert found.high_total == 0
    assert found.cpu is None and found.tasks is None


def test_parse_reads_the_time_between_two_samples():
    sampled = (
        f"{LINUX}{M} before cpu  100 0 100 800 0 0 0 0 0 0\n"
        f"{M} after cpu  150 0 100 850 0 0 0 0 0 0\n"
        f"{M} states SSRZT\n"
    )
    found = parse_resources(sampled, "docker:a")
    assert found.cpu is not None
    assert (found.cpu.user, found.cpu.idle) == (50.0, 50.0)
    assert found.tasks is not None
    assert found.tasks.total == 5
    assert (found.tasks.running, found.tasks.sleeping) == (1, 2)
    assert (found.tasks.stopped, found.tasks.zombie) == (1, 1)


def test_parse_refuses_a_machine_that_said_nothing():
    with pytest.raises(KeyError):
        parse_resources("nothing\n", "docker:a")


def test_parse_reads_a_mac():
    found = parse_darwin_resources(DARWIN, "host:mac")
    assert (found.cpus, found.all_cpus) == (14, 14)
    assert found.load == (3.54, 3.94, 5.27)
    assert found.up_seconds == 45722
    assert found.mem_total == 51539607552
    assert found.mem_free == 716727 * 16384
    assert found.cached == (844469 + 43344) * 16384
    assert found.mem_available == found.mem_free + found.cached
    assert found.shared is None and found.buffers is None
    assert found.swap_total == 7168 * 1024**2
    assert found.swap_free == 1123 * 1024**2
    assert found.tasks is not None and found.tasks.total == 875
    assert found.cpu is not None
    assert (found.cpu.user, found.cpu.system) == (15.1, 8.3)
    assert found.cpu.wait is None
