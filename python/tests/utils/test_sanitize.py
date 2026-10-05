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

from mirage.utils.sanitize import (
    ESCAPE_LEAD,
    NAME_MAX_BYTES,
    SAFE_SLASH,
    byte_length,
    is_blank,
    path_safe_name,
    sanitize_label,
    sanitize_name,
)


def test_sanitize_label_replaces_unsafe_and_spaces():
    assert (
        sanitize_label("Hello World", fallback="X", max_len=100)
        == "Hello_World"
    )
    assert (
        sanitize_label("My/Doc: A\\Test", fallback="X", max_len=100)
        == "My_Doc_A_Test"
    )


def test_sanitize_label_collapses_and_trims_underscores():
    assert (
        sanitize_label("Hello   //  World", fallback="X", max_len=100)
        == "Hello_World"
    )
    assert sanitize_label("__edge__", fallback="X", max_len=100) == "edge"


def test_sanitize_label_uses_fallback_for_blank():
    assert sanitize_label("", fallback="Untitled", max_len=100) == "Untitled"
    assert (
        sanitize_label("   ", fallback="No_Subject", max_len=80)
        == "No_Subject"
    )


def test_sanitize_label_ellipsizes_past_budget():
    result = sanitize_label("x" * 120, fallback="X", max_len=100)
    assert len(result) == 100
    assert result.endswith("...")
    assert sanitize_label("x" * 100, fallback="X", max_len=100) == "x" * 100


def test_sanitize_label_keeps_non_ascii_letters():
    # `\w` is unicode-aware in python, and the shared typescript regex spells
    # the same class as `\p{L}\p{N}_`. The per-backend copies this replaced
    # used a javascript `\w`, which is ascii-only and turned a CJK title into
    # a row of underscores.
    assert (
        sanitize_label("日本語の文書", fallback="X", max_len=100)
        == "日本語の文書"
    )
    assert (
        sanitize_label("Café Notes", fallback="X", max_len=100) == "Café_Notes"
    )


def test_sanitize_label_budget_counts_code_points():
    # The typescript twin measured `String.length`, which counts UTF-16 units:
    # 50 ascii plus 26 astral letters reads as 102 there and 76 here. This is
    # the input that made it truncate a label python leaves whole.
    label = "a" * 50 + "\U00010400" * 26
    assert sanitize_label(label, fallback="X", max_len=100) == label


def test_sanitize_label_ellipsizes_on_code_point_boundary():
    # A byte budget wide enough to stay out of the way, so this pins the
    # character budget alone.
    label = "\U00010400" * 120
    result = sanitize_label(label, fallback="X", max_len=100, max_bytes=10_000)
    assert len(result) == 100
    assert result.endswith("...")
    assert "\ufffd" not in result


def test_sanitize_label_honors_the_byte_ceiling_within_the_char_budget():
    # 100 astral code points is 400 bytes, so a name the character budget
    # accepts is one ext4 and APFS reject with ENAMETOOLONG. The default
    # budget is NAME_MAX, and the cut still lands on a code-point boundary.
    label = "\U00010400" * 120
    result = sanitize_label(label, fallback="X", max_len=100)
    assert len(result) < 100
    assert byte_length(result) <= NAME_MAX_BYTES
    assert result.endswith("...")
    assert "\ufffd" not in result


def test_sanitize_label_byte_budget_is_the_callers_remaining_room():
    # What the gdocs/gmail filenames pass: NAME_MAX minus the id, the
    # separators and the suffix.
    result = sanitize_label(
        "会" * 200, fallback="X", max_len=100, max_bytes=60
    )
    assert byte_length(result) <= 60
    assert result.endswith("...")
    assert "\ufffd" not in result


def test_sanitize_label_drops_the_ellipsis_when_it_cannot_fit():
    # Three dots and nothing is not a name; a budget this small yields
    # whatever of the label actually fits.
    assert (
        sanitize_label("abcdef", fallback="X", max_len=100, max_bytes=2)
        == "ab"
    )


def test_path_safe_name_renders_a_slash_as_the_shared_stand_in():
    # Every backend that renders an API name as a path segment emits this
    # one character for ``/``, and the codec that inverts the rendering
    # imports it from here rather than copying the literal.
    assert SAFE_SLASH == "\u2215"
    assert path_safe_name("a/b") == f"a{SAFE_SLASH}b"


def test_path_safe_name_leads_a_dot_led_name_with_the_escape():
    # The hierarchy classifies a dot-led segment as hidden: it is dropped
    # from every listing and refused as a path. A name that starts with a
    # dot therefore carries the escape lead, which the segment codec reads
    # as "the next character is literal".
    assert ESCAPE_LEAD == "\u2044"
    assert path_safe_name(".env") == f"{ESCAPE_LEAD}.env"
    assert path_safe_name("..") == f"{ESCAPE_LEAD}.."
    assert path_safe_name("./x") == f"{ESCAPE_LEAD}.{SAFE_SLASH}x"
    assert path_safe_name("a.b") == "a.b"
    assert path_safe_name(" ") == "unknown"


def test_is_blank_is_the_white_space_property_in_both_languages():
    # ``str.strip`` also eats U+001C..U+001F and JavaScript's ``trim`` eats
    # U+FEFF but not U+0085, so the same value was blank in one runtime and
    # spelled in the other. Blank is Unicode's White_Space property, spelled
    # out once here and read by every name sanitizer and the segment codec.
    for blank in ("", " ", "\t\n", "\x85", "\xa0", "\u2028", "\u3000"):
        assert is_blank(blank)
        assert path_safe_name(blank) == "unknown"
        assert sanitize_name(blank) == "unknown"
        assert sanitize_label(blank, fallback="X", max_len=10) == "X"
    for spelled in ("\x1c", "\x1f", "\ufeff", "a", " a "):
        assert not is_blank(spelled)
    assert path_safe_name("\x1c") == "\x1c"


def test_unsafe_chars_read_the_same_white_space_class():
    # ``\\s`` kept U+001C here and U+FEFF in TypeScript, so the two
    # runtimes spelled one label differently; both now replace what is
    # not Unicode White_Space.
    for odd in ("\ufeff", "\x1c", "\x1f"):
        assert sanitize_name(f"a{odd}b") == "a_b"
        assert sanitize_label(f"a{odd}b", fallback="X", max_len=10) == "a_b"
    assert sanitize_name("a\x85b") == "a\x85b"


# Every hierarchy classifier treats a dot-led segment as hidden, so a label
# that rendered one was dropped from its listing and refused as a path; an
# empty one rendered `__<id>`, which no `label__id` slot decodes.
@pytest.mark.parametrize(
    ("raw", "name"),
    [
        (".plan", "plan"),
        ("..", "unknown"),
        (".", "unknown"),
        ("_.env", "env"),
        (" .x", "x"),
        ("..x..", "x.."),
        ("!!!", "unknown"),
        ("🚀🚀", "unknown"),
        ("a.b.", "a.b."),
    ],
)
def test_sanitize_name_is_never_dot_led_or_empty(raw, name):
    assert sanitize_name(raw) == name


@pytest.mark.parametrize(
    ("raw", "label"),
    [
        (".plan", "plan"),
        ("...", "No_Subject"),
        ("!!!", "No_Subject"),
        ("_.x", "x"),
    ],
)
def test_sanitize_label_is_never_dot_led_or_empty(raw, label):
    assert sanitize_label(raw, fallback="No_Subject", max_len=80) == label
