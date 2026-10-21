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

import subprocess

import pytest

from mirage.runtime.sandbox.constants import wrap_line

PRELUDE = '/bin/sh -c \'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"\' sh '


@pytest.mark.parametrize(
    ("line", "env", "cwd", "wrapped"),
    [
        (
            "echo hi",
            {"A": "1"},
            "/w",
            f"{PRELUDE}'/w' env 'A=1' /bin/sh -c 'echo hi'",
        ),
        (
            "echo 'hi'",
            {"M": "two words"},
            "/a b",
            f"{PRELUDE}'/a b' env 'M=two words' /bin/sh -c 'echo '\\''hi'\\'''",
        ),
        ("pwd", {}, "/", f"{PRELUDE}'/' env /bin/sh -c 'pwd'"),
    ],
    ids=["cwd-env-line", "hostile-values", "no-env"],
)
def test_wrap_line_dresses_cwd_env_and_line(line, env, cwd, wrapped):
    assert wrap_line(line, env, cwd) == wrapped


def test_a_path_without_sh_still_runs_the_line(tmp_path):
    wrapped = wrap_line("/bin/echo ok", {"PATH": str(tmp_path)}, str(tmp_path))
    done = subprocess.run(
        ["/bin/sh", "-c", wrapped], capture_output=True, check=False
    )
    assert (done.returncode, done.stdout) == (0, b"ok\n")
