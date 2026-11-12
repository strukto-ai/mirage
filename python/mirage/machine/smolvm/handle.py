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


from mirage.machine.constants import not_running_hint
from mirage.machine.program import reported_state
from mirage.machine.smolvm.config import SmolvmConfig
from mirage.machine.smolvm.constants import (
    RUNNING_STATE,
    SMOLVM_HINT,
    STATE_HINTS,
)
from mirage.machine.transport import ProgramMachine


class SmolvmMachine(ProgramMachine):
    """A running microVM, reached through ``smolvm machine exec``.

    You start the machine yourself; mirage only connects to it and
    execs lines. The `smolvm` program is the transport, so there is no SDK
    dependency and no daemon socket wiring; each line is one `smolvm
    machine exec` with the merged environment, the session cwd, real
    stdin, and separated stderr.

    Unlike a container, the guest runs its own kernel, so the line
    sees that kernel's filesystem and nothing of the host's except
    what the machine was given at boot (`--volume`). Serve the
    workspace inside the guest at the host's mount prefixes, the same
    contract every provider in this family carries.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (SmolvmConfig | dict[str, Any] | None): how to reach the machine.
    """

    provider = "smolvm"
    config_cls = SmolvmConfig
    config: SmolvmConfig
    program = "smolvm"
    install_hint = SMOLVM_HINT

    @property
    def instance(self) -> str:
        """The VM smolvm runs it in."""
        return self.config.machine

    def exec_words(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        return ("machine", "exec", "--name", self.config.machine, "-i"), (
            "--",
        )

    async def connect(self) -> None:
        """Probe the machine, refusing any state that cannot take a line.

        `machine exec` would start a stopped machine on its own, but
        this family never manages sandbox lifecycle, so a machine that
        is not already running is an error rather than a boot.
        """
        machine = self.config.machine
        status = await self._exec_program(
            ["machine", "status", "--name", machine, "--json"]
        )
        state = reported_state(status, "smolvm machine status", ("state",))
        if state != RUNNING_STATE:
            raise RuntimeError(
                not_running_hint("machine", machine, state, STATE_HINTS)
            )
