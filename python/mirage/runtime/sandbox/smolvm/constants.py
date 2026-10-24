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

SMOLVM_HINT = (
    "the smolvm runtime needs `smolvm` on PATH "
    "(https://smolmachines.com); the host also needs a "
    "hypervisor: /dev/kvm on Linux, Hypervisor.framework on "
    "macOS, WHP on Windows"
)

# `machine status --json` reports RecordState's Display form, which is
# lowercase. Only "running" can take a line: "frozen" is a fork base
# whose guest agent is paused by design, and "unreachable" means the
# VMM is alive but the guest agent stopped answering vsock pings.
RUNNING_STATE = "running"

STATE_HINTS: dict[str, str] = {
    "unreachable": (
        "its guest agent is not answering (the VMM is alive but the agent "
        "died); recover with `smolvm machine start --name {machine}`"
    ),
    "frozen": (
        "it is a frozen fork base, deliberately paused so its clones can "
        "copy-on-write from it; exec against a clone instead"
    ),
    "created": "it has never been started; start it with "
    "`smolvm machine start --name {machine}`",
    "stopped": "it is stopped; start it with "
    "`smolvm machine start --name {machine}`",
    "failed": "it crashed; inspect with `smolvm machine status --name {machine}`",
}


def not_running_hint(machine: str, state: str) -> str:
    """Why this machine cannot take a line, named by its state.

    Args:
        machine (str): the configured machine name.
        state (str): the state string smolvm reported.
    """
    detail = STATE_HINTS.get(state)
    if detail is None:
        return f"machine {machine} is not running (state: {state})"
    reason = detail.format(machine=machine)
    return f"machine {machine} is not running: {reason}"
