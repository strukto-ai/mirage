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


def test_sed_substitute(env):
    data = b"hello world\n"
    assert env.mirage("sed s/hello/bye/",
                      stdin=data) == env.native("sed s/hello/bye/", stdin=data)


def test_sed_global(env):
    data = b"foo boo\n"
    assert env.mirage("sed s/o/0/g", stdin=data) == env.native("sed s/o/0/g",
                                                               stdin=data)


def test_sed_first_only(env):
    data = b"foo boo\n"
    assert env.mirage("sed s/o/0/", stdin=data) == env.native("sed s/o/0/",
                                                              stdin=data)


def test_sed_delete_line(env):
    data = b"a\nb\nc\n"
    assert env.mirage("sed 2d", stdin=data) == env.native("sed 2d", stdin=data)


def test_sed_delete_regex(env):
    data = b"foo\nbar\nfoo2\n"
    assert env.mirage("sed /foo/d", stdin=data) == env.native("sed /foo/d",
                                                              stdin=data)


def test_sed_on_file(env):
    env.create_file("f.txt", b"hello world\n")
    assert env.mirage("sed s/hello/bye/ /data/f.txt") == env.native(
        "sed s/hello/bye/ f.txt")


def test_sed_n_suppress(env):
    data = b"a\nb\nc\n"
    assert env.mirage("sed -n p", stdin=data) == env.native("sed -n p",
                                                            stdin=data)


def test_sed_n_with_address(env):
    data = b"a\nb\nc\n"
    assert env.mirage("sed -n 2p", stdin=data) == env.native("sed -n 2p",
                                                             stdin=data)


def test_sed_n_range(env):
    data = b"a\nb\nc\nd\ne\n"
    assert env.mirage("sed -n 2,4p", stdin=data) == env.native("sed -n 2,4p",
                                                               stdin=data)


def test_sed_n_regex_address(env):
    data = b"hello\nworld\nhello again\n"
    assert env.mirage("sed -n /hello/p",
                      stdin=data) == env.native("sed -n /hello/p", stdin=data)


def test_sed_n_on_file(env):
    env.create_file("f.txt", b"a\nb\nc\nd\ne\n")
    assert env.mirage("sed -n 2,3p /data/f.txt") == env.native(
        "sed -n 2,3p f.txt")


def test_sed_E_extended(env):
    data = b"foo123bar\nhello\n"
    assert env.mirage("sed -E 's/[0-9]+/NUM/g'",
                      stdin=data) == env.native("sed -E 's/[0-9]+/NUM/g'",
                                                stdin=data)


def test_sed_E_groups(env):
    data = b"hello world\n"
    assert env.mirage(r"sed -E 's/(hello) (world)/\2 \1/'",
                      stdin=data) == env.native(
                          r"sed -E 's/(hello) (world)/\2 \1/'", stdin=data)


def test_sed_nE_combined(env):
    data = b"abc123\ndef\nghi456\n"
    assert env.mirage("sed -nE '/[0-9]+/p'",
                      stdin=data) == env.native("sed -nE '/[0-9]+/p'",
                                                stdin=data)


def test_sed_i(env):
    env.create_file("f.txt", b"hello world\n")
    env.mirage("sed -i s/hello/bye/ /data/f.txt")
    result = env.mirage("cat /data/f.txt")
    assert "bye" in result


def test_sed_e(env):
    data = b"hello world\n"
    result = env.mirage("sed -e s/hello/bye/", stdin=data)
    assert "bye" in result


def test_sed_numeric_count(env):
    data = b"oooo\n"
    assert env.mirage("sed 's/o/O/2'",
                      stdin=data) == env.native("sed 's/o/O/2'", stdin=data)


def test_sed_p_flag(env):
    data = b"hi\nbye\n"
    assert env.mirage("sed 's/hi/HI/p'",
                      stdin=data) == env.native("sed 's/hi/HI/p'", stdin=data)


def test_sed_n_p_flag(env):
    data = b"hi\nbye\n"
    assert env.mirage("sed -n 's/hi/HI/p'",
                      stdin=data) == env.native("sed -n 's/hi/HI/p'",
                                                stdin=data)


def test_sed_y_transliterate(env):
    data = b"hello\n"
    assert env.mirage("sed 'y/el/ip/'",
                      stdin=data) == env.native("sed 'y/el/ip/'", stdin=data)


