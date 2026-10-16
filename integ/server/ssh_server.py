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

import argparse
import asyncio
import functools
import hashlib
import logging
import os
import posixpath
import shlex
import shutil
import stat
import tempfile
from collections.abc import AsyncIterator, Iterator

import asyncssh

# The interface the fake listens on. Loopback is right on a developer's
# machine and wrong inside a container: a server on the container's own
# 127.0.0.1 is invisible to the published port, so a client on the host has
# its connection accepted and then closed with no response -- while a
# healthcheck running inside the container sees a healthy server. Set
# MIRAGE_BIND_HOST=0.0.0.0 wherever the client is outside the container.
#
# The advertised URLs below stay on 127.0.0.1 on purpose: 0.0.0.0 is an
# interface to listen on, not an address anything can connect to.
logger = logging.getLogger(__name__)

BIND_HOST = os.environ.get("MIRAGE_BIND_HOST", "127.0.0.1")

# A directory the server's own access check refuses to list, the way
# OpenSSH answers a non-root user opening a root-owned 0700 directory:
# stat and writes by path still work, the listing is
# SSH_FX_PERMISSION_DENIED. mirage's chmod keeps owner access on purpose,
# so the battery cannot make one through the shell.
UNLISTABLE = b"unlistable"

FIND = ["env", "LC_ALL=C", "find", "-L"]
TREE_FORMAT = "%y %m %s %T@ %A@ %U %G %P\\0"
WC = ["env", "LC_ALL=C", "wc", "-l", "<"]
CP = ["env", "LC_ALL=C", "cp", "-RL", "--"]
COPIED = ["&&", "echo", "copied"]
SUMS = {
    "md5sum": "md5",
    "sha1sum": "sha1",
    "sha256sum": "sha256",
    "sha384sum": "sha384",
    "sha512sum": "sha512",
}
# How often the follow looks at its file again for what it gained.
FOLLOW_POLL = 0.05


def follow_shape(target: str, count: str) -> list[str]:
    """The follow command an ssh mount sends for ``tail -f``, split as the
    shell splits it: the shell opens the file, says so with an empty
    line, and tail follows the descriptor it opened.

    Args:
        target (str): The file, as the client named it.
        count (str): The ``-n`` count, as the client wrote it.
    """
    return [
        "test",
        "-f",
        target,
        "&&",
        "exec",
        "3<",
        target,
        "&&",
        "command",
        "-v",
        "tail",
        ">/dev/null",
        "&&",
        "echo",
        "&&",
        "exec",
        "tail",
        "-n",
        count,
        "-f",
        "<&3",
        "3<&-",
    ]


FIND_KINDS = (
    (stat.S_ISDIR, "d"),
    (stat.S_ISREG, "f"),
    (stat.S_ISFIFO, "p"),
    (stat.S_ISSOCK, "s"),
    (stat.S_ISCHR, "c"),
    (stat.S_ISBLK, "b"),
)

# The one command the server answers: the remote grep an ssh mount's
# search sends, `SEARCH [-i] -e TEXT -- SCOPE...`. A server that asks for no
# password runs nothing, so it answers this one itself, reading only inside
# the served root.
SEARCH = [
    "env",
    "LC_ALL=C",
    "grep",
    "--dereference-recursive",
    "--devices=skip",
    "-lF",
    "--null",
]


class NoAuthServer(asyncssh.SSHServer):
    def begin_auth(self, username: str) -> bool:
        return False


class ChrootSFTPServer(asyncssh.SFTPServer):
    def __init__(self, root: str, chan: asyncssh.SSHServerChannel) -> None:
        super().__init__(chan, chroot=root)

    async def scandir(self, path: bytes) -> AsyncIterator[asyncssh.SFTPName]:
        if posixpath.basename(path.rstrip(b"/")) == UNLISTABLE:
            raise asyncssh.SFTPPermissionDenied("Permission denied")
        async for name in super().scandir(path):
            yield name


def _inside(root: str, path: str) -> bool:
    real = os.path.realpath(path)
    return real == root or real.startswith(root + os.sep)


def _files(
    root: str, directory: str, ancestors: frozenset[str]
) -> Iterator[str | None]:
    """The regular files below ``directory`` inside ``root``, links
    followed, under every name the tree gives them; None where a link
    leads back into a directory being walked, which GNU grep reports as a
    recursive directory loop.

    Args:
        root (str): Local directory served as the SFTP root.
        directory (str): The directory walked.
        ancestors (frozenset[str]): The real paths of the directories
            above it.
    """
    real = os.path.realpath(directory)
    if real in ancestors:
        yield None
        return
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if not _inside(root, path):
            continue
        if os.path.isdir(path):
            yield from _files(root, path, ancestors | {real})
        elif os.path.isfile(path):
            yield path


