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

from mirage.commands.cli.builtin.git import ref_format
from mirage.commands.cli.builtin.git.errors import (
    FormatUsageError,
    GitError,
    UnparsableFormatError,
)
from mirage.commands.cli.builtin.git.types import (
    DateMode,
    QuoteStyle,
    RefContext,
    RefItem,
    RefKind,
    RefObject,
)
from mirage.shell.bytes import encode_text


def _commit(when: int, subject: str) -> RefObject:
    """A commit object with one date and subject.

    Args:
        when (int): the committer timestamp.
        subject (str): the message.
    """
    return RefObject(
        oid=f"{when:040d}",
        type="commit",
        raw=f"tree {'t' * 40}\n"
        f"author A <a@x> {when} +0000\n"
        f"committer C <c@x> {when} +0000\n\n"
        f"{subject}\n".encode(),
    )


BLOB = RefObject(oid="b" * 40, type="blob", raw=b"x")
ITEMS = [
    RefItem(
        name="refs/heads/a",
        oid="1" * 40,
        kind=RefKind.BRANCH,
        obj=_commit(300, "three"),
    ),
    RefItem(
        name="refs/heads/b",
        oid="2" * 40,
        kind=RefKind.BRANCH,
        obj=_commit(100, "one"),
    ),
    RefItem(name="refs/tags/blob", oid="b" * 40, kind=RefKind.TAG, obj=BLOB),
    RefItem(
        name="refs/tags/c",
        oid="3" * 40,
        kind=RefKind.TAG,
        obj=_commit(300, "tie"),
    ),
]
CTX = RefContext(date=DateMode(now=0))


def _run(
    template: str, keys: tuple[str, ...] | None = ("refname",), **kwargs
) -> tuple[str, str | None]:
    """Format the fixture refs, returning what printed and the refusal.

    Args:
        template (str): the format.
        keys (tuple[str, ...] | None): sort keys in line order.
    """
    out, stopped = ref_format.format_refs(
        ref_format.parse_format(template),
        kwargs.pop("items", ITEMS),
        CTX,
        ref_format.parse_sort_keys(keys) if keys else None,
        **kwargs,
    )
    return out, None if stopped is None else str(stopped)


@pytest.mark.parametrize(
    "text,expected",
    [
        ("100%%", "100%"),
        ("%41%2x", "A%2x"),
        ("50% off", "50% off"),
        ("%", "%"),
    ],
)
def test_literal_text_expands_percent_escapes(text, expected):
    assert ref_format.literal_text(text) == expected


def test_a_hex_escape_names_a_raw_byte():
    assert encode_text(ref_format.literal_text("%ff%00")) == b"\xff\x00"


def test_a_quoted_percent_never_opens_a_field():
    fmt = ref_format.parse_format("%%(refname)")
    assert fmt.pieces == ("%(refname)",)


def test_an_unclosed_field_is_a_usage_error_or_a_listing_fatal():
    with pytest.raises(FormatUsageError) as info:
        ref_format.parse_format("x %(refname")
    assert str(info.value) == "malformed format string %(refname"
    with pytest.raises(UnparsableFormatError) as listing:
        ref_format.listing_format("x %(refname")
    assert str(listing.value) == (
        "malformed format string %(refname\n"
        "fatal: unable to parse format string"
    )


def test_rest_and_bare_raw_are_refused_by_the_format():
    with pytest.raises(GitError) as info:
        ref_format.parse_format("%(rest)")
    assert str(info.value) == "this command reject atom %(rest)"
    with pytest.raises(GitError) as quoted:
        ref_format.parse_format("%(raw)", QuoteStyle.SHELL)
    assert str(quoted.value) == (
        "--format=raw cannot be used with --python, --shell, --tcl"
    )
    assert ref_format.parse_format("%(raw)", QuoteStyle.PERL).pieces


def test_the_last_sort_key_given_sorts_first():
    keys = ref_format.parse_sort_keys(
        ["refname", "-v:objecttype", "version:tag"]
    )
    assert [(k.field.name, k.reverse, k.version) for k in keys] == [
        ("tag", False, True),
        ("objecttype", True, True),
        ("refname", False, False),
    ]


