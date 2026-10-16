from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh.write import write_stream
from mirage.types import PathSpec
from mirage.vfs.ssh.config import SSHConfig


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", [False, True])
async def test_atomic_stream_commits_only_after_eof_and_removes_failed_staging(
    fail,
):
    handle = AsyncMock()
    handle.__aenter__.return_value = handle
    sftp = Mock(
        stat=AsyncMock(return_value=SimpleNamespace(permissions=0o100640)),
        open=AsyncMock(return_value=handle),
        chmod=AsyncMock(),
        posix_rename=AsyncMock(),
        remove=AsyncMock(),
    )
    accessor = SSHAccessor(SSHConfig(host="example.test", root="/srv"))
    accessor._sftp = sftp
    closed = []

    async def source():
        try:
            yield b"first"
            sftp.posix_rename.assert_not_called()
            if fail:
                raise RuntimeError("producer failed")
            yield b"last"
        finally:
            closed.append(True)

    path = PathSpec(vfs_path="a", virtual="/m/a", directory="/m/")
    if fail:
        with pytest.raises(RuntimeError, match="producer failed"):
            await write_stream(accessor, path, source(), atomic=True)
        sftp.posix_rename.assert_not_called()
        sftp.remove.assert_awaited_once()
    else:
        await write_stream(accessor, path, source(), atomic=True)
        temporary = sftp.open.call_args.args[0]
        sftp.posix_rename.assert_awaited_once_with(temporary, "/srv/a")
        sftp.chmod.assert_awaited_once_with(temporary, 0o640)
        sftp.remove.assert_not_called()
        assert [call.args[0] for call in handle.write.call_args_list] == [
            b"first",
            b"last",
        ]
    assert sftp.open.call_args.args[1] == "xb"
    assert closed == [True]
    handle.__aexit__.assert_awaited_once()
