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

import shlex

from camel.toolkits import BaseToolkit, FunctionTool

from mirage.agents.camel._async import AsyncRunner
from mirage.io.types import IOResult
from mirage.workspace.workspace import Workspace


def _decode(value: bytes | None) -> str:
    if value is None:
        return ""
    return value.decode("utf-8", errors="replace")


def _io_to_str(io: IOResult) -> str:
    stdout = _decode(io.stdout if isinstance(io.stdout, bytes) else None)
    stderr = _decode(io.stderr if isinstance(io.stderr, bytes) else None)
    if stderr:
        return f"{stdout}\n{stderr}" if stdout else stderr
    return stdout


def _parse_job_id(stderr: str) -> int | None:
    line = stderr.strip()
    if line.startswith("[") and "]" in line:
        try:
            return int(line[1:line.index("]")])
        except ValueError:
            return None
    return None


class MirageTerminalToolkit(BaseToolkit):

    def __init__(self,
                 workspace: Workspace,
                 timeout: float | None = 20.0) -> None:
        super().__init__(timeout=timeout)
        self._ws = workspace
        self._runner = AsyncRunner()
        self._sessions: dict[str, int] = {}

    def close(self) -> None:
        self._runner.close()

    def shell_exec(
        self,
        id: str,
        command: str,
        block: bool = True,
        timeout: float = 20.0,
    ) -> str:
        """Run command in the Mirage workspace.

        Args:
            id (str): Session identifier (mapped to a Mirage job id).
            command (str): Shell command to execute.
            block (bool): Wait for completion when True; otherwise launch
                the command in the background via Mirage's & operator.
            timeout (float): Reserved for future use.

        Returns:
            str: Combined stdout/stderr (blocking) or a confirmation
                message with the session id (non-blocking).
        """
        if block:
            io = self._runner.run(self._ws.execute(command))
            return _io_to_str(io)
        bg_cmd = f"{command} &"
        io = self._runner.run(self._ws.execute(bg_cmd))
        stderr = _decode(io.stderr if isinstance(io.stderr, bytes) else None)
        job_id = _parse_job_id(stderr)
        if job_id is None:
            return f"Failed to launch background job: {stderr}"
        self._sessions[id] = job_id
        return f"Started session '{id}' as Mirage job [{job_id}]"

    def shell_view(self, id: str) -> str:
        """Return the latest output for a session.

        Args:
            id (str): Session identifier from a prior non-blocking
                shell_exec call.

        Returns:
            str: jobs status if still running, or wait output if completed.
        """
        job_id = self._sessions.get(id)
        if job_id is None:
            return f"Error: no session '{id}'"
        ps_io = self._runner.run(self._ws.execute("ps"))
        ps_out = _decode(
            ps_io.stdout if isinstance(ps_io.stdout, bytes) else None)
        if any(line.startswith(f"{job_id}\t") for line in ps_out.splitlines()):
            return ps_out
        wait_io = self._runner.run(self._ws.execute(f"wait %{job_id}"))
        return _io_to_str(wait_io)

    def shell_write_to_process(self, id: str, command: str) -> str:
        """Stub for camel API parity; Mirage shell is non-interactive.

        Args:
            id (str): Session identifier (unused).
            command (str): Input that would be sent to stdin (unused).

        Returns:
            str: Explanatory error message.
        """
        return ("Mirage shell is not interactive. Re-run shell_exec with "
                "stdin redirected via the command, e.g. "
                "'cat <<EOF | yourcmd\\nINPUT\\nEOF'.")

    def shell_kill_process(self, id: str) -> str:
        """Kill the Mirage job for a session.

        Args:
            id (str): Session identifier from a prior non-blocking
                shell_exec call.

        Returns:
            str: Status message.
        """
        job_id = self._sessions.pop(id, None)
        if job_id is None:
            return f"Error: no session '{id}'"
        io = self._runner.run(self._ws.execute(f"kill %{job_id}"))
        if io.exit_code != 0:
            return _io_to_str(io) or f"kill failed for [{job_id}]"
        return f"killed session '{id}' (job [{job_id}])"

    def shell_ask_user_for_help(self, id: str, prompt: str) -> str:
        """Placeholder hook for human-in-the-loop frameworks.

        Args:
            id (str): Session identifier (unused).
            prompt (str): The question the agent wants to ask.

        Returns:
            str: Echoed prompt.
        """
        return f"User prompt recorded (no human attached): {prompt}"

    def shell_write_content_to_file(self, content: str, file_path: str) -> str:
        """Write content to a file via Mirage Workspace.

        Args:
            content (str): UTF-8 text to write.
            file_path (str): Logical Mirage path.

        Returns:
            str: Success or error message.
        """
        quoted = shlex.quote(file_path)
        io = self._runner.run(
            self._ws.execute(f"cat > {quoted}", stdin=content.encode()))
        if io.exit_code != 0:
            return f"Error writing {file_path}: {_io_to_str(io)}"
        return f"Wrote {len(content)} bytes to {file_path}"

    def get_tools(self) -> list[FunctionTool]:
        return [
            FunctionTool(self.shell_exec),
            FunctionTool(self.shell_view),
            FunctionTool(self.shell_write_to_process),
            FunctionTool(self.shell_kill_process),
            FunctionTool(self.shell_ask_user_for_help),
            FunctionTool(self.shell_write_content_to_file),
        ]
