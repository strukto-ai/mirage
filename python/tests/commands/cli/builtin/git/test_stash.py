import subprocess

import pytest

from mirage.commands.cli.builtin.git import GIT

from .conftest import mounted


@pytest.mark.asyncio
async def test_stash_reads_native_reflog_and_diff(repo_path):
    path = repo_path / "a.txt"
    path.write_text(path.read_text() + "stashed change\n")
    subprocess.run(
        [
            "git",
            "-C",
            str(repo_path),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "stash",
            "push",
            "-m",
            "saved",
        ],
        check=True,
        capture_output=True,
    )
    with mounted(repo_path) as ws:
        ws.register_cli("git", GIT)
        for arguments in (
            ["stash", "list"],
            ["stash", "show"],
            ["stash", "show", "-p"],
            ["stash", "show", "--name-only", "stash@{0}"],
        ):
            native = subprocess.check_output(
                ["git", "-C", str(repo_path), *arguments]
            )
            result = await ws.shell("git -C /repo " + " ".join(arguments))
            assert result.exit_code == 0, await result.stderr_str()
            assert result.stdout == native


def _native(repo_path, *arguments: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [
            "git",
            "-C",
            str(repo_path),
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            *arguments,
        ],
        capture_output=True,
    )


@pytest.mark.asyncio
async def test_stash_skips_blank_reflog_rows_as_git_does(repo_path):
    path = repo_path / "a.txt"
    for change in ("first stash\n", "second stash\n"):
        path.write_text(path.read_text() + change)
        assert _native(repo_path, "stash", "push", "-q").returncode == 0
    log = repo_path / ".git" / "logs" / "refs" / "stash"
    rows = log.read_bytes().splitlines()
    log.write_bytes(b"\n\n".join(rows) + b"\n\n")
    with mounted(repo_path) as ws:
        ws.register_cli("git", GIT)
        for arguments in (
            ["stash", "list"],
            ["stash", "show"],
            ["stash", "show", "stash@{1}"],
            ["stash", "show", "1"],
            ["stash", "show", "stash@{2}"],
        ):
            native = _native(repo_path, *arguments)
            result = await ws.shell("git -C /repo " + " ".join(arguments))
            assert (
                result.exit_code,
                result.stdout or b"",
                result.stderr or b"",
            ) == (native.returncode, native.stdout, native.stderr)
