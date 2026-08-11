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
from dulwich.objects import Commit

from mirage.commands.cli.builtin.git import format as git_format
from mirage.commands.cli.builtin.git.errors import (BadPrettyError,
                                                    UnsupportedPrettyError)
from mirage.commands.cli.builtin.git.format import (abbrev_length, entry,
                                                    git_date, message_block,
                                                    oneline, short, subject)
from mirage.shell.bytes import encode_text

AUTHOR = b"Dev Person <dev@example.com>"


def _commit(message: bytes,
            timestamp: int = 1768561800,
            offset: int = 0) -> Commit:
    """Build a commit object for rendering tests.

    Args:
        message (bytes): the commit message.
        timestamp (int): author time, epoch seconds.
        offset (int): author timezone, seconds east of UTC.
    """
    commit = Commit()
    commit.tree = b"4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    commit.author = commit.committer = AUTHOR
    commit.author_time = commit.commit_time = timestamp
    commit.author_timezone = commit.commit_timezone = offset
    commit.message = message
    return commit


def test_short_id_is_seven_characters():
    assert short(b"cdd6234342b147880f5d86c55dad6c1fbe222bfe") == "cdd6234"


def test_date_matches_gits_default_format():
    # Pinned against git 2.47.3: the day of the month is not padded,
    # which rules out strftime's %d.
    assert git_date(1768561800, 0) == "Fri Jan 16 11:10:00 2026 +0000"


def test_single_digit_day_is_not_padded():
    # git 2.47.3 prints "Mon Jan 5", not "Mon Jan 05" and not "Jan  5".
    assert git_date(1767603900, 0) == "Mon Jan 5 09:05:00 2026 +0000"


def test_date_renders_in_the_authors_own_offset():
    assert git_date(1768561800, 8 * 3600) == "Fri Jan 16 19:10:00 2026 +0800"


def test_negative_offset_renders_with_a_minus():
    assert git_date(1768561800, -7 * 3600) == "Fri Jan 16 04:10:00 2026 -0700"


def test_subject_is_the_first_line():
    assert subject(_commit(b"first line\n\nbody here\n")) == "first line"


def test_oneline_is_id_then_subject():
    commit = _commit(b"second commit\n")
    assert oneline(commit) == f"{short(commit.id)} second commit"


def test_blank_message_lines_render_as_four_spaces():
    # git indents every line by four, blank ones included, so an empty
    # line inside a message carries trailing whitespace on purpose.
    assert message_block(_commit(b"title\n\nbody\n")) == [
        "    title",
        "    ",
        "    body",
    ]


def test_entry_has_gits_header_block():
    commit = _commit(b"first commit\n")
    assert entry(commit) == [
        f"commit {commit.id.decode()}",
        "Author: Dev Person <dev@example.com>",
        "Date:   Fri Jan 16 11:10:00 2026 +0000",
        "",
        "    first commit",
    ]


def test_a_merge_lists_its_parents_between_id_and_author():
    # git prints `Merge: <short> <short>` for any commit with more than
    # one parent, in both log and show.
    commit = _commit(b"merge side\n")
    commit.parents = [b"a" * 40, b"b" * 40]
    assert entry(commit)[:3] == [
        f"commit {commit.id.decode()}",
        f"Merge: {'a' * 7} {'b' * 7}",
        "Author: Dev Person <dev@example.com>",
    ]


def test_a_single_parent_commit_has_no_merge_line():
    commit = _commit(b"ordinary\n")
    commit.parents = [b"a" * 40]
    assert not any(line.startswith("Merge:") for line in entry(commit))


# Measured against git 2.50.1 by building repositories of each size and
# reading the width off `git log --oneline`. The boundary is sharp, so
# both sides of it are pinned.
@pytest.mark.parametrize("packed,width", [
    (0, 7),
    (3, 7),
    (10102, 7),
    (16383, 7),
    (16384, 8),
    (20102, 8),
    (65535, 8),
    (65536, 9),
    (70102, 9),
    (184401, 9),
])
def test_abbreviation_widens_with_the_object_count(packed, width):
    assert abbrev_length(packed) == width


def test_the_abbreviation_never_drops_below_gits_floor():
    # Two bits of object count would ask for one hex digit; git never
    # prints fewer than seven.
    assert abbrev_length(1) == 7


def test_short_honours_the_width_it_is_given():
    sha = b"cdd6234342b147880f5d86c55dad6c1fbe222bfe"
    assert short(sha, 9) == "cdd623434"


