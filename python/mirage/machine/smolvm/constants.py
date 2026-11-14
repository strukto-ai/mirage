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

from mirage.machine.types import PauseAction

SMOLVM_HINT = (
    "the smolvm machine needs `smolvm` on PATH "
    "(https://smolmachines.com); the host also needs a "
    "hypervisor: /dev/kvm on Linux, Hypervisor.framework on "
    "macOS, WHP on Windows"
)

# `machine status --json` reports RecordState's Display form, which is
# lowercase. Only "running" can take a line: "frozen" is a fork base
# whose guest agent is paused by design, and "unreachable" means the
# VMM is alive but the guest agent stopped answering vsock pings. A
# "paused" machine is resumed first.
RUNNING_STATE = "running"
PAUSED_STATE = "paused"

# What ``on_pause`` takes for a machine: save its memory and disks durably,
# then stop its VM (smolvm 1.18 or later, on a machine started
# ``--branchable``).
ON_PAUSE: tuple[PauseAction, ...] = ("pause",)

# What `smolvm machine pause` says of a machine already gone.
MACHINE_GONE = "vm not found"

STATE_HINTS: dict[str, str] = {
    "unreachable": (
        "its guest agent is not answering (the VMM is alive but the agent "
        "died); recover with `smolvm machine start --name {name}`"
    ),
    "frozen": (
        "it is a frozen fork base, deliberately paused so its clones can "
        "copy-on-write from it; exec against a clone instead"
    ),
    "created": "it has never been started; start it with "
    "`smolvm machine start --name {name}`",
    "stopped": "it is stopped; start it with "
    "`smolvm machine start --name {name}`",
    "failed": "it crashed; inspect with `smolvm machine status --name {name}`",
}
