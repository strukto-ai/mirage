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
from collections.abc import (
    Awaitable,
    Callable,
    Coroutine,
    Iterable,
    Mapping,
    Sequence,
)
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
    APFS_UTIL,
    DARWIN_ADMIN_STATUS,
    DARWIN_MOUNT_GUARD,
    DARWIN_PATH,
    DARWIN_POINT_MARK,
    MACFUSE_KIND,
    MIRAGE_FUSE_FIND,
    MIRAGE_FUSE_HINT,
    MIRAGE_FUSE_LINE,
    MOUNT_GUARD,
    MOUNT_POLL_SECONDS,
    MOUNT_WAIT_SECONDS,
    PIPE_SERVER_HINT,
    SERVED_KINDS,
    SSHFS_HINT,
    SSHFS_LINE,
    SSHFS_LINKS_OPTION,
    SSHFS_OPTIONS,
    SSHFS_SOURCE_PREFIX,
    SYNTHETIC_CONF,
    UNMOUNT_WAIT_SECONDS,
    VIEW_KEYS,
    machine_dir_line,
    mount_field,
)
from mirage.machine.types import MachinePipe, MountType, Transport
from mirage.mount.changes import SERVED_BY
from mirage.mount.types import ServedPrefix
from mirage.rs.policy import rule_table
from mirage.runtime.binding import (
    WorkspaceBinding,
    refused_run,
    restricted_mounts_for,
)
from mirage.runtime.types import OutputFn, RunAnswer, RunResult
from mirage.shell.constants import CANNOT_EXECUTE_STATUS
from mirage.types import FileType, JsonValue
from mirage.utils.quote import single_quote
from mirage.workspace.files import Files, reader_of
from mirage.workspace.session import SessionState
from mirage.workspace.types import MountRow

logger = logging.getLogger(__name__)

T = TypeVar("T")


def pipe_server(transport: Transport) -> Any:
    """The file server class a transport's pipe runs, imported on the
    first machine mount so a process that never mounts into a machine does
    not load it, as the machine registry defers a provider: sshfs's SFTP
    server, or mirage-fuse's fsproto server.

    Args:
        transport (Transport): ssh or mirage.

    Raises:
        ImportError: sshfs's needs the `ssh` extra (asyncssh), not
            installed.
    """
    if transport == "mirage":
        return importlib.import_module("mirage.mount.fsproto").FsprotoServer
    try:
        return importlib.import_module("mirage.mount.sftp").PipeServer
    except ModuleNotFoundError as exc:
        if exc.name != "asyncssh":
            raise
        raise ImportError(PIPE_SERVER_HINT) from exc


def view_of(session: SessionState) -> tuple[JsonValue, ...]:
    """What a served machine shows ``session``: its record's ``VIEW_KEYS``.

    Each SSH login, port forward and reconnect is a session of its own, so
    a machine compares views, not sessions: one whose view matches the
    served session's runs there too.

    Args:
        session (SessionState): the session a line runs as.
    """
    record = session.to_dict(variables=False)
    return tuple(record.get(key) for key in VIEW_KEYS)


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


def darwin_table_line(prefixes: Sequence[str]) -> str:
    """The Mac line that prints ``mount``'s table, then each of
    ``prefixes`` behind ``DARWIN_POINT_MARK`` with the real path a mount
    on it shows at, as macOS resolves links (``/tmp`` to ``/private/tmp``).
    It reads each prefix's link and parent, never the prefix, so a stalled
    mount cannot hang it.

    Args:
        prefixes (Sequence[str]): the prefixes to resolve.
    """
    words = " ".join(single_quote(prefix) for prefix in prefixes)
    return (
        f"PATH={DARWIN_PATH}; mount || exit 1; for p in {words}; do q=$p; "
        '[ -L "$q" ] && { t=$(readlink -- "$q"); '
        "case $t in /*) q=$t;; *) q=${q%/*}/$t;; esac; }; "
        'd=$(cd -- "${q%/*}/" 2>/dev/null && pwd -P) || d=${q%/*}; '
        'printf \'\\036point %s\\t%s\\n\' "$p" "${d%/}/${q##*/}"; done'
    )


