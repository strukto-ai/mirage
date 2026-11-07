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

from mirage.shell.constants import SIGKILL

# The other names GNU timeout 9.7 takes for -s, by the number
# `timeout -v -s NAME` then reports sending. bash refuses them all.
SIGNAL_ALIASES: dict[str, int] = {"EXIT": 0, "IOT": 6, "CLD": 17, "POLL": 29}

# Where `timeout -v` names a number otherwise than bash does.
TIMEOUT_NAMES: dict[int, str] = {0: "EXIT", 29: "POLL"}

# What timeout says, exiting 125, when its session already holds
# `processes.max` and the command cannot start.
FORK_FAILED = (
    b"timeout: fork system call failed: Resource temporarily unavailable\n"
)

# What timeout cannot ignore when it signals its own process group, so
# it dies of them too: KILL, and the two glibc reserves for itself.
SELF_KILLING_SIGNALS = frozenset({SIGKILL, 32, 33})