def search_names(
    root: str, text: bytes, fold: bool, scopes: list[str]
) -> tuple[int, bytes, bytes]:
    """What the search's grep answers over ``scopes`` under the chroot the
    SFTP server applies: the regular files holding ``text`` (ASCII case
    folded under ``fold``), links followed, NUL-ended, with grep's exit
    status. Nothing outside ``root`` is read, through a link or not, and
    a loop or an unreadable file exits 2, as grep does.

    Args:
        root (str): Local directory served as the SFTP root.
        text (bytes): The text searched for.
        fold (bool): Whether -i was given.
        scopes (list[str]): The directories, as the client named them.
    """
    root = os.path.realpath(root)
    needle = text.lower() if fold else text
    names: list[str] = []
    status = 1
    for scope in scopes:
        base = os.path.join(root, scope.lstrip("/"))
        if not _inside(root, base) or not os.path.isdir(base):
            return (
                2,
                b"",
                f"grep: {scope}: No such file or directory\n".encode(),
            )
        for path in _files(root, base, frozenset()):
            if path is None:
                status = 2
                continue
            try:
                with open(path, "rb") as handle:
                    data = handle.read()
            except OSError as exc:
                logger.debug(
                    "ssh fake search could not read %s: %s", path, exc
                )
                status = 2
                continue
            if needle in (data.lower() if fold else data):
                names.append(scope.rstrip("/") + path[len(base) :])
    if names and status != 2:
        status = 0
    return status, b"".join(n.encode() + b"\0" for n in names), b""


def _find_kind(info: os.stat_result | None) -> str:
    if info is None:
        return "l"
    for test, kind in FIND_KINDS:
        if test(info.st_mode):
            return kind
    return "U"


def tree_records(root: str, scope: str) -> tuple[int, bytes, bytes]:
    """What GNU ``find -L SCOPE -printf TREE_FORMAT`` answers under the
    chroot the SFTP server applies: one NUL-ended record per entry, the
    scope first, links followed and a broken one typed ``l``. A link loop
    or a directory the SFTP server will not list exits 1 with find's
    message, as find does. Nothing outside ``root`` is listed or
    described, through a link or not: such an entry exits 1 as one find
    could not read.

    Args:
        root (str): Local directory served as the SFTP root.
        scope (str): The directory, as the client named it.
    """
    root = os.path.realpath(root)
    base = os.path.join(root, scope.lstrip("/"))
    if not _inside(root, base) or not os.path.lexists(base):
        return 1, b"", f"find: '{scope}': No such file or directory\n".encode()
    records: list[bytes] = []
    errors: list[str] = []

    def visit(path: str, rel: str, ancestors: frozenset[str]) -> None:
        named = scope.rstrip("/") + (f"/{rel}" if rel else "")
        if not _inside(root, path):
            errors.append(f"find: '{named}': Permission denied\n")
            return
        try:
            info = os.stat(path)
        except OSError as exc:
            logger.debug("ssh fake tree could not stat %s: %s", path, exc)
            info = None
        kind = _find_kind(info)
        shown = info or os.lstat(path)
        fields = [
            kind,
            format(stat.S_IMODE(shown.st_mode), "o"),
            str(shown.st_size),
            f"{shown.st_mtime:.10f}",
            f"{shown.st_atime:.10f}",
            str(shown.st_uid),
            str(shown.st_gid),
            rel,
        ]
        records.append(" ".join(fields).encode() + b"\0")
        if kind != "d":
            return
        real = os.path.realpath(path)
        if real in ancestors:
            errors.append(f"find: File system loop detected; '{named}'\n")
            return
        if os.path.basename(path).encode() == UNLISTABLE:
            errors.append(f"find: '{named}': Permission denied\n")
            return
        for name in sorted(os.listdir(path)):
            child = f"{rel}/{name}" if rel else name
            visit(os.path.join(path, name), child, ancestors | {real})

    visit(base, "", frozenset())
    return (1 if errors else 0), b"".join(records), "".join(errors).encode()


def line_total(root: str, target: str) -> tuple[int, bytes, bytes]:
    """What ``wc -l < TARGET`` answers under the chroot: a regular file's
    newline count, or wc's or the shell's complaint. Nothing outside
    ``root`` is read, through a link or not.

    Args:
        root (str): Local directory served as the SFTP root.
        target (str): The file, as the client named it.
    """
    root = os.path.realpath(root)
    path = os.path.join(root, target.lstrip("/"))
    if not _inside(root, path):
        return 1, b"", f"sh: {target}: No such file or directory\n".encode()
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except IsADirectoryError:
        return 1, b"", b"wc: 'standard input': Is a directory\n"
    except OSError as exc:
        return 1, b"", f"sh: {target}: {exc.strerror}\n".encode()
    return 0, b"%d\n" % data.count(b"\n"), b""