def darwin_mount_table(
    text: str, known: Mapping[str, str]
) -> tuple[dict[str, tuple[str, str]], dict[str, str]]:
    """``mount_table`` for what ``darwin_table_line`` printed: each
    prefix's source and type, by the real path it mounts at, and each
    prefix's real path, ``known`` among them. A row is matched by that
    path, as a source can hold `` on /``; the last row at a path wins.

    Args:
        text (str): the line's output.
        known (Mapping[str, str]): real paths resolved before, by prefix.
    """
    lines = text.split("\n")
    points = dict(known)
    for line in lines:
        if line.startswith(DARWIN_POINT_MARK):
            prefix, _, point = line[len(DARWIN_POINT_MARK) :].partition("\t")
            points[prefix] = point
    rows: dict[str, tuple[str, str]] = {}
    for prefix, point in points.items():
        marker = f" on {point} ("
        for line in lines:
            at = line.rfind(marker)
            if at >= 0 and not line.startswith(DARWIN_POINT_MARK):
                kind = line[at + len(marker) :].split(",")[0].rstrip(")")
                rows[prefix] = (line[:at], kind)
    return rows, points


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


def served_prefixes(
    prefixes: Iterable[str], local: Iterable[str] = ()
) -> list[str]:
    """The prefixes ssh serves a machine: its top prefixes but those it
    holds itself.

    A machine mount of the machine's own files at the path they have
    there (``/tmp``, ``"@<machine>"``) stays the machine's: serving it would
    cover the very files it shows. A mount under one is still served at
    its own path.

    Args:
        prefixes (Iterable[str]): the mount prefixes the session sees.
        local (Iterable[str]): the prefixes the machine holds itself.
    """
    own = {p.rstrip("/") for p in local}
    return top_prefixes(p for p in prefixes if p.rstrip("/") not in own)


def mount_paths(prefixes: Iterable[str]) -> set[str]:
    """The mountpoints a machine could hold of ``prefixes``.

    Args:
        prefixes (Iterable[str]): mount prefixes.
    """
    return {p.rstrip("/") for p in prefixes} - {"", "/dev"}


def escape_name(text: str) -> str:
    """``text`` with each byte of a character outside ``[A-Za-z0-9-]``
    written ``_xx``.

    Args:
        text (str): a workspace id or machine name.
    """
    return re.sub(
        r"[^A-Za-z0-9-]",
        lambda c: "".join(f"_{b:02x}" for b in c.group().encode()),
        text,
    )


def source_name(workspace_id: str, machine: str) -> str:
    """The name the sshfs sources of one machine entry of a workspace
    start with: ``mirage-<workspace id>.<machine>``, each escaped
    (``escape_name``) so no two pairs share a name, ``.`` never occurs
    inside either, and the name stays one word in ``/proc/mounts`` and a
    shell line.

    Args:
        workspace_id (str): the workspace's id.
        machine (str): the machine's name, its key under ``machines:``.
    """
    return (
        f"{SSHFS_SOURCE_PREFIX}{escape_name(workspace_id)}."
        f"{escape_name(machine)}"
    )


def unmount_line(prefix: str) -> str:
    """The machine command that lazily unmounts ``prefix``.

    Args:
        prefix (str): the mountpoint.
    """
    path = single_quote(prefix)
    return f"fusermount3 -uz {path} || fusermount -uz {path}"


def darwin_unmount_line(point: str) -> str:
    """``unmount_line`` on a Mac: forced, as macOS cannot detach a mount
    lazily, at the mount's real path.

    Args:
        point (str): the mount's real path.
    """
    path = single_quote(point)
    return f"umount -f {path} 2>/dev/null || diskutil unmount force {path}"


def darwin_mountpoint_line(prefix: str, root: str) -> str:
    """The Mac line that makes ``prefix`` a folder to mount on and prints
    its real path. A prefix whose top folder is missing from macOS's
    read-only root (``/data``) becomes a ``/etc/synthetic.conf`` link to
    the same name under ``root``, made with ``sudo -n``; without it the
    line exits ``DARWIN_ADMIN_STATUS``.

    Args:
        prefix (str): the workspace prefix.
        root (str): the folder the links lead into.
    """
    return (
        f"PATH={DARWIN_PATH}; p={single_quote(prefix)}; r={single_quote(root)}; "
        'if ! mkdir -p -- "$p" 2>/dev/null; then t=${p#/}; t=/${t%%/*}; '
        'if [ -e "$t" ] || [ -L "$t" ]; then mkdir -p -- "$p"; exit 1; fi; '
        'mkdir -p -- "$r$t" || exit 1; '
        f"sudo -n true 2>/dev/null || exit {DARWIN_ADMIN_STATUS}; "
        'e=$(printf \'%s\\t%s\' "${t#/}" "${r#/}$t"); '
        f'grep -qxF -- "$e" {SYNTHETIC_CONF} 2>/dev/null || '
        "{ printf '%s\\n' \"$e\" | "
        f"sudo -n tee -a {SYNTHETIC_CONF} >/dev/null; }} "
        f"|| exit {DARWIN_ADMIN_STATUS}; "
        f"sudo -n {APFS_UTIL} -t >/dev/null 2>&1; "
        f'[ -L "$t" ] || exit {DARWIN_ADMIN_STATUS}; '
        'mkdir -p -- "$p" || exit 1; fi; cd -- "$p" && pwd -P'
    )


