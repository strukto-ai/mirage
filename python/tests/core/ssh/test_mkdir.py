import errno

import asyncssh
import pytest

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh.mkdir import mkdir
from mirage.types import PathSpec
from mirage.vfs.ssh.config import SSHConfig


class _FakeSFTP:
    """Just enough of asyncssh's SFTPClient for a recursive mkdir.

    Args:
        dirs (set[str]): what ``isdir`` reports, a link to a directory
            included, since its stat follows links.
        files (set[str]): the other names ``lexists`` reports.
        refusal (Exception | None): what mkdir raises; None makes it.
    """

    def __init__(
        self,
        dirs: set[str],
        files: set[str] | None = None,
        refusal: Exception | None = None,
    ) -> None:
        self.dirs = dirs
        self.files = files or set()
        self.refusal = refusal

    async def isdir(self, remote: str) -> bool:
        return remote in self.dirs

    async def lexists(self, remote: str) -> bool:
        return remote in self.dirs or remote in self.files

    async def mkdir(self, remote: str) -> None:
        if self.refusal is not None:
            raise self.refusal
        if await self.lexists(remote):
            raise asyncssh.SFTPFailure("Failure")
        self.dirs.add(remote)


def _accessor(sftp: _FakeSFTP, root: str = "/") -> SSHAccessor:
    accessor = SSHAccessor(SSHConfig(host="example.test", root=root))
    accessor._sftp = sftp
    return accessor


@pytest.mark.asyncio
async def test_parents_make_a_missing_configured_root():
    sftp = _FakeSFTP({"/"})
    accessor = _accessor(sftp, root="/srv/ws")
    await mkdir(accessor, PathSpec.from_str_path("/a"), True)
    assert {"/srv", "/srv/ws", "/srv/ws/a"} <= sftp.dirs


@pytest.mark.asyncio
async def test_parents_pass_a_server_side_link_to_a_directory():
    sftp = _FakeSFTP({"/", "/lnk"})
    await mkdir(_accessor(sftp), PathSpec.from_str_path("/lnk/new"), True)
    assert "/lnk/new" in sftp.dirs


@pytest.mark.asyncio
async def test_parents_name_a_file_in_the_way_as_enotdir():
    sftp = _FakeSFTP({"/"}, {"/f"})
    with pytest.raises(OSError) as exc:
        await mkdir(_accessor(sftp), PathSpec.from_str_path("/f/x"), True)
    assert (exc.value.errno, exc.value.filename) == (errno.ENOTDIR, "/f")


@pytest.mark.asyncio
async def test_parents_name_a_refused_step_as_eacces():
    denied = asyncssh.SFTPPermissionDenied("Permission denied")
    sftp = _FakeSFTP({"/", "/locked"}, refusal=denied)
    with pytest.raises(OSError) as exc:
        await mkdir(
            _accessor(sftp), PathSpec.from_str_path("/locked/new"), True
        )
    assert (exc.value.errno, exc.value.filename) == (
        errno.EACCES,
        "/locked/new",
    )