def file_digest(root: str, tool: str, target: str) -> tuple[int, bytes, bytes]:
    """What ``TOOL < TARGET`` answers under the chroot for one of the
    coreutils sums: a regular file's digest of standard input, or the
    tool's or the shell's complaint. Nothing outside ``root`` is read.

    Args:
        root (str): Local directory served as the SFTP root.
        tool (str): The sum, ``sha256sum`` and its siblings.
        target (str): The file, as the client named it.
    """
    root = os.path.realpath(root)
    path = os.path.join(root, target.lstrip("/"))
    if not _inside(root, path):
        return 1, b"", f"sh: {target}: No such file or directory\n".encode()
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except IsADirectoryError:
        return 1, b"", f"{tool}: -: Is a directory\n".encode()
    except OSError as exc:
        return 1, b"", f"sh: {target}: {exc.strerror}\n".encode()
    digest = hashlib.new(SUMS[tool], data).hexdigest()
    return 0, f"{digest}  -\n".encode(), b""


def last_lines(data: bytes, count: int) -> bytes:
    """The last ``count`` lines of ``data`` as ``tail -n`` prints them, a
    last line with no newline counted as one.

    Args:
        data (bytes): The file's bytes.
        count (int): How many lines.
    """
    if count <= 0:
        return b""
    cut = len(data) - 1 if data.endswith(b"\n") else len(data)
    for _ in range(count):
        cut = data.rfind(b"\n", 0, cut)
        if cut < 0:
            return data
    return data[cut + 1 :]


async def follow_file(
    root: str, target: str, count: int, process: asyncssh.SSHServerProcess
) -> None:
    """What the follow command does under the chroot: an empty line once a
    regular readable file is open at ``target``, its last ``count`` lines,
    then what it gains until the client closes the channel, from the top
    again once it shrinks, as ``tail -f`` does. Anything else is the
    shell's refusal and exit 1.

    Args:
        root (str): Local directory served as the SFTP root.
        target (str): The file, as the client named it.
        count (int): The ``-n`` count.
        process (asyncssh.SSHServerProcess): The exec request.
    """
    root = os.path.realpath(root)
    path = os.path.join(root, target.lstrip("/"))
    if not _followable(root, target):
        process.stderr.write(f"sh: {target}: cannot open\n".encode())
        process.exit(1)
        return
    data = await asyncio.to_thread(_read_bytes, path)
    position = len(data)
    try:
        process.stdout.write(b"\n" + last_lines(data, count))
        while not process.channel.is_closing():
            await asyncio.sleep(FOLLOW_POLL)
            try:
                data = await asyncio.to_thread(_read_bytes, path)
            except OSError as exc:
                logger.debug("followed %s is gone: %s", path, exc)
                continue
            if len(data) < position:
                position = 0
            if len(data) > position:
                process.stdout.write(data[position:])
                position = len(data)
    except BrokenPipeError as exc:
        logger.debug("follow of %s closed by the client: %s", path, exc)


def _followable(root: str, target: str) -> bool:
    """Whether a regular file the server can open for reading is at
    ``target`` under the chroot, which is what the follow command checks.

    Args:
        root (str): Local directory served as the SFTP root.
        target (str): The file, as the client named it.
    """
    root = os.path.realpath(root)
    path = os.path.join(root, target.lstrip("/"))
    return (
        _inside(root, path)
        and os.path.isfile(path)
        and os.access(path, os.R_OK)
    )


def _read_bytes(path: str) -> bytes:
    with open(path, "rb") as handle:
        return handle.read()


