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

from mirage.commands.builtin.utils.constants import CHAR_DEVICE_MAX_BYTES


def test_dev_null_cat(shell):
    assert shell.mirage("cat /dev/null") == ""


def test_dev_null_redirect_stdout(shell):
    assert shell.mirage("echo hello > /dev/null") == ""


def test_dev_null_redirect_stderr(shell):
    cmd = "cat /data/nope.txt 2>/dev/null || echo recovered"
    assert "recovered" in shell.mirage(cmd)


def test_dev_null_preserves_exit_code(shell):
    cmd = (
        "if cat /data/nope.txt 2>/dev/null; "
        "then echo found; else echo missing; fi"
    )
    assert shell.mirage(cmd) == "missing\n"


def test_dev_null_in_pipe(shell):
    assert shell.mirage("echo hello | cat > /dev/null") == ""


def test_dev_zero_head(shell):
    result = shell.mirage("head -c 4 /dev/zero")
    assert result == "\x00\x00\x00\x00"


def test_dev_zero_ranged_read_is_not_backed_by_a_finite_buffer(shell):
    result = shell.mirage("head -c 2M /dev/zero | wc -c")
    assert result == "2097152\n"


def test_dev_zero_cat_is_bounded_by_the_stream_safeguard(shell):
    code, stdout, stderr = shell.mirage_result("cat /dev/zero")
    assert code == 0
    assert len(stdout) == CHAR_DEVICE_MAX_BYTES
    assert stdout == "\x00" * CHAR_DEVICE_MAX_BYTES
    assert "output truncated" in stderr


def test_dev_zero_default_head_is_bounded_by_the_stream_safeguard(shell):
    code, stdout, stderr = shell.mirage_result("head /dev/zero")
    assert code == 0
    assert len(stdout) == CHAR_DEVICE_MAX_BYTES
    assert stdout == "\x00" * CHAR_DEVICE_MAX_BYTES
    assert "output truncated" in stderr


def test_device_safeguard_does_not_cap_adjacent_regular_files(shell):
    size = CHAR_DEVICE_MAX_BYTES + 1
    shell.create_file("large.bin", b"x" * size)
    code, stdout, stderr = shell.mirage_result(
        "cat /dev/null /data/large.bin | wc -c"
    )
    assert code == 0
    assert stdout == f"{size}\n"
    assert "output truncated" not in stderr


def test_dev_nodes_are_classified_as_character_devices(shell):
    assert shell.mirage("find /dev -type f") == ""
    assert shell.mirage("find /dev -type c") == (
        "/dev/null\n/dev/random\n/dev/tty\n/dev/urandom\n/dev/zero\n"
    )
    assert shell.mirage("find /dev -empty") == ""
    assert shell.mirage("stat -c '%F %t %T' /dev/null") == (
        "character special file 1 3\n"
    )
    long_zero = shell.mirage("ls -l /dev/zero")
    assert long_zero.startswith("crw-rw-rw-")
    assert "1, 5" in long_zero
    assert shell.mirage("file /dev/zero") == (
        "/dev/zero: character special (1/5)\n"
    )
    assert shell.mirage("du /dev/zero") == "0\t/dev/zero\n"
    assert shell.mirage("find /dev/null -printf '%m %M\\n'") == (
        "666 crw-rw-rw-\n"
    )
    assert shell.mirage("stat -c '%a %f' /dev/null") == "666 21b6\n"


def test_device_numbers_survive_dropped_write_metadata(shell):
    assert shell.mirage("echo ignored > /dev/zero") == ""
    long_zero = shell.mirage("ls -l /dev/zero")
    assert long_zero.startswith("crw-rw-rw-")
    assert "1, 5" in long_zero


def test_dev_nodes_do_not_satisfy_regular_file_size_tests(shell):
    assert shell.mirage("test -f /dev/null; echo $?") == "1\n"
    assert shell.mirage("test -c /dev/null; echo $?") == "0\n"
    assert shell.mirage("test -s /dev/zero; echo $?") == "1\n"


def test_recursive_search_skips_devices(shell):
    shell.create_file("needle.txt", b"needle\n")
    code, stdout, stderr = shell.mirage_result("grep -r needle /")
    assert code == 0
    assert "/data/needle.txt:needle\n" in stdout
    assert "/dev/zero" not in stderr
    code, stdout, stderr = shell.mirage_result("rg needle /")
    assert code == 0
    assert "/data/needle.txt:needle\n" in stdout
    assert "/dev/zero" not in stderr


def test_whole_read_commands_refuse_endless_zero_device(shell):
    commands = (
        "cp /dev/zero /data/out",
        "source /dev/zero",
        "md5 /dev/zero",
        "grep needle /dev/zero",
        "rg needle /dev/zero",
    )
    for command in commands:
        code, _, stderr = shell.mirage_result(command)
        assert code != 0
        assert "cannot read an endless device without a size" in stderr


def test_dev_null_is_a_char_device_not_a_regular_file(shell):
    # A char device exists and passes -c/-e, but not -f (regular file).
    assert shell.mirage("if [ -e /dev/null ]; then echo yes; fi") == "yes\n"
    assert shell.mirage("if [ -c /dev/null ]; then echo yes; fi") == "yes\n"
    assert (
        shell.mirage("if [ -f /dev/null ]; then echo yes; else echo no; fi")
        == "no\n"
    )


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