@pytest.mark.parametrize("value,kind,template", [
    ("oneline", "oneline", None),
    ("medium", "medium", None),
    ("fuller", "fuller", None),
    ("format:%H", "format", "%H"),
    ("tformat:%H", "tformat", "%H"),
    ("%h %s", "tformat", "%h %s"),
    ("", "tformat", ""),
])
def test_parse_pretty_reads_gits_grammar(value, kind, template):
    fmt = git_format.parse_pretty(value)
    assert (fmt.kind, fmt.template) == (kind, template)


def test_parse_pretty_refuses_an_unknown_name_like_git():
    with pytest.raises(BadPrettyError, match="invalid --pretty format: bogus"):
        git_format.parse_pretty("bogus")


def test_parse_pretty_names_real_presets_it_lacks():
    with pytest.raises(UnsupportedPrettyError, match="unsupported"):
        git_format.parse_pretty("raw")


def test_needs_decorations_scans_for_d_placeholders():
    assert git_format.needs_decorations(git_format.parse_pretty("%d"))
    assert git_format.needs_decorations(git_format.parse_pretty("a %D b"))
    assert not git_format.needs_decorations(git_format.parse_pretty("%h %s"))
    # %% consumes both characters, so %%d is a literal percent then text.
    assert not git_format.needs_decorations(git_format.parse_pretty("%%d"))
    assert not git_format.needs_decorations(git_format.MEDIUM)


def test_ident_helpers_split_the_stored_line():
    assert git_format.ident_name(AUTHOR) == "Dev Person"
    assert git_format.ident_email(AUTHOR) == "dev@example.com"
    assert git_format.ident_name(b"nameless") == "nameless"
    assert git_format.ident_email(b"nameless") == ""


def test_render_template_expands_the_placeholder_table():
    commit = _commit(b"subject line\n\nbody text\n")
    rendered = git_format.render_template("%H|%h|%an|%ae|%at|%s|%b|%%|%x41|%n",
                                          commit, 7, None)
    full = commit.id.decode()
    assert rendered == (f"{full}|{full[:7]}|Dev Person|dev@example.com|"
                        f"1768561800|subject line|body text\n|%|A|\n")


def test_render_template_keeps_unknown_placeholders_verbatim():
    commit = _commit(b"one\n")
    assert git_format.render_template("%q %zz %x4", commit, 7,
                                      None) == "%q %zz %x4"


def test_render_template_folds_a_multiline_subject_paragraph():
    commit = _commit(b"line one\nline two\n\nbody\n")
    assert git_format.render_template("%s", commit, 7,
                                      None) == "line one line two"


def test_render_template_reads_decorations_from_the_table():
    commit = _commit(b"one\n")
    decor = {commit.id: ["HEAD -> main", "tag: v1"]}
    assert git_format.render_template("%d", commit, 7,
                                      decor) == " (HEAD -> main, tag: v1)"
    assert git_format.render_template("%D", commit, 7,
                                      decor) == "HEAD -> main, tag: v1"
    assert git_format.render_template("%d", commit, 7, {}) == ""


def test_preset_blocks_shape_their_headers():
    commit = _commit(b"subject\n\nbody\n")
    short_lines = git_format.preset_block(commit, "short", 7)
    assert short_lines[1] == "Author: Dev Person <dev@example.com>"
    assert short_lines[-1] == "    subject"
    full_lines = git_format.preset_block(commit, "full", 7)
    assert full_lines[2] == "Commit: Dev Person <dev@example.com>"
    assert all(not line.startswith("Date:") for line in full_lines)
    fuller_lines = git_format.preset_block(commit, "fuller", 7)
    assert fuller_lines[1].startswith("Author:     ")
    assert fuller_lines[2].startswith("AuthorDate: ")
    assert fuller_lines[3].startswith("Commit:     ")
    assert fuller_lines[4].startswith("CommitDate: ")
    assert git_format.preset_block(commit, "medium", 7) == entry(commit, 7)


def test_render_template_names_raw_bytes_with_x():
    # %xHH is a byte, not a code point: %x80 must reach the wire as the
    # single byte 0x80, riding the shell's surrogate-escape convention.
    commit = _commit(b"subject\n")
    rendered = git_format.render_template("a%x80b%x00c", commit, 7, None)
    assert rendered == "a\udc80b\x00c"
    assert encode_text(rendered) == b"a\x80b\x00c"
