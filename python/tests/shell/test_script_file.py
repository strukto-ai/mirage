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


def test_dash_o_applies_the_named_option(shell):
    shell.create_file("pf.sh", b"false | true\necho pipefail=$?\n")
    assert shell.mirage("bash -o pipefail /data/pf.sh") == "pipefail=1\n"


def test_dash_o_applies_from_inside_a_cluster(shell):
    shell.create_file("pf.sh", b"false | true\necho pipefail=$?\n")
    code, out, err = shell.mirage_result("bash -xo pipefail /data/pf.sh")
    assert out == "pipefail=1\n"
    assert err == "+ false\n+ true\n+ echo pipefail=1\n"
    assert code == 0


def test_plus_flag_is_an_option_word_not_an_operand(shell):
    shell.create_file("run.sh", b"echo hi\n")
    assert shell.mirage_result("bash +x /data/run.sh") == (0, "hi\n", "")


def test_plus_o_is_an_option_word_not_an_operand(shell):
    shell.create_file("run.sh", b"echo hi\n")
    assert shell.mirage_result("bash +o xtrace /data/run.sh") == (0, "hi\n",
                                                                  "")


def test_single_dash_ends_option_parsing(shell):
    shell.create_file("run.sh", b"echo hi\n")
    assert shell.mirage("bash - /data/run.sh") == "hi\n"


def test_long_option_with_a_value_consumes_it(shell):
    shell.create_file("run.sh", b"echo hi\n")
    assert shell.mirage_result("bash --rcfile /data/run.sh") == (0, "", "")


def test_unknown_long_option_is_a_usage_error(shell):
    code, _, err = shell.mirage_result("bash --nosuch /data/run.sh")
    assert err == "bash: --nosuch: unsupported option\n"
    assert code == 2


def test_program_comes_from_stdin_when_no_operand_names_one(shell):
    assert shell.mirage("echo 'echo hi' | bash") == "hi\n"


def test_dash_s_makes_every_operand_positional(shell):
    out = shell.mirage("echo 'echo zero=$0 one=$1' | bash -s A B")
    assert out == "zero=bash one=A\n"


def test_nested_shell_does_not_leak_the_working_directory(shell):
    shell.create_file("sub/keep.txt", b"x\n")
    shell.create_file("cd.sh", b"cd /data/sub\n")
    assert shell.mirage("bash /data/cd.sh; pwd") == "/data\n"


def test_nested_shell_does_not_leak_an_export(shell):
    shell.create_file("exp.sh", b"export LEAK=1\n")
    assert shell.mirage("bash /data/exp.sh; echo [$LEAK]") == "[]\n"


def test_nested_shell_options_do_not_leak_into_the_caller(shell):
    shell.create_file("opt.sh", b"set -f\n")
    shell.create_file("a.txt", b"x\n")
    assert shell.mirage(
        "bash /data/opt.sh; echo /data/*.txt") == "/data/a.txt\n"


def test_sourced_shell_options_stay_set_in_the_caller(shell):
    shell.create_file("opt.sh", b"set -f\n")
    shell.create_file("a.txt", b"x\n")
    assert shell.mirage(
        "source /data/opt.sh; echo /data/*.txt") == "/data/*.txt\n"


def test_source_reports_a_missing_file_as_typed(shell):
    code, _, err = shell.mirage_result("source nope.sh")
    assert err == "source: nope.sh: No such file or directory\n"
    assert code == 1


def test_source_reports_a_directory_operand(shell):
    shell.create_file("sub/keep.txt", b"x\n")
    code, _, err = shell.mirage_result("source /data/sub")
    assert err == "source: /data/sub: Is a directory\n"
    assert code == 1


def test_source_with_no_operand_is_a_usage_error(shell):
    code, out, err = shell.mirage_result("source; echo after=$?")
    assert err == ("source: filename argument required\n"
                   "source: usage: source filename [arguments]\n")
    assert out == "after=2\n"
    assert code == 0
