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

import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

# Pinned against GNU bash 5.2.37: `[` is a command, so every operator the
# grammar folds into a `[ ... ]` test reaches it as an operand word, and test
# refuses the ones it does not know rather than never seeing them.


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, out, err",
    [
        ("[ a == a ] && echo y", "y\n", ""),
        ("[ $ ] && echo y", "y\n", ""),
        (
            "[ a =~ a ]; echo $?",
            "2\n",
            "bash: [: =~: binary operator expected\n",
        ),
        (
            "[ 1 + 1 ]; echo $?",
            "2\n",
            "bash: [: +: binary operator expected\n",
        ),
        (
            "[ a += b ]; echo $?",
            "2\n",
            "bash: [: +=: binary operator expected\n",
        ),
        (
            "[ a -= b ]; echo $?",
            "2\n",
            "bash: [: -=: binary operator expected\n",
        ),
    ],
)
async def test_every_operator_reaches_test_as_a_word(line, out, err):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(line)
    assert (await io.stdout_str(), await io.stderr_str()) == (out, err)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, out, err",
    [
        ("[[ x == x || -n <(printf unused >&2) ]]; echo $?", "0\n", ""),
        ("[[ x == x || -n >(true) ]]; echo $?", "0\n", ""),
        ("[[ x == y && -n <(printf unused >&2) ]]; echo $?", "1\n", ""),
        ("[[ x == y && -n >(true) ]]; echo $?", "1\n", ""),
        ("[[ x == y || -n <(printf used >&2) ]]; echo $?", "0\n", "used"),
        ("[[ x == x || ${missing:?unused} ]]; echo $?", "0\n", ""),
        ('x=0; [[ x=5 -eq 5 && $x == 5 ]]; echo "$? $x"', "0 5\n", ""),
        (
            "[[ x == x && -n >(true) ]]; echo after=$?",
            "after=2\n",
            "mirage: unsupported: process substitution >(...)\n",
        ),
    ],
)
async def test_double_bracket_expands_only_reached_operands(line, out, err):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        io = await ws.shell(line)
        assert (
            io.exit_code,
            await io.stdout_str(),
            await io.stderr_str(),
        ) == (0, out, err)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, out, err",
    [
        (
            "case b in b) echo chosen;; @(<(printf unused >&2)|b)) :;; esac",
            "chosen\n",
            "",
        ),
        ("case b in b) echo chosen;; @(>(true)|b)) :;; esac", "chosen\n", ""),
        (
            "case b in b|$(printf unused >&2)) echo chosen;; esac",
            "chosen\n",
            "",
        ),
        ("case b in b|>(true)) echo chosen;; esac", "chosen\n", ""),
        (
            "case b in b) echo first;& @(<(printf unused >&2)|b)) echo second;; esac",
            "first\nsecond\n",
            "",
        ),
        (
            'p=x; case b in b) p=b; echo first;;& "$p") echo second;; esac',
            "first\nsecond\n",
            "",
        ),
        (
            "case b in @(b|$(printf used >&2))) echo chosen;; esac",
            "chosen\n",
            "used",
        ),
        (
            "case b in <(printf used >&2)|b) echo chosen;; esac",
            "chosen\n",
            "used",
        ),
        (
            "case b in b) echo first;;& >(true)) echo BAD;; esac; echo after=$?",
            "first\nafter=2\n",
            "mirage: unsupported: process substitution >(...)\n",
        ),
        (
            "case b in b) printf body >&2;;& "
            "$(printf pattern >&2; printf b)) echo chosen;; esac",
            "chosen\n",
            "bodypattern",
        ),
    ],
)
async def test_case_expands_only_tested_patterns(line, out, err):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("shopt -s extglob")
        io = await ws.shell(line)
        assert (
            io.exit_code,
            await io.stdout_str(),
            await io.stderr_str(),
        ) == (0, out, err)
    finally:
        await ws.close()
