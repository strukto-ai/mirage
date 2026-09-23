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

from pathlib import Path
from typing import Any

from mirage.runtime.sandbox.base import RemoteSandbox
from mirage.runtime.sandbox.ssh import sdk
from mirage.runtime.sandbox.ssh.config import SSHRuntimeConfig
from mirage.runtime.sandbox.ssh.constants import ASYNCSSH_HINT, wrap_line
from mirage.runtime.types import RunResult


class SSHRuntime(RemoteSandbox):
    """A machine reached over SSH as a whole-line runtime.

    You run the machine and its sshd yourself; mirage only connects
    (keys or agent, never a password) and execs lines. One connection
    opens on the first captured line and is reused; each line is one
    exec channel with real byte stdin and separated stderr, the merged
    environment and session cwd dressed onto the command by wrap_line,
    because SSH exec has no docker-style ``-w``/``-e``.

    This is the one provider whose machine usually IS the fileserver:
    mount the same host's directory over the ssh VFS at a prefix
    equal to its remote absolute path, and captured lines read and
    write those files natively, with no FUSE and no mirage installed
    remotely. Host keys are not verified (the TypeScript twin's ssh2
    transport never does), so treat the network path as trusted.

    Args:
        options (Any): the RemoteSandbox constructor fields.
    """

    name = "ssh"
    config_cls = SSHRuntimeConfig
    config: SSHRuntimeConfig
    _conn: Any = None

    def _connect_kwargs(self) -> dict[str, Any]:
        config = self.config
        kwargs: dict[str, Any] = {"host": config.hostname or config.host}
        if config.port:
            kwargs["port"] = config.port
        if config.username:
            kwargs["username"] = config.username
        if config.identity_file:
            kwargs["client_keys"] = [
                str(Path(config.identity_file).expanduser())
            ]
        kwargs["known_hosts"] = None
        kwargs["login_timeout"] = config.timeout
        return kwargs

    async def connect(self) -> None:
        if sdk.connect is None:
            raise ImportError(ASYNCSSH_HINT)
        self._conn = await sdk.connect(**self._connect_kwargs())

    async def exec_line(self, line: str, stdin: bytes | None,
                        env: dict[str, str], cwd: str) -> RunResult:
        stdout, stderr, code = await self._ssh(wrap_line(line, env, cwd),
                                               stdin)
        return RunResult(stdout=stdout, stderr=stderr, exit_code=code)

    async def _ssh(self, command: str,
                   stdin: bytes | None) -> tuple[bytes, bytes, int]:
        """One exec channel on the connection; the seam tests override."""
        # asyncssh's run(input=b"") leaves stdin open. Close it explicitly
        # for every finite command, including empty or absent piped input.
        async with self._conn.create_process(command,
                                             encoding=None) as process:
            if stdin:
                process.stdin.write(stdin)
            process.stdin.write_eof()
            result = await process.wait(check=False)
        code = result.returncode if result.returncode is not None else 1
        return result.stdout, result.stderr, code

    async def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            await self._conn.wait_closed()
            self._conn = None
