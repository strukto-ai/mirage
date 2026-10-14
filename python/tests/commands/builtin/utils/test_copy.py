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

from mirage.commands.builtin.utils.copy import landing_path
from mirage.types import PathSpec


def _spec(virtual: str, raw: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual.rsplit("/", 1)[0] or "/",
        vfs_path=virtual.strip("/"),
        raw_path=raw,
    )


@pytest.mark.parametrize(
    "typed,virtual,dotdot,landing,shown",
    [
        ("al", "/data/a.txt", "..", "/data/t/al", "t/al"),
        ("dir/al/", "/data/a.txt", "..", "/data/t/al", "t/al"),
        ("/data/x/y", "/data/x/y", "..", "/data/t/y", "t/y"),
        ("", "/data/sub", "..", "/data/t/sub", "t/sub"),
        (".", "/data/sub", "..", "/data/t", "t/."),
        ("s/./", "/data/s", "..", "/data/t", "t/."),
        ("sub/..", "/data", "..", "/data", "t/.."),
        ("sub/..", "/data", ".", "/data/t", "t/."),
    ],
)
def test_landing_path_appends_the_operand_as_typed(
    typed, virtual, dotdot, landing, shown
):
    # GNU appends the operand's last component as typed, so a followed
    # link lands under its own name and `.` lands in the destination
    # itself; cp lands `..` there too, mv in the destination's parent.
    got = landing_path(_spec("/data/t", "t"), _spec(virtual, typed), dotdot)
    assert (got.virtual, got.raw_path) == (landing, shown)
