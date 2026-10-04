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

from unittest.mock import AsyncMock

import pytest

from mirage.commands.builtin.github.rg import rg
from mirage.commands.config import CommandOpts
from mirage.io.types import IOResult
from mirage.types import PathSpec

_GLOBALS = rg.__wrapped__.__globals__


def _subdir() -> PathSpec:
    return PathSpec(
        vfs_path="src", virtual="/src", directory="/src", resolved=False
    )


def _narrowed(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.removeprefix("/"),
        virtual=virtual,
        directory="",
        resolved=True,
    )


@pytest.fixture
def seam(monkeypatch):
    narrow = AsyncMock(return_value=([_subdir()], 3, False))
    generic = AsyncMock(return_value=(b"", IOResult()))
    monkeypatch.setitem(_GLOBALS, "narrow_scope", narrow)
    monkeypatch.setitem(_GLOBALS, "rg_generic", generic)
    return narrow, generic


@pytest.mark.asyncio
async def test_dash_upper_i_suppression_survives_narrowing(github_env, seam):
    accessor, index = github_env
    narrow, generic = seam
    narrow.return_value = ([_narrowed("/src/a.py")], 1, True)
    await rg(
        accessor,
        [_subdir()],
        ["needle"],
        CommandOpts(
            index=index, flags={"word_regexp": True, "no_filename": True}
        ),
    )
    assert "with_filename" not in generic.await_args.args[2].flags


@pytest.mark.asyncio
async def test_walk_fallback_leaves_flags_alone(github_env, seam):
    accessor, index = github_env
    _, generic = seam
    await rg(
        accessor,
        [_subdir()],
        ["needle"],
        CommandOpts(index=index, flags={"word_regexp": True}),
    )
    assert "with_filename" not in generic.await_args.args[2].flags


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "candidates, flags, searched",
    [
        (["/src/.env", "/src/.github/ci.yml", "/src/a.py"], {}, ["/src/a.py"]),
        (
            ["/src/.env", "/src/a.py"],
            {"hidden": True},
            ["/src/.env", "/src/a.py"],
        ),
        (["/src/.env"], {}, None),
        (["/src/main.py"], {"type": "py"}, ["/src/main.py"]),
        (["/src/main.py"], {"type": "md"}, None),
        (
            ["/src/main.py"],
            {"files_with_matches": True, "glob": ["*.nomatch"]},
            None,
        ),
    ],
    ids=["hidden", "--hidden", "all-hidden", "-t-py", "-t-md", "-g-nomatch"],
)
async def test_walk_filters_over_narrowed_candidates(
    github_env, seam, candidates, flags, searched
):
    # The candidates stand in for a walk, which filters hidden entries, -t
    # and -g, while a file named on the line is never filtered, so the
    # wrapper filters them itself; none left is no match, not a stdin run.
    accessor, index = github_env
    narrow, generic = seam
    narrowed = [_narrowed(v) for v in candidates]
    narrow.return_value = (narrowed, len(narrowed), True)
    stdout, io = await rg(
        accessor,
        [_subdir()],
        ["needle"],
        CommandOpts(index=index, flags={"word_regexp": True, **flags}),
    )
    if searched is None:
        assert (stdout, io.exit_code) == (b"", 1)
        generic.assert_not_awaited()
    else:
        assert [p.virtual for p in generic.await_args.args[0]] == searched
