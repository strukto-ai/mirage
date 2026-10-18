import pytest

from mirage.commands.spec.word_choice import (
    WordMatch,
    WordRefusal,
    match_word,
    value_classes,
)

# GNU coreutils 9.4 tables, as the commands that use them declare them.
QUOTING_STYLES = (
    "literal",
    "shell",
    "shell-always",
    "shell-escape",
    "shell-escape-always",
    "c",
    "c-maybe",
    "escape",
    "locale",
    "clocale",
)
LS_TIME = (
    ("atime", "access", "use"),
    ("ctime", "status"),
    ("mtime", "modification"),
    ("birth", "creation"),
)
DU_TIME = (("atime", "access", "use"), ("ctime", "status"))
COLOR = (
    ("always", "yes", "force"),
    ("never", "no", "none"),
    ("auto", "tty", "if-tty"),
)
LS_FORMAT = (
    ("verbose", "long"),
    ("commas",),
    ("horizontal", "across"),
    ("vertical",),
    ("single-column",),
)
LS_SORT = ("none", "time", "size", "extension", "version", "width")


def test_value_classes_takes_a_flat_tuple_as_one_value_per_word():
    assert value_classes(("a", "b")) == (("a",), ("b",))
    assert value_classes((("a", "b"), "c")) == (("a", "b"), ("c",))
    assert value_classes(()) == ()


# `ls --quoting-style=shell` exits 0 although three longer candidates
# start with it, and `ls --color=no` is `never` although `none` does too.
@pytest.mark.parametrize(
    "value,word",
    [
        ("shell", "shell"),
        ("shell-escape", "shell-escape"),
        ("c", "c"),
        ("shell-escape-always", "shell-escape-always"),
    ],
)
def test_an_exact_word_wins_over_being_a_longer_word_s_prefix(value, word):
    assert match_word(value, QUOTING_STYLES) == WordMatch(word)


def test_an_exact_alias_answers_its_canonical_word():
    assert match_word("access", LS_TIME) == WordMatch("atime")
    assert match_word("no", COLOR) == WordMatch("never")


# `ls --sort=non`, `--sort=n`, `--quoting-style=lit`, `=shell-a`, `=loc`.
@pytest.mark.parametrize(
    "value,word",
    [
        ("non", "none"),
        ("n", "none"),
        ("t", "time"),
        ("si", "size"),
        ("e", "extension"),
        ("w", "width"),
    ],
)
def test_an_unambiguous_prefix_answers_the_canonical_word(value, word):
    assert match_word(value, LS_SORT) == WordMatch(word)


@pytest.mark.parametrize(
    "value,word",
    [
        ("shell-a", "shell-always"),
        ("shell-al", "shell-always"),
        ("shell-escape-a", "shell-escape-always"),
    ],
)
def test_a_hyphen_is_an_ordinary_character_in_a_prefix(value, word):
    assert match_word(value, QUOTING_STYLES) == WordMatch(word)


# Ambiguity is decided on VALUES, not on how many words matched:
# `ls -l --time=a` hits atime and access, one value, and exits 0.
@pytest.mark.parametrize(
    "value,word",
    [
        ("a", "atime"),
        ("ac", "atime"),
        ("u", "atime"),
        ("m", "mtime"),
        ("s", "ctime"),
        ("b", "birth"),
        ("cr", "birth"),
        ("ct", "ctime"),
    ],
)
def test_several_words_of_one_value_are_accepted(value, word):
    assert match_word(value, LS_TIME) == WordMatch(word)


def test_three_words_of_one_value_are_accepted():
    assert match_word("n", COLOR) == WordMatch("never")
    assert match_word("a", DU_TIME) == WordMatch("atime")


# `ls -l --time=c` hits ctime and creation, two values, exit 1.
@pytest.mark.parametrize(
    "choices,value",
    [
        (LS_TIME, "c"),
        (COLOR, "a"),
        (LS_FORMAT, "v"),
        (LS_FORMAT, "ver"),
        (QUOTING_STYLES, "l"),
        (QUOTING_STYLES, "s"),
        (QUOTING_STYLES, "shell-e"),
    ],
)
def test_words_spanning_two_values_are_ambiguous(choices, value):
    assert match_word(value, choices) == WordRefusal("ambiguous")


@pytest.mark.parametrize(
    "choices,value",
    [
        (LS_SORT, "zzz"),
        (LS_SORT, "name"),
        (DU_TIME, "m"),
        (QUOTING_STYLES, "shellalways"),
    ],
)
def test_a_word_no_candidate_starts_with_is_invalid(choices, value):
    assert match_word(value, choices) == WordRefusal("invalid")


# `ls --sort=NON`, `=NONE` and `=None` are all `invalid argument`, not
# ambiguous and not accepted: strncmp is case-sensitive.
@pytest.mark.parametrize("value", ["NON", "NONE", "None", "N"])
def test_prefix_matching_is_case_sensitive(value):
    assert match_word(value, LS_SORT) == WordRefusal("invalid")


def test_the_empty_word_is_ambiguous_by_the_ordinary_rule():
    """`ls --sort=` is `ambiguous argument ''` with no empty-word branch.

    `""` is a prefix of every candidate, so it matches all of them and
    is refused only because they span more than one value. A table whose
    words all mean one value therefore ACCEPTS it, which is what a
    special case for `""` would get wrong.
    """
    assert match_word("", LS_SORT) == WordRefusal("ambiguous")
    assert match_word("", LS_TIME) == WordRefusal("ambiguous")
    assert match_word("", ("only",)) == WordMatch("only")
    assert match_word("", (("quiet", "silent"),)) == WordMatch("quiet")


def test_no_candidate_at_all_is_invalid_even_for_the_empty_word():
    assert match_word("", ()) == WordRefusal("invalid")
    assert match_word("x", ()) == WordRefusal("invalid")
