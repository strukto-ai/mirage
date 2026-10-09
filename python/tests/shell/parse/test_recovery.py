import pytest

from mirage.shell import parse
from mirage.shell.helpers import get_parts, get_redirects, get_text
from mirage.shell.types import NodeType as NT

# ── `((` reparse: subshell that immediately opens a subshell ────────


def test_double_open_paren_parses_as_nested_subshells():
    """``((`` lexes as the arithmetic opener; bash reparses, so do we."""
    node = parse("((echo a); echo b)").named_children[0]
    assert node.type == NT.SUBSHELL


def test_double_open_paren_backgrounded():
    assert not parse("((echo s1; echo s2) & wait)").has_error


def test_genuine_arithmetic_command_is_untouched():
    assert not parse("i=1; ((i++)); echo $i").has_error


def test_line_mixing_arithmetic_and_nested_subshell():
    """Each opener is judged on its own span, not on the error region.

    tree-sitter's ERROR swallows the valid ``((i++))`` next to the bad
    opener, so scope alone would split both and silently turn the
    arithmetic into a subshell running ``i++``.
    """
    assert not parse("i=1; ((i++)); ((echo x); echo $i)").has_error


def test_paren_inside_quotes_does_not_confuse_the_scan():
    assert not parse('((echo ")"); echo b)').has_error


def test_two_nested_subshells_on_one_line():
    assert not parse("((echo a); echo b); ((echo c); echo d)").has_error


def test_multibyte_text_before_the_opener_does_not_shift_offsets():
    """tree-sitter reports byte offsets; ``é`` is two bytes in UTF-8."""
    assert not parse("echo é; ((echo a); echo b)").has_error


def test_unrelated_syntax_error_still_reports():
    assert parse("if then").has_error


# tree-sitter-bash 0.25.1 drops a later unbraced `$var` out of its word
# when the name is cut short by a name-terminating character: the `$`
# stays behind as a literal token and the rest splits into a sibling
# word (`/api/$c/$id.json` -> `/api/$c/$` + `id.json`). parse() rebraces
# the orphaned expansion and reparses, so consumers see one whole word.
@pytest.mark.parametrize(
    ("command", "target"),
    [
        ("echo hi > /api/$c/$id.json", "/api/$c/${id}.json"),
        ("echo hi > /api/$c/$id-x", "/api/$c/${id}-x"),
        ("echo hi > /w/$a/$b/$c", "/w/$a/${b}/$c"),
        ("echo hi > ${a}.$b.json", "${a}.${b}.json"),
        ("echo hi > /w/$c/$1.json", "/w/$c/${1}.json"),
        ("echo hi > /w/$c/$12.json", "/w/$c/${1}2.json"),
        ("echo hi > /é💡/$c/$123abc.json", "/é💡/$c/${1}23abc.json"),
        ("echo hi > /w/$c/$_id9.json", "/w/$c/${_id9}.json"),
    ],
)
def test_redirect_target_later_unbraced_var_stays_one_word(command, target):
    node = parse(command).named_children[0]
    assert node.type == NT.REDIRECTED_STATEMENT
    _, redirects = get_redirects(node)
    assert len(redirects) == 1
    assert redirects[0].target == target


def test_word_later_unbraced_var_stays_one_argument():
    cmd = parse("echo /api/$c/$id.json").named_children[0]
    parts = get_parts(cmd)
    assert [get_text(p) for p in parts] == ["echo", "/api/$c/${id}.json"]


def test_assignment_later_unbraced_var_stays_one_assignment():
    # The broken parse split this into an assignment holding
    # `p=/api/$c/$` plus a command named `id.json`.
    node = parse("p=/api/$c/$id.json").named_children[0]
    assert node.type == NT.VARIABLE_ASSIGNMENT
    assert get_text(node) == "p=/api/$c/${id}.json"


@pytest.mark.parametrize(
    ("command", "words"),
    [
        # A `$` bash keeps literal is left alone: no name character follows.
        ("echo a$ b", ["echo", "a$", "b"]),
        ("echo $", ["echo", "$"]),
    ],
)
def test_literal_dollar_words_stay_untouched(command, words):
    cmd = parse(command).named_children[0]
    assert [get_text(p) for p in get_parts(cmd)] == words


@pytest.mark.parametrize(
    ("command", "commands"),
    [
        ("echo a\n\\echo b", [["echo", "a"], ["\\echo", "b"]]),
        ("echo a # c\n\\echo b", [["echo", "a"], ["\\echo", "b"]]),
        ("export a\n\\echo b", [["\\echo", "b"]]),
        ("echo a \\ b \\\tc", [["echo", "a", "\\ b", "\\\tc"]]),
        ("echo a\n\\ b", [["echo", "a"], ["\\ b"]]),
    ],
)
def test_a_backslash_opening_a_word_stays_in_it(command, commands):
    # Pinned against bash 5.2.37: the backslash escapes the word's first
    # character, so the newline before it still ends the command and an
    # escaped blank is the word's own.
    root = parse(command)
    assert [
        [get_text(p) for p in get_parts(node)]
        for node in root.named_children
        if node.type == NT.COMMAND
    ] == commands
