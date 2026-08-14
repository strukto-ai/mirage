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

from mirage.utils.quote import (SHELL_QUOTED_COMMANDS, needs_shell_quote,
                                quotes_operands, shell_quote,
                                shell_quote_always)

# Every printable ASCII character, classified by whether GNU coreutils 9.7
# quotes a name holding it. Probed one byte at a time on debian:stable-slim
# with `cat -- a<c>b`; the four position-dependent characters (#, ~, {, })
# are covered separately below.
TRIGGERS = " !\"$&'()*:;<=>?[\\^`|"
BARE = "%+,-./0123456789@ABCXYZ]_abcxyz"


@pytest.mark.parametrize("char", list(TRIGGERS))
def test_special_character_forces_quoting(char):
    assert needs_shell_quote(f"a{char}b")
    assert shell_quote(f"a{char}b") != f"a{char}b"


@pytest.mark.parametrize("char", list(BARE))
def test_ordinary_character_stays_bare(char):
    assert not needs_shell_quote(f"a{char}b")
    assert shell_quote(f"a{char}b") == f"a{char}b"


@pytest.mark.parametrize("char", ["#", "~"])
def test_comment_and_tilde_are_special_only_first(char):
    assert shell_quote(f"{char}nope") == f"'{char}nope'"
    assert shell_quote(f"no{char}pe") == f"no{char}pe"


@pytest.mark.parametrize("char", ["{", "}"])
def test_brace_is_special_only_alone(char):
    assert shell_quote(char) == f"'{char}'"
    assert shell_quote(f"{char}a") == f"{char}a"
    assert shell_quote(f"a{char}") == f"a{char}"


def test_plain_name_is_reported_as_typed():
    assert shell_quote("nope.txt") == "nope.txt"
    assert shell_quote("/data/nope.txt") == "/data/nope.txt"


def test_glob_operand_is_quoted():
    assert shell_quote("/data/*.txt") == "'/data/*.txt'"
    assert shell_quote("a b") == "'a b'"


def test_single_quote_switches_to_double_quotes():
    assert shell_quote("a'b") == '"a\'b"'
    assert shell_quote("a'b c") == '"a\'b c"'
    assert shell_quote("a'b:c") == '"a\'b:c"'


def test_single_quote_falls_back_when_another_special_rules_it_out():
    assert shell_quote("a'b*c") == "'a'\\''b*c'"
    assert shell_quote("a'b\"c") == "'a'\\''b\"c'"
    assert shell_quote("a'b#c") == "'a'\\''b#c'"


def test_control_characters_render_as_dollar_escape_groups():
    assert shell_quote("a\tb") == "'a'$'\\t''b'"
    assert shell_quote("a\t\tb") == "'a'$'\\t\\t''b'"
    assert shell_quote("\ta") == "''$'\\t''a'"
    assert shell_quote("a\t") == "'a'$'\\t'"
    assert shell_quote("a\x01b") == "'a'$'\\001''b'"
    assert shell_quote("a\x7fb") == "'a'$'\\177''b'"


def test_quote_after_escape_group_reopens_once():
    # The closing quote of the $'...' group doubles as the one a '\'' needs,
    # so GNU emits `'x'$'\t'\''y'` and not a redundant `''` between them.
    assert shell_quote("x\t'y") == "'x'$'\\t'\\''y'"


def test_empty_name_is_reported_as_empty_quotes():
    # Unquoted it would vanish from the line, taking the answer to "which
    # name failed" with it, so GNU quotes it under both policies.
    assert needs_shell_quote("")
    assert shell_quote("") == "''"
    assert shell_quote_always("") == "''"


@pytest.mark.parametrize("char", [
    "\u00a0",
    "\u00ad",
    "\u200b",
    "\ufeff",
    "\U0001f600",
])
def test_printable_non_ascii_is_ordinary(char):
    # Deliberate divergence from GNU in the C locale, which renders every
    # byte in octal; this is GNU under a UTF-8 locale, which mirage models
    # because a virtual path is a string, not a byte sequence. NBSP, a
    # soft hyphen, ZWSP, a BOM and an emoji are all printable to glibc, so
    # none of them even forces the quotes.
    assert shell_quote(f"a{char}b") == f"a{char}b"


def test_printable_non_ascii_never_forces_quotes():
    assert shell_quote("caf\u00e9.txt") == "caf\u00e9.txt"
    assert shell_quote("\u4e2d \u6587") == "'\u4e2d \u6587'"
    assert shell_quote("a'b\u4e2d") == '"a\'b\u4e2d"'


@pytest.mark.parametrize("char,octal", [
    ("\u0080", "\\302\\200"),
    ("\u0085", "\\302\\205"),
    ("\u009f", "\\302\\237"),
    ("\u2028", "\\342\\200\\250"),
    ("\u2029", "\\342\\200\\251"),
])
def test_non_printing_unicode_escapes_its_utf8_bytes(char, octal):
    # The C1 controls and the two line/paragraph separators are what
    # glibc's iswprint refuses in a UTF-8 locale, and GNU escapes bytes,
    # not code points.
    assert shell_quote(f"a{char}b") == f"'a'$'{octal}''b'"


def test_always_quotes_even_an_ordinary_name():
    assert shell_quote_always("nope.txt") == "'nope.txt'"
    assert shell_quote_always("a~b") == "'a~b'"
    assert shell_quote_always("a'b") == '"a\'b"'
    assert shell_quote_always("/data/*.txt") == "'/data/*.txt'"


def test_quotes_operands_reads_the_table():
    assert quotes_operands("cat")
    assert quotes_operands("wc")
    assert quotes_operands("head")
    assert quotes_operands("sort")
    assert not quotes_operands("grep")
    assert not quotes_operands("sed")
    assert not quotes_operands("rev")


def test_never_quoting_commands_stay_out_of_the_table():
    # GNU prints these operands bare: grep/sed/cmp/diff have their own
    # diagnostics, rev is util-linux, md5 is BSD and zcat is gzip. The rest
    # are nobody's coreutils and keep their own original's wording.
    for name in ("grep", "sed", "cmp", "diff", "rev", "md5", "zcat", "awk",
                 "column", "file", "iconv", "jq", "look", "xxd"):
        assert name not in SHELL_QUOTED_COMMANDS
