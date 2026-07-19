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

CASES = [
    ("echo {a,b,c}", "a b c\n"),
    ("echo x{a,b}y", "xay xby\n"),
    ("echo {a,b}.txt", "a.txt b.txt\n"),
    ("echo a{,b}c", "ac abc\n"),
    ("echo {,x}", "x\n"),
    ("echo a{,}b", "ab ab\n"),
    ("echo {a,b}{1,2}", "a1 a2 b1 b2\n"),
    ("echo {a,b,c}{1,2}", "a1 a2 b1 b2 c1 c2\n"),
    ("echo {1..5}", "1 2 3 4 5\n"),
    ("echo {5..1}", "5 4 3 2 1\n"),
    ("echo {-2..2}", "-2 -1 0 1 2\n"),
    ("echo {1..9..2}", "1 3 5 7 9\n"),
    ("echo {9..1..2}", "9 7 5 3 1\n"),
    ("echo {1..9..-2}", "1 3 5 7 9\n"),
    ("echo {01..10}", "01 02 03 04 05 06 07 08 09 10\n"),
    ("echo {001..5}", "001 002 003 004 005\n"),
    ("echo {01..10..3}", "01 04 07 10\n"),
    ("echo {-05..5..5}", "-05 000 005\n"),
    ("echo {3..3}", "3\n"),
    ("echo {a..e}", "a b c d e\n"),
    ("echo {e..a}", "e d c b a\n"),
    ("echo {a..i..2}", "a c e g i\n"),
    ("echo {A..D}", "A B C D\n"),
    ("echo {c..c}", "c\n"),
    ("echo {a,{b,c}}", "a b c\n"),
    ("echo x{a,{1,2}b}y", "xay x1by x2by\n"),
    ("echo {a,{1..3}}", "a 1 2 3\n"),
    ("echo {{a,b},{c,{d,e}}}", "a b c d e\n"),
    ("echo {a,{,}}", "a\n"),
    ("echo {a}", "{a}\n"),
    ("echo {}", "{}\n"),
    ("echo {a,b", "{a,b\n"),
    ("echo a,b}", "a,b}\n"),
    ("echo {a..}", "{a..}\n"),
    ("echo {1..b}", "{1..b}\n"),
    ("echo {1..5..x}", "{1..5..x}\n"),
    ("echo {abc}", "{abc}\n"),
    ("echo {aa..bb}", "{aa..bb}\n"),
    ("echo {1...3}", "{1...3}\n"),
    ('echo "{a,b}"', "{a,b}\n"),
    ("echo '{a,b}'", "{a,b}\n"),
    ("echo \\{a,b\\}", "{a,b}\n"),
    ("echo {a\\,b}", "{a,b}\n"),
    ('echo {a,"b c"}', "a b c\n"),
    ("echo {a,'x y'}z", "az x yz\n"),
    ("bv1=Z; echo {a,$bv1}", "a Z\n"),
    ("bn1=3; echo {1..$bn1}", "{1..3}\n"),
    ("echo {a,$(echo q)}", "a q\n"),
    ("bv2=V; echo ${bv2}{1,2}", "V1 V2\n"),
    ("echo cp file.{txt,bak}", "cp file.txt file.bak\n"),
    ("echo {a,b\\ c}", "a b c\n"),
    ("echo pre{a,b} post{1,2}", "prea preb post1 post2\n"),
    ("for bi1 in {1..3}; do echo n$bi1; done", "n1\nn2\nn3\n"),
    ("bn2=5; echo {1..n}", "{1..n}\n"),
    ("ba1=({x,y}.md); echo ${ba1[1]}", "y.md\n"),
]


@pytest.mark.parametrize("cmd,expected", CASES)
def test_brace_expansion(shell, cmd, expected):
    assert shell.mirage(cmd) == expected


def test_brace_then_glob(shell):
    shell.create_file("ga1.txt", b"x\n")
    shell.create_file("ga2.txt", b"y\n")
    shell.create_file("gb1.txt", b"z\n")
    assert shell.mirage("echo {ga,gb}*") == "ga1.txt ga2.txt gb1.txt\n"
    # A non-matching alternative echoes its literal pattern, like bash.
    assert shell.mirage("echo {ga,zz}*") == "ga1.txt ga2.txt zz*\n"


def test_mkdir_with_braces_creates_each_directory(shell):
    out = shell.mirage("mkdir -p bd/{x,y,z} && ls bd")
    assert out == "x\ny\nz\n"


def test_touch_with_brace_range_creates_each_file(shell):
    out = shell.mirage("touch bf{1..3}.txt && ls")
    assert "bf1.txt" in out and "bf2.txt" in out and "bf3.txt" in out


def test_no_expansion_in_scalar_assignment(shell):
    assert shell.mirage("bv3={a,b}; echo $bv3") == "{a,b}\n"
