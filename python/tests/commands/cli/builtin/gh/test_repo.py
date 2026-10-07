import pytest

from mirage.commands.cli.builtin.gh import GH, repo
from mirage.commands.cli.types import CLIInvocation
from mirage.core.github.config import GhConfig
from mirage.io.types import IOResult
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

WORK = PathSpec.from_str_path("/w")


@pytest.fixture
def clones(monkeypatch) -> list[CLIInvocation[None]]:
    calls: list[CLIInvocation[None]] = []

    async def clone(
        inv: CLIInvocation[None], headers: dict[str, str]
    ) -> tuple[None, IOResult]:
        calls.append(inv)
        return None, IOResult()

    async def login(config: GhConfig) -> str:
        return "alice"

    monkeypatch.setattr(repo, "git_clone", clone)
    monkeypatch.setattr(repo, "login", login)
    return calls


async def _run(line: str, base: str | None = None) -> IOResult:
    with Workspace({"/w/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        ws.register_cli(
            "gh", GH, {"token": "secret-never-print", "base_url": base}
        )
        return await ws.shell(line)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,base,texts,flags",
    [
        (
            "cd /w && gh repo clone o/r",
            None,
            ("https://github.com/o/r.git", "r"),
            {"C": WORK},
        ),
        (
            "cd /w && gh repo clone https://github.com/o/r.git dest",
            None,
            ("https://github.com/o/r.git", "dest"),
            {"C": WORK},
        ),
        (
            "cd /w && gh repo clone mine -- -q --branch dev",
            None,
            ("https://github.com/alice/mine.git", "mine"),
            {"quiet": True, "branch": "dev", "C": WORK},
        ),
        (
            "cd /w && gh repo clone ghe.test/o/r",
            "https://ghe.test/api/v3",
            ("https://ghe.test/o/r.git", "r"),
            {"C": WORK},
        ),
    ],
)
async def test_clone_hands_git_clone_the_url_and_its_flags(
    clones, line, base, texts, flags
):
    result = await _run(line, base)
    assert (result.exit_code, result.stderr) == (0, None)
    assert (clones[0].texts, clones[0].flags) == (texts, flags)
