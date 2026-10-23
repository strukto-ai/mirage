import errno
import importlib
from pathlib import Path

import asyncssh
import pytest

from mirage import RAMVFS, Workspace
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ssh import SSHVFS
from mirage.vfs.ssh.config import SSHConfig


@pytest.fixture(params=["disk", "ssh"])
def unreadable_tree(request, tmp_path, monkeypatch):
    opened: list[str] = []
    kind, count = (
        request.param
        if isinstance(request.param, tuple)
        else (request.param, 0)
    )
    if kind == "disk":
        for name in ("a", "b", "c"):
            (tmp_path / name).mkdir()
            (tmp_path / name / "f").write_text("x")
        if count:
            (tmp_path / "large").mkdir()
            for number in range(count):
                (tmp_path / "large" / str(number)).write_bytes(b"x")
        module = importlib.import_module("mirage.core.disk.readdir")
        original = module.read_entries

        def read_entries(path: Path):
            opened.append(path.name)
            if path.name == "c":
                raise PermissionError(
                    errno.EACCES, "Permission denied", str(path)
                )
            return original(path)

        monkeypatch.setattr(module, "read_entries", read_entries)
        return DiskVFS(root=tmp_path), opened
    vfs = SSHVFS(SSHConfig(host="fake", root="/srv"))
    dirs = {"/srv", "/srv/a", "/srv/b", "/srv/c"}

    files = {f"{d}/f" for d in dirs if d != "/srv"}
    if count:
        dirs.add("/srv/large")
        files.update(f"/srv/large/{number}" for number in range(count))

    async def stat(path):
        if path not in dirs and path not in files:
            raise asyncssh.SFTPNoSuchFile("missing")
        is_dir = path in dirs
        return asyncssh.SFTPAttrs(
            type=asyncssh.FILEXFER_TYPE_DIRECTORY
            if is_dir
            else asyncssh.FILEXFER_TYPE_REGULAR,
            size=0 if is_dir else 1,
            mtime=0,
            atime=0,
            permissions=0o40755 if is_dir else 0o100644,
        )

    async def readdir(path):
        opened.append(path.rsplit("/", 1)[-1])
        if path == "/srv/c":
            raise asyncssh.SFTPPermissionDenied("Permission denied")
        names = ["a", "b", "c"] if path == "/srv" else ["f"]
        if path == "/srv/large":
            names = [str(number) for number in range(count)]
        elif count and path == "/srv":
            names.append("large")
        return [
            asyncssh.SFTPName(name, attrs=await stat(path + "/" + name))
            for name in names
        ]

    class Sftp:
        pass

    sftp = Sftp()
    sftp.stat = stat
    sftp.readdir = readdir
    monkeypatch.setattr(vfs.accessor, "_sftp", sftp)
    return vfs, opened


@pytest.mark.asyncio
async def test_partial_walks_keep_output_and_command_ownership(
    unreadable_tree,
):
    vfs, _ = unreadable_tree
    ws = Workspace({"/d": vfs, "/t": RAMVFS()}, mode="exec")
    diagnostic = b"find: '/d/c': Permission denied\n"
    try:
        cases = [
            ("find /d -type f", 1, b"/d/a/f\n/d/b/f\n", diagnostic),
            ("find /d -maxdepth 1", 0, b"/d\n/d/a\n/d/b\n/d/c\n", b""),
            ("find /d -empty", 1, b"", diagnostic),
            (
                "du -s /d",
                1,
                b"2\t/d\n",
                b"du: cannot read directory '/d/c': Permission denied\n",
            ),
            (
                "echo before; find /d -type f | head -3; echo after=$?",
                0,
                b"before\n/d/a/f\n/d/b/f\nafter=0\n",
                diagnostic,
            ),
            (
                "echo before; find / -maxdepth 3 -type f -name '*zzz*' "
                "2>/dev/null; echo after=$?",
                0,
                b"before\nafter=1\n",
                b"",
            ),
            (
                "echo before; find /d -type f >/t/o 2>/dev/null; "
                "echo after=$?; cat /t/o",
                0,
                b"before\nafter=1\n/d/a/f\n/d/b/f\n",
                b"",
            ),
        ]
        for line, code, out, err in cases:
            result = await ws.shell(line)
            assert (result.exit_code, result.stdout, result.stderr or b"") == (
                code,
                out,
                err,
            ), line
        result = await ws.shell(
            "echo before; du -s / 2>/dev/null; echo after=$?"
        )
        assert result.stdout.startswith(b"before\n")
        assert b"\t/\nafter=1\n" in result.stdout
        assert not result.stderr
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_depth_limit_does_not_open_children(unreadable_tree):
    vfs, opened = unreadable_tree
    ws = Workspace({"/d": vfs})
    try:
        result = await ws.shell("find /d -maxdepth 1")
        assert result.exit_code == 0
        assert "c" not in opened
        result = await ws.shell("find /d/c -maxdepth 0")
        assert (result.exit_code, result.stdout) == (0, b"/d/c\n")
        assert "c" not in opened
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "unreadable_tree", [("disk", 10001), ("ssh", 10001)], indirect=True
)
async def test_du_stops_at_the_mounts_full_scan_limit(unreadable_tree):
    vfs, _ = unreadable_tree
    limit = vfs.full_scan_limit
    ws = Workspace({"/d": vfs})
    try:
        summary = await ws.shell("du -s /d/large")
        assert summary.exit_code == 1
        assert (
            summary.stderr
            == (
                f"du: /d/large: stopped after {limit} files (full_scan_limit); "
                "narrow the path\n"
            ).encode()
        )
        assert summary.stdout == f"{limit}\t/d/large\n".encode()
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "unreadable_tree", [("disk", 10001), ("ssh", 10001)], indirect=True
)
async def test_du_lifted_accounts_for_every_entry(unreadable_tree):
    vfs, _ = unreadable_tree
    vfs.full_scan_limit = -1
    ws = Workspace({"/d": vfs})
    try:
        summary = await ws.shell("du -s /d/large")
        assert summary.exit_code == 0
        assert not summary.stderr
        assert summary.stdout == b"10001\t/d/large\n"
        detailed = await ws.shell("du -a /d/large")
        assert detailed.exit_code == 0
        assert not detailed.stderr
        assert len(detailed.stdout.splitlines()) == 10002
        assert detailed.stdout.endswith(b"10001\t/d/large\n")
    finally:
        await ws.close()
