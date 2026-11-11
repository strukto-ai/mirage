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
import importlib
import logging
import re
import uuid
from collections.abc import Awaitable, Callable, Coroutine, Iterable
from contextvars import Context
from typing import Any, TypeVar

from mirage.context import (
    Caller,
    bind_caller,
    current_caller,
    get_current_session,
    reset_caller,
)
from mirage.errors.fs import strerror_of
from mirage.machine.constants import (
    MOUNT_GUARD,
    MOUNT_POLL_SECONDS,
    MOUNT_WAIT_SECONDS,
    PIPE_SERVER_HINT,
    SSHFS_HINT,
    SSHFS_LOG_PREFIX,
    SSHFS_OPTIONS,
    SSHFS_SOURCE_PREFIX,
    UNMOUNT_WAIT_SECONDS,
    mount_field,
)
from mirage.machine.types import MachinePipe, MountType
from mirage.runtime.binding import (
    WorkspaceBinding,
    refused_run,
    restricted_mounts_for,
)
from mirage.runtime.types import RunResult
from mirage.shell.constants import CANNOT_EXECUTE_STATUS
from mirage.utils.quote import single_quote
from mirage.workspace.files import Files
from mirage.workspace.session import SessionState

logger = logging.getLogger(__name__)

T = TypeVar("T")


def pipe_server() -> Any:
    """The SFTP pipe server class, imported on the first machine mount so
    a process that never mounts into a machine does not load asyncssh,
    as the machine registry defers a provider.

    Raises:
        ImportError: the `ssh` extra (asyncssh) is not installed.
    """
    try:
        return importlib.import_module("mirage.mount.sftp").PipeServer
    except ModuleNotFoundError as exc:
        if exc.name != "asyncssh":
            raise
        raise ImportError(PIPE_SERVER_HINT) from exc


OCTAL_ESCAPE = re.compile(r"\\([0-7]{3})")


def octal_char(match: re.Match[str]) -> str:
    return chr(int(match.group(1), 8))


def mount_table(text: str) -> dict[str, tuple[str, str]]:
    """Each mountpoint a ``/proc/mounts`` lists, with its source and type.

    The kernel escapes a space in a source or path as ``\\040``; that is
    undone. A point mounted twice keeps the later (top) entry.

    Args:
        text (str): the file's contents.
    """
    table: dict[str, tuple[str, str]] = {}
    for line in text.splitlines():
        fields = line.split()
        if len(fields) >= 3:
            table[OCTAL_ESCAPE.sub(octal_char, fields[1])] = (
                OCTAL_ESCAPE.sub(octal_char, fields[0]),
                fields[2],
            )
    return table


def said(data: bytes | None) -> str:
    """What a command wrote, as text for a message.

    Args:
        data (bytes | None): its stdout or stderr.
    """
    return (data or b"").decode(errors="replace").strip()


def top_prefixes(prefixes: Iterable[str]) -> list[str]:
    """The prefixes a machine mounts: each one under no other.

    A prefix under another is served through it. The root and the
    workspace's devices are left out: a machine's ``/`` and ``/dev`` are
    its own, and nothing can be mounted over them.

    Args:
        prefixes (Iterable[str]): the mount prefixes the session sees.
    """
    tops: list[str] = []
    for prefix in sorted(mount_paths(prefixes)):
        if not any(prefix.startswith(top + "/") for top in tops):
            tops.append(prefix)
    return tops


def served_prefixes(prefixes: Iterable[str]) -> list[str]:
    """The prefixes ssh serves a machine: its top prefixes but ``/tmp``.

    ``/tmp`` stays the machine's own. The machine keeps its sockets,
    temporary files and Mirage's own run reports there, and a user who is
    not root cannot mount over it. A mount under ``/tmp`` is still served
    at its own path.

    Args:
        prefixes (Iterable[str]): the mount prefixes the session sees.
    """
    return top_prefixes(p for p in prefixes if p.rstrip("/") != "/tmp")


def mount_paths(prefixes: Iterable[str]) -> set[str]:
    """The mountpoints a machine could hold of ``prefixes``.

    Args:
        prefixes (Iterable[str]): mount prefixes.
    """
    return {p.rstrip("/") for p in prefixes} - {"", "/dev"}