def test_sed_c_single_address(env):
    data = b"a\nb\nc\n"
    assert env.mirage("sed '2c\\\nX'",
                      stdin=data) == env.native("sed '2c\\\nX'", stdin=data)


def test_sed_c_range(env):
    data = b"a\nb\nc\nd\n"
    assert env.mirage("sed '2,3c\\\nX'",
                      stdin=data) == env.native("sed '2,3c\\\nX'", stdin=data)


def test_sed_bre_group_backref(env):
    data = b"foo\n"
    assert env.mirage(r"sed 's/\(foo\)/[\1]/'",
                      stdin=data) == env.native(r"sed 's/\(foo\)/[\1]/'",
                                                stdin=data)


def test_sed_bre_interval(env):
    data = b"aaa\n"
    assert env.mirage(r"sed 's/a\{2\}/X/'",
                      stdin=data) == env.native(r"sed 's/a\{2\}/X/'",
                                                stdin=data)


def test_sed_bre_bare_plus_literal(env):
    data = b"a+b\n"
    assert env.mirage("sed 's/a+/X/'",
                      stdin=data) == env.native("sed 's/a+/X/'", stdin=data)


def test_sed_ere_group_plus(env):
    data = b"foo\n"
    assert env.mirage(r"sed -E 's/(foo)/[\1]/'",
                      stdin=data) == env.native(r"sed -E 's/(foo)/[\1]/'",
                                                stdin=data)


def test_sed_ere_alternation(env):
    data = b"dog\n"
    assert env.mirage("sed -E 's/cat|dog/PET/'",
                      stdin=data) == env.native("sed -E 's/cat|dog/PET/'",
                                                stdin=data)


def test_sed_r_alias(env):
    data = b"aaab\n"
    assert env.mirage("sed -r 's/a+/X/'",
                      stdin=data) == env.native("sed -r 's/a+/X/'", stdin=data)


def test_sed_multiple_e(env):
    data = b"a\n"
    assert env.mirage("sed -e 's/a/b/' -e 's/b/c/'",
                      stdin=data) == env.native("sed -e 's/a/b/' -e 's/b/c/'",
                                                stdin=data)


def test_sed_e_with_file(env):
    env.create_file("ef.txt", b"hello world\n")
    assert env.mirage("sed -e s/hello/bye/ /data/ef.txt") == env.native(
        "sed -e s/hello/bye/ ef.txt")


def test_sed_f_script_file(env):
    env.create_file("prog.sed", b"s/hello/HI/\n")
    env.create_file("inf.txt", b"hello world\n")
    assert env.mirage("sed -f /data/prog.sed /data/inf.txt") == env.native(
        "sed -f prog.sed inf.txt")


def test_sed_f_multiple_commands(env):
    env.create_file("prog2.sed", b"s/hello/HI/\ns/world/EARTH/\n")
    env.create_file("inf2.txt", b"hello world\n")
    assert env.mirage("sed -f /data/prog2.sed /data/inf2.txt") == env.native(
        "sed -f prog2.sed inf2.txt")


def test_sed_e_and_f_combined(env):
    env.create_file("prog3.sed", b"s/world/EARTH/\n")
    env.create_file("inf3.txt", b"hello world\n")
    assert env.mirage(
        "sed -e s/hello/HI/ -f /data/prog3.sed /data/inf3.txt") == env.native(
            "sed -e s/hello/HI/ -f prog3.sed inf3.txt")


def test_sed_f_stdin(env):
    env.create_file("prog4.sed", b"s/hello/HI/\n")
    data = b"hello world\n"
    assert env.mirage("sed -f /data/prog4.sed",
                      stdin=data) == env.native("sed -f prog4.sed", stdin=data)


def test_sed_negate_line(env):
    data = b"a\nb\nc\n"
    assert env.mirage("sed '2!d'", stdin=data) == env.native("sed '2!d'",
                                                             stdin=data)


def test_sed_negate_regex(env):
    data = b"a\nb\nc\n"
    assert env.mirage("sed '/b/!d'", stdin=data) == env.native("sed '/b/!d'",
                                                               stdin=data)


def test_sed_missing_final_newline(env):
    data = b"foo"
    assert env.mirage("sed 's/o/O/'", stdin=data) == env.native("sed 's/o/O/'",
                                                                stdin=data)


def test_sed_escaped_delimiter(env):
    data = b"a/b\n"
    assert env.mirage(r"sed 's/a\/b/c/'",
                      stdin=data) == env.native(r"sed 's/a\/b/c/'", stdin=data)
