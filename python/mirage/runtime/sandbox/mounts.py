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

import asyncio
import logging
import re
import uuid
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

from mirage.context import get_current_session
from mirage.runtime.binding import WorkspaceBinding
from mirage.runtime.sandbox.constants import (
    MOUNT_POLL_SECONDS,
    MOUNT_WAIT_SECONDS,
    PIPE_SERVER_HINT,
    SSHFS_HINT,
    SSHFS_LOG_PREFIX,
    SSHFS_OPTIONS,
    UNMOUNT_WAIT_SECONDS,
)
from mirage.runtime.types import MountType, RunResult, SandboxPipe
from mirage.utils.quote import single_quote
from mirage.workspace.files import Files
from mirage.workspace.session import SessionState

logger = logging.getLogger(__name__)

serve_pipe: Any
try:
    from mirage.mount.sftp import serve_pipe as _serve_pipe
except ImportError:
    serve_pipe = None
else:
    serve_pipe = _serve_pipe

OCTAL_ESCAPE = re.compile(r"\\([0-7]{3})")


def octal_char(match: re.Match[str]) -> str:
    return chr(int(match.group(1), 8))


def mount_table(text: str) -> dict[str, str]:
    """Each mountpoint a ``/proc/mounts`` lists, with its type.

    The kernel escapes a space in a path as ``\\040``; that is undone. A
    point mounted twice keeps the later (top) entry's type.

    Args:
        text (str): the file's contents.
    """
    table: dict[str, str] = {}
    for line in text.splitlines():
        fields = line.split()
        if len(fields) >= 3:
            table[OCTAL_ESCAPE.sub(octal_char, fields[1])] = fields[2]
    return table


def said(data: bytes | None) -> str:
    """What a command wrote, as text for a message.

    Args:
        data (bytes | None): its stdout or stderr.
    """
    return (data or b"").decode(errors="replace").strip()


def top_prefixes(prefixes: Iterable[str]) -> list[str]:
    """The prefixes a sandbox mounts: each one under no other.

    A prefix under another is served through it. The root and the
    workspace's devices are left out: a sandbox's ``/`` and ``/dev`` are
    its own, and nothing can be mounted over them.

    Args:
        prefixes (Iterable[str]): the mount prefixes the session sees.
    """
    tops: list[str] = []
    paths = {p.rstrip("/") for p in prefixes} - {"", "/dev"}
    for prefix in sorted(paths):
        if not any(prefix.startswith(top + "/") for top in tops):
            tops.append(prefix)
    return tops