def tree_copy(root: str, source: str, target: str) -> tuple[int, bytes, bytes]:
    """What ``cp -RL SOURCE TARGET && echo copied`` answers under the
    chroot: the tree copied with links followed, then the echo. A missing
    source, a directory the SFTP server will not list or a file it cannot
    read fails with cp's message, as cp does, and the rest still copies.
    Nothing outside ``root`` is read or written, through a link or not.

    Args:
        root (str): Local directory served as the SFTP root.
        source (str): The directory, as the client named it.
        target (str): The copy, as the client named it.
    """
    root = os.path.realpath(root)
    base = os.path.join(root, source.lstrip("/"))
    if not _inside(root, base) or not os.path.exists(base):
        return (
            1,
            b"",
            f"cp: cannot stat '{source}': No such file or directory\n".encode(),
        )
    land = os.path.join(root, target.lstrip("/"))
    if not _inside(root, os.path.dirname(land.rstrip("/"))):
        return (
            1,
            b"",
            (
                f"cp: cannot create directory '{target}': "
                "No such file or directory\n"
            ).encode(),
        )
    errors: list[str] = []

    def visit(
        path: str, dest: str, named: str, shown: str, above: frozenset[str]
    ) -> None:
        if not _inside(root, path):
            errors.append(f"cp: cannot stat '{named}': Permission denied\n")
            return
        if not os.path.isdir(path):
            try:
                shutil.copyfile(path, dest)
            except OSError as exc:
                errors.append(
                    f"cp: cannot open '{named}' for reading: {exc.strerror}\n"
                )
            return
        real = os.path.realpath(path)
        if real in above:
            errors.append(
                f"cp: cannot stat '{named}': "
                "Too many levels of symbolic links\n"
            )
            return
        try:
            os.mkdir(dest)
        except OSError as exc:
            errors.append(
                f"cp: cannot create directory '{shown}': {exc.strerror}\n"
            )
            return
        if os.path.basename(path).encode() == UNLISTABLE:
            errors.append(
                f"cp: cannot open directory '{named}': Permission denied\n"
            )
            return
        for name in sorted(os.listdir(path)):
            visit(
                os.path.join(path, name),
                os.path.join(dest, name),
                f"{named}/{name}",
                f"{shown}/{name}",
                above | {real},
            )

    visit(base, land, source.rstrip("/"), target.rstrip("/"), frozenset())
    if errors:
        return 1, b"", "".join(errors).encode()
    return 0, b"copied\n", b""


def _answer(root: str, argv: list[str]) -> tuple[int, bytes, bytes] | None:
    """The answer to the commands the mount sends, or None for any other.

    Args:
        root (str): Local directory served as the SFTP root.
        argv (list[str]): The command, split as the shell splits it.
    """
    fold = argv[len(SEARCH) : len(SEARCH) + 1] == ["-i"]
    rest = argv[len(SEARCH) + fold :]
    if (
        argv[: len(SEARCH)] == SEARCH
        and len(rest) >= 4
        and rest[::2][:2] == ["-e", "--"]
    ):
        return search_names(root, rest[1].encode(), fold, rest[3:])
    if argv[: len(FIND)] == FIND and argv[len(FIND) + 1 :] == [
        "-printf",
        TREE_FORMAT,
    ]:
        return tree_records(root, argv[len(FIND)])
    if len(argv) == 3 and argv[0] in SUMS and argv[1] == "<":
        return file_digest(root, argv[0], argv[2])
    if argv[: len(WC)] == WC and len(argv) == len(WC) + 1:
        return line_total(root, argv[-1])
    if (
        argv[: len(CP)] == CP
        and argv[len(CP) + 2 :] == COPIED
        and len(argv) == len(CP) + 2 + len(COPIED)
    ):
        return tree_copy(root, argv[len(CP)], argv[len(CP) + 1])
    return None


async def run_command(root: str, process: asyncssh.SSHServerProcess) -> None:
    """Answer the ssh search's grep, the tree's find, the line count's
    wc, the checksum's sums, the tree copy's cp and the follow's tail,
    and refuse any other command.

    Args:
        root (str): Local directory served as the SFTP root.
        process (asyncssh.SSHServerProcess): The exec request.
    """
    argv = shlex.split(process.command or "")
    if (
        len(argv) == 22
        and argv[18].isdigit()
        and argv == follow_shape(argv[2], argv[18])
    ):
        await follow_file(root, argv[2], int(argv[18]), process)
        return
    answer = await asyncio.to_thread(_answer, root, argv)
    if answer is None:
        process.stderr.write(b"only the mount's own commands run here\n")
        process.exit(127)
        return
    status, out, err = answer
    process.stdout.write(out)
    process.stderr.write(err)
    process.exit(status)


async def start_server(root: str, port: int = 0) -> asyncssh.SSHAcceptor:
    """Start a no-auth SFTP server chrooted to root, which runs no command
    but the mount's grep, find, wc, sums, cp and tail.

    Args:
        root (str): Local directory served as the SFTP root.
        port (int): Port to listen on; 0 picks a free port.
    """
    host_key = asyncssh.generate_private_key("ssh-ed25519")
    return await asyncssh.listen(
        BIND_HOST,
        port,
        server_host_keys=[host_key],
        server_factory=NoAuthServer,
        sftp_factory=functools.partial(ChrootSFTPServer, root),
        process_factory=functools.partial(run_command, root),
        encoding=None,
    )


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--root", default=None)
    args = parser.parse_args()
    root = args.root or tempfile.mkdtemp(prefix="mirage-integ-ssh-")
    server = await start_server(root, args.port)
    print(
        f"SSH_HOST=127.0.0.1 SSH_PORT={server.get_port()} ROOT={root}",
        flush=True,
    )
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
