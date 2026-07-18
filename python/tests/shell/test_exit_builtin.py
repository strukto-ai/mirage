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


def test_exit_stops_remaining_statements(shell):
    code, out, _ = shell.mirage_result("exit 3; echo hi")
    assert code == 3
    assert out == ""


def test_exit_keeps_output_of_earlier_statements(shell):
    code, out, _ = shell.mirage_result("echo a; exit 3; echo b")
    assert code == 3
    assert out == "a\n"


def test_exit_after_and_keeps_left_output(shell):
    code, out, _ = shell.mirage_result("echo a && exit 3")
    assert code == 3
    assert out == "a\n"


def test_exit_no_arg_uses_last_exit_code(shell):
    assert shell.mirage_exit("false; exit") == 1


def test_exit_contained_by_subshell(shell):
    code, out, _ = shell.mirage_result("(exit 3); echo after code=$?")
    assert code == 0
    assert out == "after code=3\n"


def test_exit_contained_by_pipeline(shell):
    code, out, _ = shell.mirage_result("exit 3 | cat; echo after code=$?")
    assert code == 0
    assert out == "after code=0\n"


def test_exit_inside_function_exits_shell(shell):
    code, out, _ = shell.mirage_result("f(){ exit 5; echo infn; }; f; echo no")
    assert code == 5
    assert out == ""


def test_exit_non_numeric_exits_2(shell):
    code, _, err = shell.mirage_result("exit abc; echo hi")
    assert code == 2
    assert err == "exit: abc: numeric argument required\n"


def test_exit_too_many_arguments_does_not_exit(shell):
    code, out, err = shell.mirage_result("exit 1 2; echo after code=$?")
    assert code == 0
    assert out == "after code=1\n"
    assert err == "exit: too many arguments\n"


def test_exit_status_wraps_mod_256(shell):
    assert shell.mirage_exit("exit 300") == 44
    assert shell.mirage_exit("exit -1") == 255


def test_unsupported_construct_is_graceful(shell):
    code, out, err = shell.mirage_result(
        "for ((i=0;i<3;i++)); do echo $i; done")
    assert code == 2
    assert out == ""
    assert err == ("mirage: unsupported shell construct: "
                   "c_style_for_statement\n")