def unmount_line(prefix: str) -> str:
    """The machine command that lazily unmounts ``prefix``.

    Args:
        prefix (str): the mountpoint.
    """
    path = single_quote(prefix)
    return f"fusermount3 -uz {path} || fusermount -uz {path}"


def unmounted(provider: str, prefix: str) -> str:
    """Why a line did not run: the machine no longer holds ``prefix``.

    Args:
        provider (str): the machine's provider, for the message.
        prefix (str): the mountpoint.
    """
    return (
        f"{provider}: {prefix} is no longer mounted in the machine (did it "
        "restart?); the line did not run"
    )


def running_line(source: str) -> str:
    """The machine command that exits 0 while a program runs with
    ``source`` as one of its arguments, as an sshfs serving it does, 1
    once none does, and 2 when it read no process at all. It reads
    ``/proc``, never the mount, so a mount whose server stalled cannot
    hang it, and hands awk the source in its environment, never an
    argument, so the check never finds itself. A newline inside an
    argument becomes ``\\001`` on both sides, apart from the NUL that ends
    each argument.

    Args:
        source (str): the mount's source.
    """
    return (
        "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0\\n' '\\n\\001' | "
        f"S={single_quote(source.replace(chr(10), chr(1)))} awk "
        '\'BEGIN { s = ENVIRON["S"] } $0 == s { f = 1 } '
        "END { exit f ? 0 : NR ? 1 : 2 }'"
    )


def kill_line(source: str) -> str:
    """The machine command that kills every program with ``source`` as
    one of its arguments, as an sshfs serving it has, reading ``/proc`` as
    ``running_line`` does, so it never kills itself. SIGKILL: what the
    server never answered can no longer land, and only the daemon's death
    frees a program blocked on the mount.

    Args:
        source (str): the mount's source.
    """
    return (
        "for p in /proc/[0-9]*; do tr '\\0\\n' '\\n\\001' "
        '<"$p/cmdline" 2>/dev/null | '
        f"S={single_quote(source.replace(chr(10), chr(1)))} awk "
        "'BEGIN { s = ENVIRON[\"S\"] } $0 == s { f = 1 } END { exit !f }' "
        '&& kill -KILL "${p#/proc/}" 2>/dev/null; done; :'
    )


