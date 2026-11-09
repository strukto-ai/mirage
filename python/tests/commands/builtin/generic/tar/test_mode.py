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

from mirage.commands.builtin.generic.tar.mode import is_create_mode


@pytest.mark.parametrize(
    "argv,create",
    [
        (["-czf", "out.tgz", "dir"], True),
        (["--create", "-f", "out.tar", "dir"], True),
        (["-xzf", "a.tgz", "./m/x.json"], False),
        (["-tzf", "a.tgz"], False),
        (["cf", "a.tar", "d"], True),
        (["fc", "a.tar", "d"], True),
        (["-xf", "a.tar", "crate"], False),
        (["--exclude", "c", "-xf", "a.tar"], False),
        # GNU reads everything after -- as an operand (`tar: -C: Not
        # found in archive`).
        (["-xf", "a.tar", "--", "-c"], False),
        (["-xf", "a.tar", "--", "--create"], False),
        (["-cf", "a.tar", "--", "-c"], True),
        (["--crea", "-f", "a.tar", "d"], True),
        (["--cr=x"], True),
        # Ambiguous in tar's own table, so no mode at all.
        (["--c", "-f", "a.tar"], False),
        (["--get", "-f", "a.tar"], False),
    ],
)
def test_is_create_mode_reads_argv_as_tar_does(argv, create):
    assert is_create_mode(argv) is create
