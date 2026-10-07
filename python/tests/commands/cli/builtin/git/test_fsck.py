import hashlib
import subprocess
import zlib

import pytest

from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.fsck import check_pack
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, PathSpec

from .conftest import mounted, pack_everything


@pytest.mark.asyncio
@pytest.mark.parametrize("packed", [False, True])
async def test_fsck_real_objects_and_missing_blob(repo_path, packed):
    if packed:
        pack_everything(repo_path)
    with mounted(repo_path) as ws:
        ws.register_cli("git", GIT)
        result = await ws.shell("git -C /repo fsck --no-dangling")
        assert result.exit_code == 0, await result.stderr_str()
    if not packed:
        oid = subprocess.check_output(
            ["git", "-C", str(repo_path), "rev-parse", "HEAD:a.txt"], text=True
        ).strip()
        (repo_path / ".git" / "objects" / oid[:2] / oid[2:]).unlink()
        with mounted(repo_path) as ws:
            ws.register_cli("git", GIT)
            result = await ws.shell("git -C /repo fsck --no-dangling")
            assert result.exit_code != 0
            assert oid in await result.stderr_str()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "damage", ["hash", "zlib", "pack", "pack_content", "index", "missing_pack"]
)
async def test_fsck_rejects_corrupt_objects(repo_path, damage):
    oid = subprocess.check_output(
        ["git", "-C", str(repo_path), "rev-parse", "HEAD:a.txt"], text=True
    ).strip()
    if damage in ("pack", "pack_content", "index", "missing_pack"):
        pack_everything(repo_path)
        suffix = "idx" if damage == "index" else "pack"
        path = next((repo_path / ".git/objects/pack").glob(f"*.{suffix}"))
        content = bytearray(path.read_bytes())
        content[12 if damage == "pack_content" else -1] ^= 0xFF
        path.chmod(0o600)
        path.write_bytes(content)
        diagnostic = "checksum"
        if damage == "missing_pack":
            path.unlink()
            diagnostic = (
                f"cannot read pack /repo/.git/objects/pack/{path.name}"
            )
    else:
        path = repo_path / ".git/objects" / oid[:2] / oid[2:]
        path.chmod(0o600)
        path.write_bytes(
            zlib.compress(b"blob 7\0damaged")
            if damage == "hash"
            else b"broken zlib"
        )
        diagnostic = oid
    native = subprocess.run(
        ["git", "-C", str(repo_path), "fsck", "--no-dangling"],
        capture_output=True,
    )
    assert native.returncode != 0
    with mounted(repo_path) as ws:
        ws.register_cli("git", GIT)
        result = await ws.shell("git -C /repo fsck --no-dangling")
        assert result.exit_code != 0
        assert diagnostic in (await result.stderr_str()).lower()


@pytest.mark.asyncio
@pytest.mark.parametrize("length", [32, (1 << 18) + 5, (1 << 19) + 20])
@pytest.mark.parametrize("known_size", [False, True])
async def test_pack_checksum_uses_bounded_ranges(length, known_size):
    body = bytes(i % 251 for i in range(length - 20))
    checksum = hashlib.sha1(body).digest()
    data = body + checksum
    reads = []

    async def dispatch(op, path, **kwargs):
        if op == "stat":
            return FileStat(
                name="large.pack",
                type=FileType.FILE,
                size=len(data) if known_size else None,
            ), IOResult()
        assert op == "read"
        count, offset = kwargs["size"], kwargs["offset"]
        assert 0 < count <= 1 << 18
        reads.append((offset, count))
        return data[offset : offset + count], IOResult()

    await check_pack(
        dispatch,
        PathSpec.from_str_path("/repo/.git/objects/pack/large.pack"),
        checksum,
    )
    assert len(reads) >= (len(data) + (1 << 18) - 1) // (1 << 18)
    assert sum(
        min(count, len(data) - offset) for offset, count in reads
    ) == len(data)


@pytest.mark.asyncio
@pytest.mark.parametrize("failed_op", ["stat", "read"])
async def test_pack_permission_failure_keeps_path_and_git_error(failed_op):
    async def dispatch(op, path, **kwargs):
        if op == failed_op:
            raise PermissionError(path.virtual)
        return FileStat(
            name="denied.pack", type=FileType.FILE, size=100
        ), IOResult()

    with pytest.raises(
        GitError, match="cannot read pack /repo/denied.pack: Permission denied"
    ):
        await check_pack(
            dispatch, PathSpec.from_str_path("/repo/denied.pack"), b"0" * 20
        )