@pytest.mark.parametrize("key", ["refname:short", "refname:lstrip=2"])
def test_transformed_names_are_sorted_before_applying_count(key):
    items = [
        RefItem(name="refs/heads/main", oid="1" * 40, kind=RefKind.BRANCH),
        RefItem(name="refs/tags/base", oid="2" * 40, kind=RefKind.TAG),
    ]
    assert _run("%(refname)", ("refname", key), items=items, count=1) == (
        "refs/tags/base\n",
        None,
    )
    assert _run("%(refname)", (key,), items=items, count=1) == (
        "refs/heads/main\n",
        None,
    )


def test_a_prerelease_suffix_sorts_before_its_release():
    assert ref_format.versioncmp("v2.0-rc1", "v2.0", ("-rc",)) < 0
    assert ref_format.versioncmp("v2.0", "v2.0-rc1", ("-rc",)) > 0


@pytest.mark.parametrize(
    "style,expected",
    [
        (QuoteStyle.SHELL, "'it'\\''s'\\!''\\!''"),
        (QuoteStyle.PERL, "'it\\'s!\\\\'"),
        (QuoteStyle.PYTHON, "'it\\'s!\\\\\\n'"),
        (QuoteStyle.TCL, '"it\'s!\\\\\\n\\$"'),
    ],
)
def test_each_quote_style(style, expected):
    text = {
        QuoteStyle.SHELL: "it's!!",
        QuoteStyle.PERL: "it's!\\",
        QuoteStyle.PYTHON: "it's!\\\n",
        QuoteStyle.TCL: "it's!\\\n$",
    }[style]
    assert ref_format.quote_text(text, style) == expected


def test_keys_sort_with_names_breaking_ties_unreversed():
    out, _ = _run("%(refname)", ("-committerdate",))
    assert out == ("refs/heads/a\nrefs/tags/c\nrefs/heads/b\nrefs/tags/blob\n")


def test_a_numeric_key_and_count_and_omit_empty():
    out, _ = _run(
        "%(if)%(subject)%(then)%(subject)%(end)",
        ("objectsize",),
        count=3,
        omit_empty=True,
    )
    # The count takes the empty blob row too, as git's does.
    assert out == "one\ntie\n"


def test_blocks_nest_and_quote_as_a_whole():
    fmt = ref_format.parse_format(
        "%(if:equals=blob)%(objecttype)%(then)[%(align:6,right)"
        "%(refname:lstrip=2)%(end)]%(else)%(subject)%(end)",
        QuoteStyle.SHELL,
    )
    rows, _ = ref_format.format_refs(fmt, ITEMS[1:3], CTX, None)
    assert rows == "'one'\n'[  blob]'\n"


@pytest.mark.parametrize(
    "template,message",
    [
        ("%(then)", "format: %(then) atom used without a %(if) atom"),
        ("%(else)", "format: %(else) atom used without a %(if) atom"),
        ("%(end)", "format: %(end) atom used without corresponding atom"),
        ("%(if)", "format: %(end) atom missing"),
        ("%(if)%(end)", "format: %(if) atom used without a %(then) atom"),
        ("%(if)%(else)", "format: %(else) atom used without a %(then) atom"),
        ("%(if)x%(then)y%(then)", "format: %(then) atom used more than once"),
        (
            "%(if)x%(then)y%(else)z%(else)",
            "format: %(else) atom used more than once",
        ),
        (
            "%(if)x%(then)y%(else)z%(then)",
            "format: %(then) atom used more than once",
        ),
    ],
)
def test_blocks_that_do_not_nest_are_refused(template, message):
    assert _run(template) == ("", message)


def test_a_streamed_listing_stops_where_a_field_fails():
    out, stopped = _run(
        "%(refname) %(authordate:bogus)", items=[ITEMS[2], ITEMS[0]]
    )
    assert (out, stopped) == ("refs/tags/blob \n", "unknown date format bogus")


def test_a_sorted_listing_fails_before_it_prints():
    out, stopped = _run(
        "%(refname) %(authordate:bogus)",
        ("-refname",),
        items=[ITEMS[2], ITEMS[0]],
    )
    assert (out, stopped) == ("", "unknown date format bogus")


def test_a_detached_head_leads_when_asked():
    head = RefItem(
        name="HEAD", oid="1" * 40, kind=RefKind.DETACHED, obj=_commit(1, "x")
    )
    out, _ = _run(
        "%(refname)",
        ("-refname",),
        items=[*ITEMS[:2], head],
        detached_first=True,
        stream=False,
    )
    assert out.splitlines()[0] == ""