class SandboxMounts:
    """The workspace prefixes one sandbox sees, by its ``mount_type``.

    ``ssh``: every prefix the session sees is served from the host over
    SFTP, and the sandbox mounts each with ``sshfs -o passive`` on a pipe
    the provider holds open, so every file op in the sandbox is an op of
    the session, held to its hides, modes and policies. ``fuse``: a
    mirage in the sandbox serves its prefixes itself and the host serves
    none. ``both``: a prefix the sandbox already mounts is its own, and
    the host serves the rest. A prefix the sandbox serves itself is out
    of the session's rules' reach, so a line is refused while a hide or
    rule covers anything under one.

    The mounts are made on the first line. What the host serves shows that
    line's session: one path in a sandbox shows one view, so while the
    host serves anything, a line of another session is refused rather
    than shown the first one's.

    Args:
        runtime (str): the runtime's name, for messages.
        mount_type (MountType): ssh, fuse or both.
        run (Callable[[str], Awaitable[RunResult]]): runs one setup
            command in the sandbox.
        open_pipe (Callable[[str], Awaitable[SandboxPipe]]): starts a
            command in the sandbox with its stdin and stdout held open.
    """

    def __init__(
        self,
        runtime: str,
        mount_type: MountType,
        run: Callable[[str], Awaitable[RunResult]],
        open_pipe: Callable[[str], Awaitable[SandboxPipe]],
    ) -> None:
        self._runtime = runtime
        self._mount_type = mount_type
        self._run = run
        self._open_pipe = open_pipe
        self._mounted = False
        self._session_id: str | None = None
        self._own: tuple[str, ...] = ()
        self._served: list[tuple[str, SandboxPipe, asyncio.Task[None]]] = []
        self._lock = asyncio.Lock()

    async def admit(self, binding: WorkspaceBinding | None) -> str | None:
        """Mount on the first line; after that, why a line may not run.

        Args:
            binding (WorkspaceBinding | None): the runtime's workspace.

        Returns:
            str | None: the refusal, None when the line may run.
        """
        if binding is None or binding.files is None:
            raise RuntimeError(
                f"{self._runtime}: mount_type needs the runtime in a workspace"
            )
        session = get_current_session()
        if session is None:
            raise RuntimeError(
                f"{self._runtime}: mount_type serves a session's view, "
                "and this line runs as none"
            )
        async with self._lock:
            if not self._mounted:
                await self._mount(binding, binding.files, session)
            elif self._session_id not in (None, session.session_id):
                return (
                    f"this sandbox shows session {self._session_id}'s view "
                    f"of the workspace; give session {session.session_id} "
                    "a sandbox of its own"
                )
        scoped = binding.capture().ns.scoped
        for prefix in self._own:
            if scoped is not None and scoped(prefix):
                return (
                    f"{prefix} is served by the sandbox itself, out of "
                    "reach of this session's rules"
                )
        return None

    async def close(self) -> None:
        """Unmount every served prefix and end its SFTP server."""
        async with self._lock:
            await self._unmount()

    async def _mount(
        self, binding: WorkspaceBinding, files: Files, session: SessionState
    ) -> None:
        present = await self._table()
        tops = top_prefixes(binding.resolver.prefixes())
        own = tuple(
            p for p in tops if self._mount_type != "ssh" and p in present
        )
        served = [
            p for p in tops if self._mount_type != "fuse" and p not in own
        ]
        if served:
            if serve_pipe is None:
                raise ImportError(PIPE_SERVER_HINT)
            if (await self._run("command -v sshfs")).exit_code != 0:
                raise RuntimeError(f"{self._runtime}: {SSHFS_HINT}")
        try:
            for prefix in served:
                await self._serve(files, session, prefix, present)
        except BaseException:
            await self._unmount()
            raise
        self._own = own
        self._session_id = session.session_id if served else None
        self._mounted = True

    async def _serve(
        self,
        files: Files,
        session: SessionState,
        prefix: str,
        present: dict[str, str],
    ) -> None:
        path = single_quote(prefix)
        if present.get(prefix) == "fuse.sshfs":
            await self._run(f"fusermount3 -uz {path} || fusermount -uz {path}")
        made = await self._run(
            f"mkdir -p {path} 2>/dev/null || {{ sudo -n mkdir -p {path} && "
            f'sudo -n chown "$(id -u):$(id -g)" {path}; }}'
        )
        if made.exit_code != 0:
            raise RuntimeError(
                f"{self._runtime}: cannot make {prefix} in the sandbox: "
                f"{said(made.stderr)}"
            )
        log = single_quote(f"{SSHFS_LOG_PREFIX}_{uuid.uuid4().hex}.log")
        source = single_quote(f"mirage:{prefix}")
        pipe = await self._open_pipe(
            f"exec sshfs -f -o {SSHFS_OPTIONS} {source} {path} 2>{log}"
        )
        task = asyncio.create_task(
            serve_pipe(files, session, pipe.reader, pipe.writer)
        )
        self._served.append((prefix, pipe, task))
        deadline = asyncio.get_running_loop().time() + MOUNT_WAIT_SECONDS
        while (await self._table()).get(prefix) != "fuse.sshfs":
            if task.done() or asyncio.get_running_loop().time() > deadline:
                written = await self._run(f"cat {log}")
                raise RuntimeError(
                    f"{self._runtime}: sshfs did not mount {prefix}: "
                    f"{said(written.stdout)}"
                )
            await asyncio.sleep(MOUNT_POLL_SECONDS)

    async def _table(self) -> dict[str, str]:
        listed = await self._run("cat /proc/mounts")
        if listed.exit_code != 0:
            raise RuntimeError(
                f"{self._runtime}: cannot read the sandbox's mount table: "
                f"{said(listed.stderr)}"
            )
        return mount_table(listed.stdout.decode(errors="replace"))

    async def _unmount(self) -> None:
        served, self._served = self._served, []
        self._mounted = False
        self._session_id = None
        self._own = ()
        for prefix, pipe, task in served:
            path = single_quote(prefix)
            try:
                done = await self._run(
                    f"fusermount3 -uz {path} || fusermount -uz {path}"
                )
                if done.exit_code != 0:
                    logger.warning(
                        "%s: unmounting %s in the sandbox failed: %s",
                        self._runtime,
                        prefix,
                        said(done.stderr),
                    )
                await pipe.stop()
                await asyncio.wait_for(task, UNMOUNT_WAIT_SECONDS)
            except Exception:
                logger.warning(
                    "%s: ending the SFTP server for %s failed",
                    self._runtime,
                    prefix,
                    exc_info=True,
                )
                task.cancel()
