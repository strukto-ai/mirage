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
from contextvars import Context
from typing import Any

from mirage.context import get_current_session
from mirage.runtime.binding import WorkspaceBinding, restricted_mounts_for
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
    for prefix in sorted(mount_paths(prefixes)):
        if not any(prefix.startswith(top + "/") for top in tops):
            tops.append(prefix)
    return tops


def mount_paths(prefixes: Iterable[str]) -> set[str]:
    """The mountpoints a sandbox could hold of ``prefixes``.

    Args:
        prefixes (Iterable[str]): mount prefixes.
    """
    return {p.rstrip("/") for p in prefixes} - {"", "/dev"}


def unmount_line(prefix: str) -> str:
    """The sandbox command that lazily unmounts ``prefix``.

    Args:
        prefix (str): the mountpoint.
    """
    path = single_quote(prefix)
    return f"fusermount3 -uz {path} || fusermount -uz {path}"


class SandboxMounts:
    """The workspace prefixes one sandbox sees, by its ``mount_type``.

    ``ssh``: every prefix the session sees is served from the host over
    SFTP, and the sandbox mounts each with ``sshfs -o passive`` on a pipe
    the provider holds open, so every file op in the sandbox is an op of
    the session, held to its hides, modes and policies. ``fuse``: a
    mirage in the sandbox serves its prefixes itself and the host serves
    none. ``both``: a prefix the sandbox already mounts is its own, and
    the host serves the rest. A prefix the sandbox serves itself is out
    of the session's rules' reach, so a line is refused while a hide,
    rule or mode cap covers anything under one, hidden mounts included.

    Each line first brings the mounts in step with the workspace: a mount
    added or shown since is served, one hidden is dropped, and a server
    that ended is started again. While a rule reaches under a prefix, the
    sandbox's own mounts are read again for each line, so one it mounted
    since is refused too. A server runs outside the line that started it,
    so it answers as the session alone and never with a grant that line
    was given. What the host serves shows one session's
    view, and a program a line starts may outlive it, so under ``ssh`` and
    ``both`` the sandbox belongs to the first session it serves or runs a
    line for, until it is closed: a line of another session is refused
    rather than shown, or showing, the first one's view, and so is a
    session made again under the same id, which a program the first one
    started could otherwise read through. Under ``fuse`` the host serves
    nothing, and any session may run.

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
        self._session: SessionState | None = None
        self._served: dict[str, tuple[SandboxPipe, asyncio.Task[None]]] = {}
        self._seen: tuple[frozenset[str], frozenset[str]] | None = None
        self._lock = asyncio.Lock()

    @property
    def file_effects_dispatched(self) -> bool:
        """SSH mode serves every workspace prefix through the host's gate."""
        return self._mount_type == "ssh"

    async def admit(self, binding: WorkspaceBinding | None) -> str | None:
        """Bring the mounts in step, then say why a line may not run.

        Args:
            binding (WorkspaceBinding | None): the runtime's workspace.

        Returns:
            str | None: the refusal, None when the line may run.
        """
        if (
            binding is None
            or binding.files is None
            or binding.get_session is None
            or binding.mount_prefixes is None
        ):
            raise RuntimeError(
                f"{self._runtime}: mount_type needs the runtime in a workspace"
            )
        current = get_current_session()
        if current is None:
            raise RuntimeError(
                f"{self._runtime}: mount_type serves a session's view, "
                "and this line runs as none"
            )
        rules = current.commands
        if rules is not None and any(
            rule.commands and (rule.paths or rule.mount)
            for rule in (*rules.ask, *rules.deny)
        ):
            return "this file transport cannot enforce program-specific path rules"
        async with self._lock:
            served = self._session
            session = binding.get_session(current.session_id)
            if served is not None and served is not session:
                earlier = (
                    "an earlier "
                    if served.session_id == current.session_id
                    else ""
                )
                return (
                    f"this sandbox shows {earlier}session "
                    f"{served.session_id}'s view of the workspace; give "
                    f"session {current.session_id} a sandbox of its own"
                )
            every = mount_paths(binding.mount_prefixes())
            ruled = frozenset(
                p.rstrip("/") or "/"
                for p in restricted_mounts_for(
                    current, binding.mount_prefixes()
                )
            )
            await self._reconcile(
                binding, binding.files, session, every, ruled
            )
            refusal = self._refusal(ruled)
            if self._mount_type != "fuse" and (
                refusal is None or self._served
            ):
                self._session = session
        return refusal

    async def close(self) -> None:
        """Unmount every served prefix and end its SFTP server."""
        async with self._lock:
            await self._unmount()
            self._session = None

    def _refusal(self, ruled: frozenset[str]) -> str | None:
        for prefix in sorted(ruled):
            if not any(
                prefix == p or prefix.startswith(p.rstrip("/") + "/")
                for p in self._served
            ):
                return (
                    f"{prefix} is not served through the dispatcher, out of "
                    "reach of this session's rules"
                )
        return None

    async def _reconcile(
        self,
        binding: WorkspaceBinding,
        files: Files,
        session: SessionState,
        every: set[str],
        ruled: frozenset[str],
    ) -> None:
        visible = frozenset(
            top_prefixes(binding.resolver.prefixes())
            if self._mount_type != "fuse"
            else ()
        )
        ended = [p for p, (_, task) in self._served.items() if task.done()]
        if (
            self._seen == (frozenset(every), visible)
            and not ended
            and (self._mount_type == "ssh" or not ruled)
        ):
            return
        present = await self._table()
        own = tuple(
            sorted(
                p
                for p in every
                if self._mount_type != "ssh"
                and p in present
                and p not in self._served
            )
        )
        wanted = sorted(p for p in visible if p not in own)
        for prefix in wanted:
            under = [o for o in own if o.startswith(prefix + "/")]
            if under:
                raise RuntimeError(
                    f"{self._runtime}: the sandbox mounts {under[0]} itself, "
                    f"and serving {prefix} would cover it"
                )
        for prefix in [
            p for p in self._served if p not in wanted or p in ended
        ]:
            await self._drop(prefix)
        new = [p for p in wanted if p not in self._served]
        if new:
            if serve_pipe is None:
                raise ImportError(PIPE_SERVER_HINT)
            if (await self._run("command -v sshfs")).exit_code != 0:
                raise RuntimeError(f"{self._runtime}: {SSHFS_HINT}")
            try:
                for prefix in new:
                    await self._serve(files, session, prefix, present)
            except BaseException:
                await self._unmount()
                raise
        self._seen = (frozenset(every), visible)

    async def _serve(
        self,
        files: Files,
        session: SessionState,
        prefix: str,
        present: dict[str, str],
    ) -> None:
        if present.get(prefix) == "fuse.sshfs":
            await self._run(unmount_line(prefix))
        path = single_quote(prefix)
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
            serve_pipe(files, session, pipe.reader, pipe.writer),
            context=Context(),
        )
        self._served[prefix] = (pipe, task)
        try:
            deadline = asyncio.get_running_loop().time() + MOUNT_WAIT_SECONDS
            while (await self._table()).get(prefix) != "fuse.sshfs":
                if task.done() or asyncio.get_running_loop().time() > deadline:
                    written = await self._run(f"cat {log}")
                    failed = (
                        task.exception()
                        if task.done() and not task.cancelled()
                        else None
                    )
                    reason = said(written.stdout) or "no word from sshfs"
                    if failed is not None:
                        reason += f"; the SFTP server failed: {failed}"
                    raise RuntimeError(
                        f"{self._runtime}: sshfs did not mount {prefix}: {reason}"
                    )
                await asyncio.sleep(MOUNT_POLL_SECONDS)
        finally:
            current = asyncio.current_task()
            if current is None or not current.cancelling():
                await self._drop_log(log)

    async def _drop_log(self, log: str) -> None:
        """Remove the helper's setup log; keeping it only costs a file.

        Args:
            log (str): the quoted log path in the sandbox.
        """
        try:
            removed = await self._run(f"rm -f -- {log}")
        except Exception as exc:
            logger.debug("could not remove sshfs log: %s", exc)
            return
        if removed.exit_code != 0:
            logger.debug(
                "could not remove sshfs log: %s", said(removed.stderr)
            )

    async def _table(self) -> dict[str, str]:
        listed = await self._run("cat /proc/mounts")
        if listed.exit_code != 0:
            raise RuntimeError(
                f"{self._runtime}: cannot read the sandbox's mount table: "
                f"{said(listed.stderr)}"
            )
        return mount_table(listed.stdout.decode(errors="replace"))

    async def _drop(self, prefix: str) -> None:
        pipe, task = self._served.pop(prefix)
        try:
            done = await self._run(unmount_line(prefix))
            if done.exit_code != 0:
                logger.warning(
                    "%s: unmounting %s in the sandbox failed: %s",
                    self._runtime,
                    prefix,
                    said(done.stderr),
                )
        except Exception:
            logger.warning(
                "%s: unmounting %s in the sandbox failed",
                self._runtime,
                prefix,
                exc_info=True,
            )
        try:
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

    async def _unmount(self) -> None:
        for prefix in list(self._served):
            await self._drop(prefix)
        self._seen = None
