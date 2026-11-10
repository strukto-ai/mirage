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

from mirage.io.types import ByteSource
from mirage.machine.constants import not_running_hint, wrap_line
from mirage.machine.errors import ConnectionLostError
from mirage.machine.kubernetes.config import KubernetesConfig
from mirage.machine.kubernetes.constants import (
    EXIT_PREFIX,
    EXIT_STATUS,
    KUBECTL_HINT,
    RUNNING_PHASE,
    no_stdin,
    own_stdin,
)
from mirage.machine.program import open_program_pipe, reported_state
from mirage.machine.transport import ProgramMachine
from mirage.machine.types import MachinePipe
from mirage.runtime.types import OutputFn, RunResult


def exit_report_start(stderr: bytes) -> int:
    """Where kubectl's report of the exit status can begin in the stderr
    so far, or its length when it cannot be there. The report follows
    the program's last byte directly, on a line of its own or not.

    Args:
        stderr (bytes): the stderr not yet passed on.
    """
    at = stderr.rfind(EXIT_PREFIX)
    if at >= 0 and EXIT_STATUS.fullmatch(stderr, at + len(EXIT_PREFIX)):
        return at
    size = len(stderr)
    for start in range(max(0, size - len(EXIT_PREFIX) + 1), size):
        if EXIT_PREFIX.startswith(stderr[start:]):
            return start
    return size


class ExitLineFilter:
    """kubectl's stderr with its own report of the exit status taken
    out, so a failing program says only what it said itself.

    The report comes last, so only an ending that can still become one
    is held; everything else passes as it arrives.

    Args:
        errors (OutputFn | None): receives stderr as it arrives; None
            keeps it for ``kept``.
    """

    def __init__(self, errors: OutputFn | None) -> None:
        self._errors = errors
        self._held = bytearray()
        self._kept = bytearray()

    @property
    def kept(self) -> bytes | None:
        """The stderr kept when nothing receives it, None for none."""
        return bytes(self._kept) or None

    async def _emit(self, data: bytes) -> None:
        if not data:
            return
        if self._errors is None:
            self._kept += data
        else:
            await self._errors(data)

    async def write(self, data: bytes) -> None:
        """Pass on what cannot be the report.

        Args:
            data (bytes): the next bytes of stderr.
        """
        self._held += data
        held = bytes(self._held)
        end = exit_report_start(held)
        self._held = bytearray(held[end:])
        await self._emit(held[:end])

    async def finish(self, exit_code: int) -> bool:
        """Settle the last line once kubectl has exited.

        Args:
            exit_code (int): kubectl's exit status.

        Returns:
            bool: True when the status is the program's; False when
            kubectl failed by itself and the program's is unknown.
        """
        held = bytes(self._held)
        self._held.clear()
        if exit_code != 0 and held == b"%b%d\n" % (EXIT_PREFIX, exit_code):
            return True
        await self._emit(held)
        return exit_code == 0


class KubernetesMachine(ProgramMachine):
    """A running pod, reached through ``kubectl exec``.

    You create the pod yourself; mirage only connects to it and execs
    lines. The `kubectl` program is the transport, with the credentials
    and context it already has, so there is no SDK dependency; each line
    is one `kubectl exec`, `--stdin` when it has input, with separated stderr.
    `kubectl exec` has no ``-w``/``-e``, so the working directory and
    environment ride the command, as over SSH.

    A pod is a machine whatever isolates it: on EKS, a pod with
    ``runtimeClassName: isolated-sandbox`` is a Nitro Sandbox. A
    ``confidential-sandbox`` pod denies exec, so it cannot take a line.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (KubernetesConfig | dict[str, Any] | None): how to reach
            the machine.
    """

    provider = "kubernetes"
    config_cls = KubernetesConfig
    config: KubernetesConfig
    program = "kubectl"
    install_hint = KUBECTL_HINT

    def _scope(self) -> tuple[str, ...]:
        """The flags naming the pod's cluster and namespace."""
        config = self.config
        context = (
            () if config.context is None else ("--context", config.context)
        )
        namespace = (
            ()
            if config.namespace is None
            else ("--namespace", config.namespace)
        )
        return (*context, *namespace)

    def exec_words(
        self, stdin: bool = True
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        config = self.config
        container = (
            ()
            if config.container is None
            else ("--container", config.container)
        )
        return (
            "exec",
            *(("--stdin",) if stdin else ()),
            "--quiet",
            *self._scope(),
            *container,
        ), (config.pod, "--")

    async def connect(self) -> None:
        pod = self.config.pod
        status = await self._exec_program(
            ["get", "pod", *self._scope(), pod, "--output", "json"]
        )
        phase = reported_state(status, "kubectl get pod", ("status", "phase"))
        if phase != RUNNING_PHASE:
            raise RuntimeError(not_running_hint("pod", pod, phase, {}))

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn | None,
        errors: OutputFn | None,
    ) -> RunResult:
        # A run with no input takes no stdin, so its program's end of input
        # does not ride kubectl's stream.
        given = stdin is not None and stdin != b""
        head, tail = self.exec_words(given)
        line = wrap_line(argv, env, cwd)
        said = ExitLineFilter(errors)
        try:
            done = await self._exec_program(
                [
                    *head,
                    *tail,
                    "/bin/sh",
                    "-c",
                    line if given else no_stdin(line),
                ],
                stdin=stdin if given else None,
                output=output,
                errors=said.write,
            )
        except Exception:
            # A failed kubectl reports nothing, so what is held is the
            # program's. A cancel skips this: a receiver that stopped
            # reading would hold up the stop.
            await said.finish(0)
            raise
        if not await said.finish(done.exit_code):
            raise ConnectionLostError(
                f"kubectl exited {done.exit_code} without the program's status",
                done.stdout,
                said.kept,
            )
        return RunResult(
            stdout=done.stdout, stderr=said.kept, exit_code=done.exit_code
        )

    async def open_pipe(self, command: str) -> MachinePipe:
        head, tail = self.exec_words()
        return await open_program_pipe(
            self.program, [*head, *tail, "/bin/sh", "-c", own_stdin(command)]
        )