def mirage_fuse_line(source: str, prefix: str, log: str) -> str:
    """The pipe command that mounts ``source`` at ``prefix`` with
    mirage-fuse, found in Mirage's folder on the machine or on its PATH
    (``MIRAGE_FUSE_FIND``), its errors in ``log``. Its stdin and stdout
    are the fsproto stream.

    Args:
        source (str): the mount's source.
        prefix (str): the mountpoint.
        log (str): the log's path in the machine.
    """
    return (
        f'{MIRAGE_FUSE_FIND}exec "$f" serve {single_quote(source)} '
        f"{single_quote(prefix)} 2>{single_quote(log)}"
    )


def sshfs_line(source: str, prefix: str, log: str) -> str:
    """The pipe command that mounts ``source`` at ``prefix`` with sshfs,
    its errors in ``log``. It passes SSHFS_LINKS_OPTION only when the
    machine's sshfs names it in its help, which reads no input, so the
    pipe's stream is sshfs's alone. Each file shows as the machine user's
    own, as on a disk that user mounted: the host's uid means nothing
    there, and git refuses a repository another user owns. The modes stay
    the workspace's.

    Args:
        source (str): the sshfs source.
        prefix (str): the mountpoint.
        log (str): the log's path in the machine.
    """
    return (
        f'o={SSHFS_OPTIONS}; case "$(sshfs -h 2>&1)" in '
        f'*{SSHFS_LINKS_OPTION}*) o="$o,{SSHFS_LINKS_OPTION}";; esac; '
        'u=$(id -u 2>/dev/null) && g=$(id -g 2>/dev/null) && o="$o,uid=$u,gid=$g"; '
        f'exec sshfs -f -o "$o" {single_quote(source)} {single_quote(prefix)} '
        f"2>{single_quote(log)}"
    )


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


def unconfirmed(provider: str, prefix: str) -> str:
    """Why a line did not run: the machine's file client did not confirm
    in time that it dropped what the workspace changed under ``prefix``.

    Args:
        provider (str): the machine's provider, for the message.
        prefix (str): the mountpoint.
    """
    return (
        f"{provider}: the machine did not confirm the workspace's changes "
        f"under {prefix} in time; the line did not run"
    )


