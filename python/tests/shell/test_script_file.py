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


@pytest.mark.parametrize("head", ["sh", "bash"])
def test_script_file_runs_its_lines(shell, head):
    shell.create_file("run.sh", b"echo one\necho two\n")
    assert shell.mirage(f"{head} /data/run.sh") == "one\ntwo\n"


def test_script_file_relative_to_cwd(shell):
    shell.create_file("run.sh", b"echo hi\n")
    assert shell.mirage("sh run.sh") == "hi\n"


def test_script_file_after_double_dash(shell):
    shell.create_file("run.sh", b"echo hi\n")
    assert shell.mirage("bash -- /data/run.sh") == "hi\n"


def test_script_file_takes_positional_args(shell):
    shell.create_file("run.sh", b"echo $# $1 $2\n")
    assert shell.mirage("sh /data/run.sh a b") == "2 a b\n"


def test_script_file_operands_are_not_flags(shell):
    shell.create_file("run.sh", b'echo "$@"\n')
    assert shell.mirage("sh /data/run.sh -c foo") == "-c foo\n"


def test_script_file_sets_dollar_zero(shell):
    shell.create_file("run.sh", b"echo $0\n")
    assert shell.mirage("sh /data/run.sh") == "/data/run.sh\n"


def test_script_file_restores_positional_args(shell):
    shell.create_file("run.sh", b"echo inner $1\n")
    out = shell.mirage("set -- outer; sh /data/run.sh inner-arg; echo $0 $1")
    assert out == "inner inner-arg\nmirage outer\n"


def test_script_file_exit_status_propagates(shell):
    shell.create_file("run.sh", b"exit 7\n")
    assert shell.mirage_exit("sh /data/run.sh") == 7


@pytest.mark.parametrize("head", ["sh", "bash"])
def test_missing_script_reports_the_file_and_exits_127(shell, head):
    code, _, err = shell.mirage_result(f"{head} /data/nope.sh")
    assert err == f"{head}: /data/nope.sh: No such file or directory\n"
    assert code == 127


def test_directory_script_exits_126(shell):
    shell.create_file("sub/keep.txt", b"x\n")
    code, _, err = shell.mirage_result("sh /data/sub")
    assert err == "/data/sub: /data/sub: Is a directory\n"
    assert code == 126


def test_dash_x_traces_the_script(shell):
    shell.create_file("run.sh", b"echo hi\n")
    code, out, err = shell.mirage_result("bash -x /data/run.sh")
    assert out == "hi\n"
    assert err == "+ echo hi\n"
    assert code == 0


def test_dash_x_does_not_leak_into_the_caller(shell):
    shell.create_file("run.sh", b"echo hi\n")
    code, _, err = shell.mirage_result("bash -x /data/run.sh; echo after")
    assert err == "+ echo hi\n"
    assert code == 0


def test_dash_c_still_runs_inline_text(shell):
    assert shell.mirage("sh -c 'echo hello'") == "hello\n"


def test_dash_c_takes_name_and_positional_args(shell):
    out = shell.mirage("sh -c 'echo $0 $# $1 $2' myname a b")
    assert out == "myname 2 a b\n"


def test_dash_c_missing_argument_names_the_head_word(shell):
    code, _, err = shell.mirage_result("sh -c")
    assert err == "sh: -c: option requires an argument\n"
    assert code == 2
