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

from mirage.runtime.sandbox.ssh.constants import wrap_line


@pytest.mark.parametrize(
    ("line", "env", "cwd", "wrapped"),
    [
        ("echo hi", {"A": "1"}, "/w", "cd '/w' && env 'A=1' sh -c 'echo hi'"),
        (
            "echo 'hi'",
            {"M": "two words"},
            "/a b",
            "cd '/a b' && env 'M=two words' sh -c 'echo '\\''hi'\\'''",
        ),
        ("pwd", {}, "/", "cd '/' && env sh -c 'pwd'"),
    ],
    ids=["cwd-env-line", "hostile-values", "no-env"],
)
def test_wrap_line_dresses_cwd_env_and_line(line, env, cwd, wrapped):
    assert wrap_line(line, env, cwd) == wrapped