def darwin_admin_hint(provider: str, prefix: str, root: str) -> str:
    """Why a Mac cannot have ``prefix`` yet, with the commands an
    administrator runs there once (``darwin_mountpoint_line``).

    Args:
        provider (str): the machine's provider, for the message.
        prefix (str): the workspace prefix.
        root (str): the folder the link leads into.
    """
    top = "/" + prefix.strip("/").split("/")[0]
    return (
        f"{provider}: {prefix} needs a folder {top}, and macOS keeps its root "
        "folder read-only; make it once as an administrator on the Mac, "
        "then run the line again: printf '%s\\t%s\\n' "
        f"{single_quote(top[1:])} {single_quote(root[1:] + top)} "
        f"| sudo tee -a {SYNTHETIC_CONF} && sudo {APFS_UTIL} -t"
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


def darwin_running_line(source: str) -> str:
    """``running_line`` on a Mac, which has no ``/proc``: it reads ``ps``
    and finds ``source`` as one of a program's space-separated words.

    Args:
        source (str): the mount's source.
    """
    return (
        "ps -axww -o pid=,command= 2>/dev/null | "
        f"S={single_quote(source)} awk "
        '\'BEGIN { s = " " ENVIRON["S"] " " } { n++ } '
        'index(" " $0 " ", s) { f = 1 } END { exit f ? 0 : n ? 1 : 2 }\''
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


def darwin_kill_line(source: str) -> str:
    """``kill_line`` on a Mac, finding programs as
    ``darwin_running_line`` does.

    Args:
        source (str): the mount's source.
    """
    return (
        "for p in $(ps -axww -o pid=,command= 2>/dev/null | "
        f"S={single_quote(source)} awk "
        '\'BEGIN { s = " " ENVIRON["S"] " " } '
        'index(" " $0 " ", s) { print $1 }\'); '
        'do kill -KILL "$p" 2>/dev/null; done; :'
    )


def mirage_source(source: str, prefix: str) -> bool:
    """Whether ``source``, mounted at ``prefix``, has the shape every
    workspace gives the mounts it serves, ``<name>-<instance>-<n>:<prefix>``,
    so a Mac's macFUSE mount, whose type names no program, can be told for
    one of Mirage's.

    Args:
        source (str): a mount's source.
        prefix (str): its mountpoint.
    """
    head = source.removesuffix(f":{prefix}")
    return head != source and bool(re.search(r".-[0-9a-f]{8}-[0-9]+\Z", head))


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

    Each sshfs source names the workspace and machine entry serving it, the
    instance and the serve
    (``mirage-<workspace id>.<machine>-<instance>-<n>:<prefix>``,
    ``source_name``), so an instance unmounts only its own, and kills only
    the sshfs of a server that ended, never one a later instance serves:
    a prefix another sshfs still serves,
    as another workspace, or another machine entry on the same machine,
    does, refuses the line (1) rather than being taken, and one whose sshfs
    has gone is unmounted and served. A prefix whose sshfs carries this
    entry's own name but which this instance does not serve was left by
    an instance before a restart: its sshfs is killed, the prefix
    unmounted and served again. Workspace ids must therefore be unique
    among live workspaces, and stable across a restart for it to take its
    mounts back. A workspace with no id names its sources at random. The
    session that owns the machine is held in memory, so after a restart
    the first session to run a line owns it again.

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
        machine (str): the machine's name, its key under ``machines:``.
        mount_type (MountType): ssh, mirage, own or both.
        run (Callable[[str], Awaitable[RunAnswer]]): runs one setup
            command in the machine, its answer kept whole.
        open_pipe (Callable[[str], Awaitable[MachinePipe]]): starts a
            command in the machine with its stdin and stdout held open.
        working (Callable[[], bool] | None): whether Mirage has work on
            the machine now; None counts it as always working.
    """

    def __init__(
        self,
        provider: str,
        machine: str,
        mount_type: MountType,
        run: Callable[[str], Awaitable[RunAnswer]],
        open_pipe: Callable[[str], Awaitable[MachinePipe]],
        working: Callable[[], bool] | None = None,
    ) -> None:
        self._provider = provider
        self._working = working
        self._machine = machine
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
        # When each served sshfs source's mount began keeping answers, so
        # a change made before it is not waited out.
        self._since: dict[str, float] = {}
        self._seen: tuple[frozenset[str], frozenset[str]] | None = None
        # The machine's own mounts as last read, and each prefix held since.
        self._own: dict[str, tuple[str, str]] = {}
        self._owned: set[str] = set()
        # What each served prefix was laid over, shown again once its server ends.
        self._under: dict[str, tuple[str, str] | None] = {}
        self._lock = asyncio.Lock()
        # Each kill of the sshfs of a server that ended, until it has run.
        self._kills: set[asyncio.Task[None]] = set()
        self._random = f"{SSHFS_SOURCE_PREFIX}{uuid.uuid4().hex}"
        self._name = self._random
        # The prefixes served so far, numbering each sshfs's source, and
        # each source started. The instance's own token in each, so a kill
        # an earlier instance left running reaches none of this one's.
        self._instance = uuid.uuid4().hex[:8]
        self._serves = 0
        self._sources: set[str] = set()
        # Whether each top prefix is a directory, read once per mount: keyed
        # by the mount's row, which the registry builds anew whenever its
        # mounts change.
        self._directories: dict[str, tuple[MountRow | None, bool]] = {}
        # Whether the machine is a Mac, asked once; there each prefix the
        # table is read for, and the real path each mounts at.
        self._darwin: bool | None = None
        self._looked: set[str] = set()
        self._points: dict[str, str] = {}

    @property
    def file_effects_dispatched(self) -> bool:
        """ssh and mirage serve every workspace prefix through the host's
        gate."""
        return self._serves_all

    @property
    def _transport(self) -> Transport:
        """How the host serves its prefixes: sshfs under ``ssh``,
        mirage-fuse otherwise."""
        return "ssh" if self._mount_type == "ssh" else "mirage"

    @property
    def _kind(self) -> str:
        """The type the machine's mount table gives a prefix the host
        serves: macFUSE's on a Mac."""
        if self._darwin:
            return MACFUSE_KIND
        return "fuse.sshfs" if self._transport == "ssh" else "fuse.mirage"

    @property
    def _program(self) -> str:
        """The program that mounts a prefix the host serves."""
        return "sshfs" if self._transport == "ssh" else "mirage-fuse"

    @property
    def _serves_all(self) -> bool:
        """Whether the host serves every prefix, none the machine's own."""
        return self._mount_type in ("ssh", "mirage")

    async def validate(
        self, binding: WorkspaceBinding | None, cwd: str, errors: OutputFn
    ) -> RunResult | None:
        """Record the line for ``sync``, bring the mounts in step, then
        refuse a line that may not run: one from a cwd other than ``/``
        that ssh serves no mount for (126), one the session's
        restrictions reach past the dispatcher, as a policy refuses it
        (126), one the machine cannot serve because another session or
        another sshfs holds it, or another mount covers it (1), and one
        over a mount of the machine's own that is gone (126). A line that
        may run first waits out what the machine's kernel may still hold
        of a change another made under what it is served.

        Args:
            binding (WorkspaceBinding | None): the runtime's workspace.
            cwd (str): the line's working directory.
            errors (OutputFn): where a refusal says why.

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
        begun = binding.changes.now() if binding.changes is not None else 0.0
        seen = cwd.rstrip("/")
        local = binding.machine_prefixes(self._machine)
        if (
            self._serves_all
            and seen
            and not any(
                seen == p.rstrip("/") or seen.startswith(p.rstrip("/") + "/")
                for p in [
                    *served_prefixes(binding.mount_prefixes(), local),
                    *local,
                ]
            )
        ):
            await errors(
                (
                    f"{self._provider}: the machine cannot see the working "
                    f"directory {seen}; cd into a mount first\n"
                ).encode()
            )
            return RunResult(exit_code=CANNOT_EXECUTE_STATUS)
        current = get_current_session()
        if current is None:
            raise RuntimeError(
                f"{self._provider}: mount_type serves a session's view, "
                "and this line runs as none"
            )
        rules = current.commands
        if rules is not None and any(
            rule.paths or rule.mount for rule in rule_table(rules)
        ):
            return await refused_run(
                self._provider,
                "this file transport cannot enforce program-specific path "
                "rules",
                errors,
            )
        async with self._lock:
            ws_id = binding.processes.workspace_id if binding.processes else ""
            if not self._served:
                self._name = (
                    source_name(ws_id, self._machine)
                    if ws_id
                    else self._random
                )
            served = self._session
            session = binding.get_session(current.session_id)
            if (
                served is not None
                and served is not session
                and view_of(served) != view_of(session)
            ):
                earlier = (
                    "an earlier "
                    if served.session_id == current.session_id
                    else ""
                )
                await errors(
                    (
                        f"{self._provider}: this machine shows {earlier}"
                        f"session {served.session_id}'s view of the "
                        f"workspace; give session {current.session_id} a "
                        "machine of its own\n"
                    ).encode()
                )
                return RunResult(exit_code=1)
            every = mount_paths(binding.mount_prefixes()) - {
                p.rstrip("/") for p in local
            }
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
                await errors(f"{self._provider}: {refused}\n".encode())
                return RunResult(exit_code=1)
            lost = self._lost()
            if lost is not None:
                await errors(f"{unmounted(self._provider, lost)}\n".encode())
                return RunResult(exit_code=CANNOT_EXECUTE_STATUS)
            unserved = self._unserved(ruled)
            if self._mount_type != "own" and (not unserved or self._served):
                self._session = session
        if unserved:
            return await refused_run(
                self._provider,
                "a mount this session restricts is not served through the "
                "dispatcher",
                errors,
            )
        if self._served and binding.changes is not None:
            if self._transport == "mirage":
                prefixes = [
                    prefix
                    for prefix, (_, _, server, _) in self._served.items()
                    if hasattr(server, "begin")
                ]
                confirmed = await asyncio.gather(
                    *(self._served[prefix][2].begin() for prefix in prefixes)
                )
                late = next(
                    (p for p, ok in zip(prefixes, confirmed) if not ok), None
                )
                if late is not None:
                    await errors(
                        f"{unconfirmed(self._provider, late)}\n".encode()
                    )
                    return RunResult(exit_code=CANNOT_EXECUTE_STATUS)
                return None
            self._since = {
                source: self._since.get(source, begun)
                for _, _, _, source in self._served.values()
            }
            await binding.changes.wait_out(
                {
                    prefix: self._since[source]
                    for prefix, (_, _, _, source) in self._served.items()
                },
                self._machine,
            )
        return None

    def guarded(
        self,
        argv: tuple[str, ...],
        missing: tuple[str, str, str] = ("", "command not found", ""),
    ) -> tuple[str, ...]:
        """``argv`` under ``MOUNT_GUARD``, holding every mount the machine
        had at the line's ``validate``; unchanged when it had none.

        Args:
            argv (tuple[str, ...]): the program and its arguments.
            missing (tuple[str, str, str]): the words a program the
                machine cannot run is reported in (``PROGRAM_CHECK``).
        """
        held = {
            p: (source, self._kind)
            for p, (_, _, _, source) in self._served.items()
        } | self._own
        if not held:
            return argv
        if self._darwin:
            marks: list[str] = []
            for prefix, (source, kind) in sorted(held.items()):
                marks += [
                    self._points.get(prefix, prefix),
                    source,
                    kind,
                    unmounted(self._provider, prefix),
                ]
            return (
                "/bin/sh",
                "-c",
                DARWIN_MOUNT_GUARD,
                "sh",
                *missing,
                "mount",
                *marks,
                "--",
                *argv,
            )
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
            *missing,
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
                context.run(SERVED_BY.set, self._machine)
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

    async def _mountable(self, files: Files, prefixes: list[str]) -> list[str]:
        """Those of ``prefixes`` sshfs can mount: directories.

        A file mounted at a path of its own, such as a ``VFS.md``, stays
        off the machine.

        Args:
            files (Files): the session's files, to stat each prefix.
            prefixes (list[str]): the top prefixes the session sees.

        Returns:
            list[str]: the directories among them, in order.
        """
        for prefix in list(self._directories):
            if prefix not in prefixes:
                del self._directories[prefix]
        reader = reader_of(files)
        out: list[str] = []
        for prefix in prefixes:
            row = reader.owner(prefix)
            known = self._directories.get(prefix)
            if known is None or known[0] is not row:
                known = (row, await self._is_directory(files, prefix))
                self._directories[prefix] = known
            if known[1]:
                out.append(prefix)
        return out

    async def _is_directory(self, files: Files, prefix: str) -> bool:
        """Whether ``prefix`` is a directory.

        A stat that fails, such as a disk mount whose folder is gone,
        counts as one: the prefix is served as before, and the machine's
        own mount or the serve answers for it.

        Args:
            files (Files): the session's files.
            prefix (str): a top prefix the session sees.

        Returns:
            bool: whether to serve it.
        """
        try:
            return (await files.stat(prefix)).type == FileType.DIRECTORY
        except Exception as exc:
            logger.debug(
                "%s: could not stat %s: %s", self._provider, prefix, exc
            )
            return True

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
        local = [
            p.rstrip("/") for p in binding.machine_prefixes(self._machine)
        ]
        served = served_prefixes(binding.resolver.prefixes(), local)
        visible = frozenset(
            await self._mountable(files, served)
            if self._mount_type != "own"
            else ()
        )
        ended = [
            p for p, (_, task, _, _) in self._served.items() if task.done()
        ]
        if (
            self._seen == (frozenset(every), visible)
            and not ended
            and (self._serves_all or not ruled)
        ):
            return None
        self._seen = None
        self._looked |= set(every) | set(served) | set(self._served)
        present = await self._table()
        ended += [
            p for p in self._served if p not in ended and p not in present
        ]
        own = tuple(
            sorted(
                p
                for p in every
                if not self._serves_all
                and p in present
                and p not in self._served
                and not (
                    present[p][1] in SERVED_KINDS
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
                and present[p] != (self._served[p][3], self._kind)
                and (p not in ended or present[p][1] != self._kind)
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
            under = [o for o in (*own, *local) if o.startswith(prefix + "/")]
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
                    f"another {SERVED_KINDS[present[prefix][1]]} serves {prefix} "
                    "in this machine; give "
                    "this workspace a machine of its own"
                )
        if new:
            ssh = self._transport == "ssh"
            if ssh and self._darwin:
                raise RuntimeError(
                    f"{self._provider}: mount_type ssh needs a Linux machine; "
                    "a Mac takes mount_type mirage"
                )
            server = pipe_server(self._transport)
            line = SSHFS_LINE if ssh else MIRAGE_FUSE_LINE
            if (await self._run(line)).exit_code != 0:
                hint = SSHFS_HINT if ssh else MIRAGE_FUSE_HINT
                raise RuntimeError(f"{self._provider}: {hint}")
            folder = await self._folder(served)
            try:
                for prefix in new:
                    await self._serve(
                        server(files, session, self._lend)
                        if ssh
                        else server(
                            files,
                            session,
                            self._lend,
                            ServedPrefix(
                                prefix,
                                self._machine,
                                binding.changes,
                                binding.watched,
                            ),
                        ),
                        prefix,
                        present,
                        folder,
                    )
            except BaseException:
                await self._unmount()
                raise
        if self._mount_type != "own" or set(top_prefixes(every)) <= set(own):
            self._seen = (frozenset(every), visible)
        return None

    def _ours(self, source: str, prefix: str) -> bool:
        """Whether ``source``, mounted at ``prefix``, is an sshfs this
        workspace served: exactly ``<name>-<instance>-<n>:<prefix>``.

        Args:
            source (str): a mount's source.
            prefix (str): its mountpoint.
        """
        serve = source[len(self._name) + 1 : len(source) - len(prefix) - 1]
        return (
            bool(re.fullmatch("[0-9a-f]{8}-[0-9]+", serve))
            and source == f"{self._name}-{serve}:{prefix}"
        )

    def _lost(self) -> str | None:
        """A mount of the machine's own it held and no longer does; the
        prefixes held are kept only while the workspace mounts them."""
        return min(self._owned - self._own.keys(), default=None)

    async def _held(
        self, prefix: str, present: dict[str, tuple[str, str]]
    ) -> bool:
        """Whether another workspace's sshfs or mirage-fuse still serves
        ``prefix``. A Mac's macFUSE mount no workspace made is taken as
        served, as no program can be told for its server.

        Args:
            prefix (str): the mountpoint.
            present (dict[str, tuple[str, str]]): the machine's mount table.
        """
        source, kind = present.get(prefix, ("", ""))
        if kind not in SERVED_KINDS or self._ours(source, prefix):
            return False
        if kind == MACFUSE_KIND and not mirage_source(source, prefix):
            return True
        found = await self._run(
            darwin_running_line(source)
            if self._darwin
            else running_line(source)
        )
        if found.exit_code not in (0, 1):
            raise RuntimeError(
                f"{self._provider}: cannot tell whether {source} is served: "
                f"{said(found.stderr)}"
            )
        return found.exit_code == 0

    async def _folder(self, prefixes: Sequence[str]) -> str:
        """Mirage's folder on the machine (``machine_dir_line``), where
        each sshfs keeps its log: resolved once, so every look at a log
        finds the one sshfs wrote.

        Args:
            prefixes (Sequence[str]): the workspace prefixes the machine
                has at the same paths.
        """
        found = await self._run(machine_dir_line(prefixes) + 'printf %s "$d"')
        folder = said(found.stdout)
        if found.exit_code != 0 or not folder:
            raise RuntimeError(f"{self._provider}: {said(found.stderr)}")
        return folder

    async def _serve(
        self,
        server: Any,
        prefix: str,
        present: dict[str, tuple[str, str]],
        folder: str,
    ) -> None:
        self._under[prefix] = present.get(prefix)
        old, kind = present.get(prefix, ("", ""))
        if (
            kind in SERVED_KINDS
            and self._ours(old, prefix)
            and old not in self._sources
        ):
            await self._reclaim(old, prefix)
        elif kind in SERVED_KINDS:
            await self._run(self._unmount_line(prefix))
        point = await self._mountpoint(prefix, folder)
        log_path = f"{folder}/{self._program}-{uuid.uuid4().hex}.log"
        log = single_quote(log_path)
        self._serves += 1
        source = f"{self._name}-{self._instance}-{self._serves}:{prefix}"
        self._sources.add(source)
        pipe = await self._open_pipe(
            sshfs_line(source, point, log_path)
            if self._transport == "ssh"
            else mirage_fuse_line(source, point, log_path)
        )
        context = Context()
        context.run(SERVED_BY.set, self._machine)
        task = asyncio.create_task(
            server.serve(pipe.reader, pipe.writer), context=context
        )
        self._served[prefix] = (pipe, task, server, source)
        task.add_done_callback(lambda done: self._ended(prefix, done))
        try:
            deadline = asyncio.get_running_loop().time() + MOUNT_WAIT_SECONDS
            while True:
                try:
                    row = (await self._table()).get(prefix)
                    if not task.done() and row == (source, self._kind):
                        return
                except Exception as error:
                    diagnostic = (
                        await pipe.diagnostic()
                        if pipe.diagnostic is not None
                        else ""
                    )
                    if diagnostic:
                        raise RuntimeError(
                            f"{self._provider}: {self._program} did not mount "
                            f"{prefix}: {error}; helper said: {diagnostic}"
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
                            "%s: reading the %s log failed",
                            self._provider,
                            self._program,
                            exc_info=True,
                        )
                        if not reason:
                            reason = (
                                f"cannot read the {self._program} log: {error}"
                            )
                    reason = reason or f"no word from {self._program}"
                    if failed is not None:
                        reason += f"; the file server failed: {failed}"
                    raise RuntimeError(
                        f"{self._provider}: {self._program} did not mount "
                        f"{prefix}: {reason}"
                    )
                await asyncio.sleep(MOUNT_POLL_SECONDS)
        finally:
            current = asyncio.current_task()
            if current is None or not current.cancelling():
                await self._drop_log(log)

    def _ended(self, prefix: str, task: asyncio.Task[None]) -> None:
        """Kill the sshfs of a prefix whose server ended, unless a line
        dropped it already: a program blocked on the mount then gets an
        error rather than hanging. With no work on the machine no program
        of Mirage's is blocked, and the server most likely ended as the
        machine paused itself, so the sshfs is left for the next line. The
        next line unmounts it and serves the prefix again, as for any
        server that ended; a kill that lands late,
        even after a restart, reaches only this serve's sshfs, never the one
        serving the prefix again. A kill the machine does not answer is let go after
        ``UNMOUNT_WAIT_SECONDS``, or when the mounts close.

        Args:
            prefix (str): the served mountpoint.
            task (asyncio.Task[None]): the server that ended.
        """
        served = self._served.get(prefix)
        if served is None or served[1] is not task:
            return
        if self._working is not None and not self._working():
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
                self._run(self._kill_line(source)), UNMOUNT_WAIT_SECONDS
            )
        except Exception:
            logger.warning(
                "%s: killing the %s for %s failed",
                self._provider,
                self._program,
                prefix,
                exc_info=True,
            )
            return
        if killed.exit_code != 0:
            logger.warning(
                "%s: killing the %s for %s failed: %s",
                self._provider,
                self._program,
                prefix,
                said(killed.stderr),
            )

    async def _reclaim(self, source: str, prefix: str) -> None:
        """Kill the sshfs an earlier instance of this workspace left serving
        ``prefix``, then unmount it: unmounted alone, it stays blocked on
        its dead pipe. The next serve may take the same source, so a failed
        unmount fails loud rather than leaving the old mount to pass for
        the new one.

        Args:
            source (str): the stale mount's source.
            prefix (str): its mountpoint.
        """
        await self._run(self._kill_line(source))
        done = await self._run(self._unmount_line(prefix))
        if done.exit_code != 0:
            raise RuntimeError(
                f"{self._provider}: cannot unmount {prefix}, which this "
                f"workspace served before a restart: {said(done.stderr)}"
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

    async def _mountpoint(self, prefix: str, folder: str) -> str:
        """Make ``prefix`` a folder the machine can mount on and return
        where its mount shows: ``prefix`` itself, or on a Mac its real
        path (``darwin_mountpoint_line``), a link into Mirage's folder
        for a prefix in macOS's read-only root.

        Args:
            prefix (str): the prefix to serve.
            folder (str): Mirage's folder on the machine.
        """
        if self._darwin:
            root = f"{folder}/mnt"
            made = await self._run(darwin_mountpoint_line(prefix, root))
            if made.exit_code == DARWIN_ADMIN_STATUS:
                raise RuntimeError(
                    darwin_admin_hint(self._provider, prefix, root)
                )
            out = made.stdout.decode(errors="replace").removesuffix("\n")
            point = out.rpartition("\n")[2]
            if made.exit_code != 0 or not point:
                raise RuntimeError(
                    f"{self._provider}: cannot make {prefix} in the machine: "
                    f"{said(made.stderr)}"
                )
            self._points[prefix] = point
            return point
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
        return prefix

    def _unmount_line(self, prefix: str) -> str:
        """The command that unmounts ``prefix``, at its real path on a
        Mac.

        Args:
            prefix (str): the mountpoint.
        """
        if self._darwin:
            return darwin_unmount_line(self._points.get(prefix, prefix))
        return unmount_line(prefix)

    def _kill_line(self, source: str) -> str:
        """The command that kills what serves ``source``.

        Args:
            source (str): the mount's source.
        """
        return darwin_kill_line(source) if self._darwin else kill_line(source)

    async def _table(self) -> dict[str, tuple[str, str]]:
        if self._darwin is None:
            asked = await self._run("uname -s")
            if asked.exit_code != 0:
                raise RuntimeError(
                    f"{self._provider}: cannot ask the machine its system: "
                    f"{said(asked.stderr)}"
                )
            self._darwin = said(asked.stdout) == "Darwin"
        if self._darwin:
            listed = await self._run(
                darwin_table_line(sorted(self._looked - self._points.keys()))
            )
            if listed.exit_code != 0:
                raise RuntimeError(
                    f"{self._provider}: cannot read the machine's mount "
                    f"table: {said(listed.stderr)}"
                )
            rows, points = darwin_mount_table(
                listed.stdout.decode(errors="replace"), self._points
            )
            self._points.update(points)
            return rows
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
                done = await self._run(self._unmount_line(prefix))
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
                "%s: ending the file server for %s failed",
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
                    p: (source, self._kind)
                    for p, (_, _, _, source) in self._served.items()
                }
        for prefix in list(self._served):
            await self._drop(prefix, present)
        self._seen = None