class MachineMounts:
    """The workspace prefixes one machine sees, by its ``mount_type``.

    ``ssh``: every prefix the session sees is served from the host over
    SFTP, and the machine mounts each with ``sshfs -o passive`` on a pipe
    the provider holds open, so every file op in the machine is an op of
    the session, held to its hides, modes and policies. ``fuse``: a
    mirage in the machine serves its prefixes itself and the host serves
    none. ``both``: a prefix the machine already mounts is its own, and
    the host serves the rest. A prefix the machine serves itself is out
    of the session's rules' reach, so a line is refused while a hide,
    rule or mode cap covers anything under one, hidden mounts included.

    Each line first brings the mounts in step with the workspace: a mount
    added or shown since is served, one hidden is dropped, and a server
    that ended is started again. While a rule reaches under a prefix, the
    machine's own mounts are read again for each line, so one it mounted
    since is refused too. A server runs outside the line that started it,
    so it answers as the session alone and never with a grant that line
    was given. What the host serves shows one session's
    view, and a program a line starts may outlive it, so under ``ssh`` and
    ``both`` the machine belongs to the first session it serves or runs a
    line for, until it is closed: a line of another session is refused
    rather than shown, or showing, the first one's view, and so is a
    session made again under the same id, which a program the first one
    started could otherwise read through. Under ``fuse`` the host serves
    nothing, and any session may run.

    Each sshfs source names the instance serving it and the serve
    (``mirage-<id>-<n>:<prefix>``), so an instance unmounts only its own,
    and kills only the sshfs of a server that ended: a
    prefix another sshfs still serves, as another workspace on
    the same machine does, refuses the line (1) rather than being taken,
    and one whose sshfs has gone is unmounted and served.

    A machine may restart between a line's ``validate`` and its exec and come
    back without its mounts, so each line runs under ``MOUNT_GUARD``,
    which checks every mount it holds in the boot the program runs in
    and exits 126 with nothing run when one is gone. The next line reads
    the mounts again: what the host served is served again, and while a
    mount of the machine's own is gone lines are refused (126) until the
    machine mounts it again, rather than served over by the host. Under
    ``fuse`` the mounts are read on every line until the machine holds
    every prefix, so one it mounts late is guarded too.

    Args:
        provider (str): the machine's provider, for messages.
        mount_type (MountType): ssh, fuse or both.
        run (Callable[[str], Awaitable[RunResult]]): runs one setup
            command in the machine.
        open_pipe (Callable[[str], Awaitable[MachinePipe]]): starts a
            command in the machine with its stdin and stdout held open.
    """

    def __init__(
        self,
        provider: str,
        mount_type: MountType,
        run: Callable[[str], Awaitable[RunResult]],
        open_pipe: Callable[[str], Awaitable[MachinePipe]],
    ) -> None:
        self._provider = provider
        self._mount_type = mount_type
        self._run = run
        self._open_pipe = open_pipe
        self._session: SessionState | None = None
        # Each running line's write admission, and the served requests
        # running on it.
        self._lines: list[tuple[Caller, set[asyncio.Future[None]]]] = []
        # Each served prefix's pipe, server task, server and sshfs source.
        self._served: dict[
            str, tuple[MachinePipe, asyncio.Task[None], Any, str]
        ] = {}
        self._seen: tuple[frozenset[str], frozenset[str]] | None = None
        # The machine's own mounts as last read, and each prefix held since.
        self._own: dict[str, tuple[str, str]] = {}
        self._owned: set[str] = set()
        # What each served prefix was laid over, shown again once its server ends.
        self._under: dict[str, tuple[str, str] | None] = {}
        self._lock = asyncio.Lock()
        # Each kill of the sshfs of a server that ended, until it has run.
        self._kills: set[asyncio.Task[None]] = set()
        self._name = f"{SSHFS_SOURCE_PREFIX}{uuid.uuid4().hex}"
        # The prefixes served so far, numbering each sshfs's source.
        self._serves = 0

    @property
    def file_effects_dispatched(self) -> bool:
        """SSH mode serves every workspace prefix through the host's gate."""
        return self._mount_type == "ssh"

    async def validate(
        self, binding: WorkspaceBinding | None, cwd: str
    ) -> RunResult | None:
        """Record the line for ``sync``, bring the mounts in step, then
        refuse a line that may not run: one from a cwd other than ``/``
        that ssh serves no mount for (126), one the session's
        restrictions reach past the dispatcher, as a policy refuses it
        (126), one the machine cannot serve because another session or
        another sshfs holds it, or another mount covers it (1), and one
        over a mount of the machine's own that is gone (126).

        Args:
            binding (WorkspaceBinding | None): the runtime's workspace.
            cwd (str): the line's working directory.

        Returns:
            RunResult | None: the refused run, None when the line may run.
        """
        if (
            binding is None
            or binding.files is None
            or binding.get_session is None
            or binding.mount_prefixes is None
        ):
            raise RuntimeError(
                f"{self._provider}: mount_type needs the machine in a workspace"
            )
        line = current_caller()
        held = Caller(stop=line.stop, write_held=line.write_held)
        self._lines.append((held, set()))
        seen = cwd.rstrip("/")
        if (
            self._mount_type == "ssh"
            and seen
            and not any(
                seen == p or seen.startswith(p + "/")
                for p in served_prefixes(binding.mount_prefixes())
            )
        ):
            return RunResult(
                stdout=b"",
                stderr=(
                    f"{self._provider}: the machine cannot see the working "
                    f"directory {seen}; cd into a mount first\n"
                ).encode(),
                exit_code=CANNOT_EXECUTE_STATUS,
            )
        current = get_current_session()
        if current is None:
            raise RuntimeError(
                f"{self._provider}: mount_type serves a session's view, "
                "and this line runs as none"
            )
        rules = current.commands
        if rules is not None and any(
            rule.commands and (rule.paths or rule.mount)
            for rule in (*rules.ask, *rules.deny)
        ):
            return refused_run(
                self._provider,
                "this file transport cannot enforce program-specific path "
                "rules",
            )
        async with self._lock:
            served = self._session
            session = binding.get_session(current.session_id)
            if served is not None and served is not session:
                earlier = (
                    "an earlier "
                    if served.session_id == current.session_id
                    else ""
                )
                return RunResult(
                    stdout=b"",
                    stderr=(
                        f"{self._provider}: this machine shows {earlier}"
                        f"session {served.session_id}'s view of the "
                        f"workspace; give session {current.session_id} a "
                        "machine of its own\n"
                    ).encode(),
                    exit_code=1,
                )
            every = mount_paths(binding.mount_prefixes())
            ruled = frozenset(
                p.rstrip("/") or "/"
                for p in restricted_mounts_for(
                    current, binding.mount_prefixes()
                )
            )
            refused = await self._reconcile(
                binding, binding.files, session, every, ruled
            )
            if refused is not None:
                return RunResult(
                    stdout=b"",
                    stderr=f"{self._provider}: {refused}\n".encode(),
                    exit_code=1,
                )
            lost = self._lost()
            if lost is not None:
                return RunResult(
                    stdout=b"",
                    stderr=f"{unmounted(self._provider, lost)}\n".encode(),
                    exit_code=CANNOT_EXECUTE_STATUS,
                )
            unserved = self._unserved(ruled)
            if self._mount_type != "fuse" and (not unserved or self._served):
                self._session = session
        if unserved:
            return refused_run(
                self._provider,
                "a mount this session restricts is not served through the "
                "dispatcher",
            )
        return None

    def guarded(self, argv: tuple[str, ...]) -> tuple[str, ...]:
        """``argv`` under ``MOUNT_GUARD``, holding every mount the machine
        had at the line's ``validate``; unchanged when it had none.

        Args:
            argv (tuple[str, ...]): the program and its arguments.
        """
        held = {
            p: (source, "fuse.sshfs")
            for p, (_, _, _, source) in self._served.items()
        } | self._own
        if not held:
            return argv
        words: list[str] = []
        for prefix, (source, kind) in sorted(held.items()):
            words += [
                mount_field(prefix),
                mount_field(source, source=True),
                kind,
                unmounted(self._provider, prefix),
            ]
        return (
            "/bin/sh",
            "-c",
            MOUNT_GUARD,
            "sh",
            "/proc/mounts",
            *words,
            "--",
            *argv,
        )

    def forget(self) -> None:
        """Read the mounts again on the next line: a guarded line found
        one gone, or its program exited as the guard does."""
        self._seen = None

    async def close(self) -> None:
        """Unmount every served prefix and end its SFTP server."""
        for kill in self._kills:
            kill.cancel()
        async with self._lock:
            await self._unmount()
            self._session = None

    async def land(self) -> list[str]:
        """Land every write a served prefix's server has acknowledged.

        sshfs answers close(2) once the file's writes are acknowledged and
        sends the SFTP close that lands them afterwards, so a line can end
        before they land, and the program never hears of one that fails.
        This lands every one, outside the line as that close would, and
        ``file_effects_dispatched`` holds. Each landing keeps the line's
        write admission alone: a capture waiting for the line lets it
        through rather than waiting on it. Failures it cannot hand back,
        the landing stopped part way, are logged.

        Returns:
            list[str]: one line per write that failed to land, naming
            its path and why.
        """
        line = current_caller()
        admitted = Caller(stop=line.stop, write_held=line.write_held)
        failed: list[tuple[str, Exception]] = []
        syncing: asyncio.Task[list[tuple[str, Exception]]] | None = None
        try:
            for _, _, server, _ in list(self._served.values()):
                context = Context()
                context.run(bind_caller, admitted)
                syncing = asyncio.create_task(server.sync(), context=context)
                failed += await syncing
                syncing = None
        except BaseException:
            # A sync that finished as the landing stopped still counts.
            if (
                syncing is not None
                and syncing.done()
                and not syncing.cancelled()
                and syncing.exception() is None
            ):
                failed += syncing.result()
            # The line hears of none of these, and no landing reports them.
            for path, err in failed:
                logger.warning(
                    "%s: %s: %s", self._provider, path, strerror_of(err)
                )
            raise
        return [
            f"{self._provider}: {path}: {strerror_of(err)}"
            for path, err in failed
        ]

    async def sync(self) -> list[str]:
        """Land as ``land`` does as the line ends, however it ended. Then
        the line lends its admission to no more requests, and waits out
        the ones it lent it to, so a capture never reads past one still
        running.

        Returns:
            list[str]: one line per write that failed to land, naming
            its path and why.
        """
        line = current_caller()
        try:
            return await self.land()
        finally:
            for index, (held, lent) in enumerate(self._lines):
                if held.stop is line.stop:
                    del self._lines[index]
                    if lent:
                        await asyncio.wait(lent)
                    break

    async def _lend(self, op: Coroutine[Any, Any, T]) -> T:
        """Run one served request with the write admission of the latest
        line running in the machine, from its ``validate`` to its ``sync``,
        and none between lines.

        A program's file op then counts as its line's, so a capture
        waiting for that line lets it land rather than holding it while
        the line waits on it.

        Args:
            op (Coroutine[Any, Any, T]): the request's work.
        """
        if not self._lines:
            return await op
        held, lent = self._lines[-1]
        done: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        lent.add(done)
        token = bind_caller(
            current_caller().changed(
                {"stop": held.stop, "write_held": held.write_held}
            )
        )
        try:
            return await op
        finally:
            reset_caller(token)
            lent.discard(done)
            done.set_result(None)

    def _unserved(self, ruled: frozenset[str]) -> bool:
        return any(
            not any(
                prefix == p or prefix.startswith(p.rstrip("/") + "/")
                for p in self._served
            )
            for prefix in ruled
        )

    async def _reconcile(
        self,
        binding: WorkspaceBinding,
        files: Files,
        session: SessionState,
        every: set[str],
        ruled: frozenset[str],
    ) -> str | None:
        """Serve what the session sees and drop what it no longer does.

        Returns:
            str | None: why the line may not run, a prefix another sshfs
            still serves or another mount covers, which is left alone and
            nothing new served; None once in step, or with a mount of the
            machine's own gone, which ``validate`` refuses.
        """
        visible = frozenset(
            served_prefixes(binding.resolver.prefixes())
            if self._mount_type != "fuse"
            else ()
        )
        ended = [
            p for p, (_, task, _, _) in self._served.items() if task.done()
        ]
        if (
            self._seen == (frozenset(every), visible)
            and not ended
            and (self._mount_type == "ssh" or not ruled)
        ):
            return None
        self._seen = None
        present = await self._table()
        ended += [
            p for p in self._served if p not in ended and p not in present
        ]
        own = tuple(
            sorted(
                p
                for p in every
                if self._mount_type != "ssh"
                and p in present
                and p not in self._served
                and not (
                    present[p][1] == "fuse.sshfs"
                    and present[p][0].startswith(SSHFS_SOURCE_PREFIX)
                )
            )
        )
        self._own = {p: present[p] for p in own}
        self._owned = (self._owned & every) | set(own)
        if self._lost() is not None:
            return None
        wanted = sorted(p for p in visible if p not in own)
        covered = next(
            (
                p
                for p in sorted(self._served)
                if p in wanted
                and p in present
                and present[p] != (self._served[p][3], "fuse.sshfs")
                and (p not in ended or present[p][1] != "fuse.sshfs")
                and not (p in ended and present[p] == self._under.get(p))
            ),
            None,
        )
        if covered is not None:
            return (
                f"another mount covers {covered} in this machine; the line "
                "did not run"
            )
        for prefix in wanted:
            under = [o for o in own if o.startswith(prefix + "/")]
            if under:
                raise RuntimeError(
                    f"{self._provider}: the machine mounts {under[0]} itself, "
                    f"and serving {prefix} would cover it"
                )
        for prefix in [
            p for p in self._served if p not in wanted or p in ended
        ]:
            await self._drop(prefix, present)
        new = [p for p in wanted if p not in self._served]
        for prefix in new:
            if await self._held(prefix, present):
                return (
                    f"another sshfs serves {prefix} in this machine; give "
                    "this workspace a machine of its own"
                )
        if new:
            server = pipe_server()
            if (await self._run("command -v sshfs")).exit_code != 0:
                raise RuntimeError(f"{self._provider}: {SSHFS_HINT}")
            try:
                for prefix in new:
                    await self._serve(
                        server(files, session, self._lend),
                        prefix,
                        present,
                    )
            except BaseException:
                await self._unmount()
                raise
        if self._mount_type != "fuse" or set(top_prefixes(every)) <= set(own):
            self._seen = (frozenset(every), visible)
        return None

    def _ours(self, source: str) -> bool:
        """Whether ``source`` is an sshfs this instance served.

        Args:
            source (str): a mount's source.
        """
        return source.startswith(f"{self._name}-")

    def _lost(self) -> str | None:
        """A mount of the machine's own it held and no longer does; the
        prefixes held are kept only while the workspace mounts them."""
        return min(self._owned - self._own.keys(), default=None)

    async def _held(
        self, prefix: str, present: dict[str, tuple[str, str]]
    ) -> bool:
        """Whether another sshfs still serves ``prefix``.

        Args:
            prefix (str): the mountpoint.
            present (dict[str, tuple[str, str]]): the machine's mount table.
        """
        source, kind = present.get(prefix, ("", ""))
        if kind != "fuse.sshfs" or self._ours(source):
            return False
        found = await self._run(running_line(source))
        if found.exit_code not in (0, 1):
            raise RuntimeError(
                f"{self._provider}: cannot tell whether {source} is served: "
                f"{said(found.stderr)}"
            )
        return found.exit_code == 0

    async def _serve(
        self,
        server: Any,
        prefix: str,
        present: dict[str, tuple[str, str]],
    ) -> None:
        self._under[prefix] = present.get(prefix)
        if present.get(prefix, ("", ""))[1] == "fuse.sshfs":
            await self._run(unmount_line(prefix))
        path = single_quote(prefix)
        made = await self._run(
            f"mkdir -p {path} 2>/dev/null || {{ sudo -n mkdir -p {path} && "
            f'sudo -n chown "$(id -u):$(id -g)" {path}; }}'
        )
        if made.exit_code != 0:
            raise RuntimeError(
                f"{self._provider}: cannot make {prefix} in the machine: "
                f"{said(made.stderr)}"
            )
        log = single_quote(f"{SSHFS_LOG_PREFIX}_{uuid.uuid4().hex}.log")
        self._serves += 1
        source = f"{self._name}-{self._serves}:{prefix}"
        pipe = await self._open_pipe(
            f"exec sshfs -f -o {SSHFS_OPTIONS} {single_quote(source)} {path} "
            f"2>{log}"
        )
        task = asyncio.create_task(
            server.serve(pipe.reader, pipe.writer), context=Context()
        )
        self._served[prefix] = (pipe, task, server, source)
        task.add_done_callback(lambda done: self._ended(prefix, done))
        try:
            deadline = asyncio.get_running_loop().time() + MOUNT_WAIT_SECONDS
            while True:
                try:
                    row = (await self._table()).get(prefix)
                    if not task.done() and row == (source, "fuse.sshfs"):
                        return
                except Exception as error:
                    diagnostic = (
                        await pipe.diagnostic()
                        if pipe.diagnostic is not None
                        else ""
                    )
                    if diagnostic:
                        raise RuntimeError(
                            f"{self._provider}: sshfs did not mount {prefix}: "
                            f"{error}; helper said: {diagnostic}"
                        ) from error
                    raise
                if task.done() or asyncio.get_running_loop().time() > deadline:
                    failed = (
                        task.exception()
                        if task.done() and not task.cancelled()
                        else None
                    )
                    diagnostic = (
                        await pipe.diagnostic()
                        if pipe.diagnostic is not None
                        else ""
                    )
                    reason = diagnostic
                    try:
                        written = await self._run(f"cat {log}")
                        if log_text := said(written.stdout):
                            reason = log_text + (
                                f"; helper said: {diagnostic}"
                                if diagnostic
                                else ""
                            )
                    except Exception as error:
                        logger.debug(
                            "%s: reading the sshfs log failed",
                            self._provider,
                            exc_info=True,
                        )
                        if not reason:
                            reason = f"cannot read the sshfs log: {error}"
                    reason = reason or "no word from sshfs"
                    if failed is not None:
                        reason += f"; the SFTP server failed: {failed}"
                    raise RuntimeError(
                        f"{self._provider}: sshfs did not mount {prefix}: {reason}"
                    )
                await asyncio.sleep(MOUNT_POLL_SECONDS)
        finally:
            current = asyncio.current_task()
            if current is None or not current.cancelling():
                await self._drop_log(log)

    def _ended(self, prefix: str, task: asyncio.Task[None]) -> None:
        """Kill the sshfs of a prefix whose server ended, unless a line
        dropped it already: a program blocked on the mount then gets an
        error rather than hanging. The next line unmounts it and serves the
        prefix again, as for any server that ended; a kill that lands late
        reaches only this serve's sshfs, never the one serving the prefix
        again. A kill the machine does not answer is let go after
        ``UNMOUNT_WAIT_SECONDS``, or when the mounts close.

        Args:
            prefix (str): the served mountpoint.
            task (asyncio.Task[None]): the server that ended.
        """
        served = self._served.get(prefix)
        if served is None or served[1] is not task:
            return
        kill = asyncio.create_task(self._kill(prefix, served[3]))
        self._kills.add(kill)
        kill.add_done_callback(self._kills.discard)

    async def _kill(self, prefix: str, source: str) -> None:
        """Kill the sshfs serving ``source``, warning when it fails.

        Args:
            prefix (str): the served mountpoint, for the warning.
            source (str): the sshfs's source.
        """
        try:
            killed = await asyncio.wait_for(
                self._run(kill_line(source)), UNMOUNT_WAIT_SECONDS
            )
        except Exception:
            logger.warning(
                "%s: killing the sshfs for %s failed",
                self._provider,
                prefix,
                exc_info=True,
            )
            return
        if killed.exit_code != 0:
            logger.warning(
                "%s: killing the sshfs for %s failed: %s",
                self._provider,
                prefix,
                said(killed.stderr),
            )

    async def _drop_log(self, log: str) -> None:
        """Remove the helper's setup log; keeping it only costs a file.

        Args:
            log (str): the quoted log path in the machine.
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

    async def _table(self) -> dict[str, tuple[str, str]]:
        listed = await self._run("cat /proc/mounts")
        if listed.exit_code != 0:
            raise RuntimeError(
                f"{self._provider}: cannot read the machine's mount table: "
                f"{said(listed.stderr)}"
            )
        return mount_table(listed.stdout.decode(errors="replace"))

    async def _drop(
        self, prefix: str, present: dict[str, tuple[str, str]]
    ) -> None:
        """Unmount ``prefix`` if the mount on top is still this instance's,
        then end its SFTP server.

        Args:
            prefix (str): the served mountpoint.
            present (dict[str, tuple[str, str]]): the machine's mount table.
        """
        pipe, task, _, source = self._served.pop(prefix)
        self._under.pop(prefix, None)
        if present.get(prefix, ("", ""))[0] == source:
            try:
                done = await self._run(unmount_line(prefix))
                if done.exit_code != 0:
                    logger.warning(
                        "%s: unmounting %s in the machine failed: %s",
                        self._provider,
                        prefix,
                        said(done.stderr),
                    )
            except Exception:
                logger.warning(
                    "%s: unmounting %s in the machine failed",
                    self._provider,
                    prefix,
                    exc_info=True,
                )
        try:
            await pipe.stop()
            await asyncio.wait_for(task, UNMOUNT_WAIT_SECONDS)
        except Exception:
            logger.warning(
                "%s: ending the SFTP server for %s failed",
                self._provider,
                prefix,
                exc_info=True,
            )
            task.cancel()

    async def _unmount(self) -> None:
        present: dict[str, tuple[str, str]] = {}
        if self._served:
            try:
                present = await self._table()
            except Exception:
                logger.warning(
                    "%s: reading the mount table to unmount failed; "
                    "unmounting every served prefix",
                    self._provider,
                    exc_info=True,
                )
                present = {
                    p: (source, "fuse.sshfs")
                    for p, (_, _, _, source) in self._served.items()
                }
        for prefix in list(self._served):
            await self._drop(prefix, present)
        self._seen = None
