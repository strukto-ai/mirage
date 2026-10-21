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

import os
import subprocess
import uuid

import pytest

from mirage.runtime.sandbox.constants import EXEC_ID, reap_line, wrap_line

PRELUDE = '/bin/sh -c \'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"\' sh '


@pytest.mark.parametrize(
    ("argv", "env", "cwd", "wrapped"),
    [
        (
            ("echo", "hi"),
            {"A": "1"},
            "/w",
            f"{PRELUDE}'/w' env 'A=1' 'echo' 'hi'",
        ),
        (
            ("/bin/sh", "-c", "echo 'hi'"),
            {"M": "two words"},
            "/a b",
            f"{PRELUDE}'/a b' env 'M=two words' '/bin/sh' '-c' "
            "'echo '\\''hi'\\'''",
        ),
        (("pwd",), {}, "/", f"{PRELUDE}'/' env 'pwd'"),
    ],
    ids=["cwd-env-argv", "hostile-values", "no-env"],
)
def test_wrap_line_dresses_cwd_env_and_argv(argv, env, cwd, wrapped):
    assert wrap_line(argv, env, cwd) == wrapped


def test_the_wrapped_argv_reaches_the_program_unchanged(tmp_path):
    argv = ("/bin/sh", "-c", 'printf "[%s]\\n" "$@"', "sh", "a b", "$(x)", "")
    done = subprocess.run(
        ["/bin/sh", "-c", wrap_line(argv, {}, str(tmp_path))],
        capture_output=True,
        check=False,
    )
    assert (done.returncode, done.stdout) == (0, b"[a b]\n[$(x)]\n[]\n")


def test_a_path_without_sh_still_runs_the_line(tmp_path):
    wrapped = wrap_line(
        ("/bin/sh", "-c", "/bin/echo ok"),
        {"PATH": str(tmp_path)},
        str(tmp_path),
    )
    done = subprocess.run(
        ["/bin/sh", "-c", wrapped], capture_output=True, check=False
    )
    assert (done.returncode, done.stdout) == (0, b"ok\n")


# A run's program may ignore TERM, and the config may set a PATH that
# holds no grep: the stop line still ends every process of the run.
@pytest.mark.skipif(not os.path.isdir("/proc/self"), reason="needs /proc")
@pytest.mark.parametrize("path", [None, "/nowhere"], ids=["path", "no-grep"])
def test_the_stop_line_ends_a_run_that_ignores_term(path):
    exec_id = uuid.uuid4().hex
    program = subprocess.Popen(
        [
            "/bin/sh",
            "-c",
            'trap "" TERM; echo ready; while :; do sleep 1; done',
        ],
        env={**os.environ, EXEC_ID: exec_id},
        stdout=subprocess.PIPE,
    )
    assert program.stdout is not None
    try:
        assert program.stdout.readline() == b"ready\n"
        done = subprocess.run(
            ["/bin/sh", "-c", reap_line(exec_id)],
            env=dict(os.environ) if path is None else {"PATH": path},
            check=False,
            timeout=10,
        )
        assert done.returncode == 0
        assert program.wait(timeout=5) == -9
    finally:
        if program.poll() is None:
            program.kill()
        program.stdout.close()
