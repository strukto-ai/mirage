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


def test_dev_null_cat(shell):
    assert shell.mirage("cat /dev/null") == ""


def test_dev_null_redirect_stdout(shell):
    assert shell.mirage("echo hello > /dev/null") == ""


def test_dev_null_redirect_stderr(shell):
    cmd = "cat /data/nope.txt 2>/dev/null || echo recovered"
    assert "recovered" in shell.mirage(cmd)


def test_dev_null_preserves_exit_code(shell):
    cmd = ("if cat /data/nope.txt 2>/dev/null; "
           "then echo found; else echo missing; fi")
    assert shell.mirage(cmd) == "missing\n"


def test_dev_null_in_pipe(shell):
    assert shell.mirage("echo hello | cat > /dev/null") == ""


def test_dev_zero_head(shell):
    result = shell.mirage("head -c 4 /dev/zero")
    assert result == "\x00\x00\x00\x00"


def test_dev_null_stat(shell):
    cmd = "if [ -f /dev/null ]; then echo exists; fi"
    assert shell.mirage(cmd) == "exists\n"


def test_rm_dev_null_exits_zero_and_removes(shell):
    exit_code, stdout, stderr = shell.mirage_result("rm /dev/null")
    assert exit_code == 0
    assert stdout == ""
    assert stderr == ""
    listing = shell.mirage("ls /dev").splitlines()
    assert "zero" in listing
    assert "null" not in listing
    exit_code, _, stderr = shell.mirage_result("cat /dev/null")
    assert exit_code != 0
    assert "No such file or directory" in stderr


def test_rm_v_dev_null_prints_true_claim(shell):
    exit_code, stdout, _ = shell.mirage_result("rm -v /dev/null")
    assert exit_code == 0
    assert stdout == "removed '/dev/null'\n"
    assert "null" not in shell.mirage("ls /dev").splitlines()


def test_rm_rf_dev_null_removes(shell):
    assert shell.mirage_exit("rm -rf /dev/null") == 0
    assert "null" not in shell.mirage("ls /dev").splitlines()


def test_redirect_recreates_removed_dev_null_as_regular_file(shell):
    shell.mirage("rm /dev/null")
    assert shell.mirage_exit("echo recreated > /dev/null") == 0
    assert shell.mirage("cat /dev/null") == "recreated\n"
    cmd = "if [ -f /dev/null ]; then echo regular; fi"
    assert shell.mirage(cmd) == "regular\n"


def test_rm_dev_zero_is_symmetric(shell):
    assert shell.mirage_exit("rm /dev/zero") == 0
    listing = shell.mirage("ls /dev").splitlines()
    assert "null" in listing
    assert "zero" not in listing
    assert shell.mirage_exit("echo z > /dev/zero") == 0
    assert shell.mirage("cat /dev/zero") == "z\n"
