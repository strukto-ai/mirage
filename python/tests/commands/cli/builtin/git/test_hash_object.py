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

from mirage.commands.cli.builtin.git.hash_object import well_formed


@pytest.mark.parametrize(
    "kind,data,ok",
    [
        ("tree", b"100644 a\0" + b"\1" * 20 + b"40000 b\0" + b"\2" * 20, True),
        (
            "tree",
            b"100644 b\0" + b"\1" * 20 + b"100644 a\0" + b"\2" * 20,
            False,
        ),
        ("tree", b"100644 a\0" + b"\1" * 19, False),
        ("tree", b"", True),
        (
            "commit",
            b"tree " + b"a" * 40 + b"\nauthor A <a@x> 1 +0000\n"
            b"committer A <a@x> 1 +0000\n\nmsg\n",
            True,
        ),
        ("commit", b"tree " + b"a" * 40 + b"\n\nmsg\n", False),
        (
            "tag",
            b"object " + b"a" * 40 + b"\ntype commit\ntag v1\n\nmsg\n",
            True,
        ),
        ("tag", b"object " + b"a" * 40 + b"\ntype nope\ntag v1\n", False),
        ("blob", b"anything", True),
    ],
)
def test_well_formed_checks_what_git_fsck_checks(kind, data, ok):
    assert well_formed(kind, data) is ok
