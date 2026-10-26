import json
from pathlib import Path

import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

ROOT = Path(__file__).resolve().parents[4]
CASES = [
    case
    for name in ("bash/time.json", "bash/heredoc/pipeline.json")
    for case in json.loads((ROOT / "integ" / name).read_text())["cases"]
]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CASES, ids=lambda case: case["id"])
async def test_shell_regressions(case):
    with Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC) as ws:
        result = await ws.shell(case["command"].replace("{mount}", "/data"))
        assert result.exit_code == case["expect"]["exit"]
        assert await result.stdout_str() == case["expect"]["stdout"]
        assert await result.stderr_str() == case["expect"]["stderr"]


@pytest.mark.asyncio
async def test_portable_timing_waits_for_pipeline():
    with Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC) as ws:
        result = await ws.shell("time -p echo hi | cat")
        assert result.exit_code == 0
        assert await result.stdout_str() == "hi\n"
        lines = (await result.stderr_str()).splitlines()
        assert [line.split()[0] for line in lines] == ["real", "user", "sys"]
        assert all(float(line.split()[1]) >= 0 for line in lines)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, portable",
    [
        ("time time true", False),
        ("time -p time true", True),
        ("time time -p true", True),
        ("time ! time true", False),
        ("time", False),
    ],
)
async def test_a_pipeline_is_timed_once(line, portable):
    # bash 5.2.37: however many `time` words and `!` lead a pipeline, it
    # reports once, portable when any `time` takes `-p`.
    with Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC) as ws:
        result = await ws.shell(line)
        lines = (await result.stderr_str()).strip().splitlines()
        assert len(lines) == 3
        assert lines[0].startswith("real " if portable else "real\t")
