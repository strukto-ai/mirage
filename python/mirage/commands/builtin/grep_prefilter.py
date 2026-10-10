import re
from dataclasses import dataclass

from mirage.utils.posix import folds_ascii_only

LIMIT = 64
# Long enough for a translated Unicode class: ripgrep's `\b` alone spells
# its word class out four times, some 45,000 characters of host source.
LONGEST = 1 << 18
# The ASCII letters a non-ASCII character matches under python's Unicode
# IGNORECASE (`ı` and `İ` for i, the Kelvin sign for k, `ſ` for s): a
# lowercased byte search for a needle holding one could miss a line.
UNICODE_FOLDED = frozenset("iks")
QUANTIFIER = re.compile(r"[*+?]|\{(?P<least>[0-9]+)(?:,[0-9]*)?\}")
GROUP = re.compile(
    r"\?(?:(?P<look>=|!|<=|<!)|[:>]|P?<[A-Za-z_$][A-Za-z0-9_$]*>)"
)


@dataclass(frozen=True, slots=True)
class Required:
    """What every match of a subexpression consumes: ``literal`` when the
    text is fixed, and ``needles``, one of which it always contains (none
    known when empty)."""

    literal: str | None
    needles: tuple[str, ...]


UNKNOWN = Required(None, ())
EMPTY = Required("", ())


def literal(text: str) -> Required:
    return Required(text, (text,) if text else ())


def strength(part: Required) -> int:
    return min(map(len, part.needles), default=0)


def sequence(left: Required, right: Required) -> Required:
    if left.literal is not None and right.literal is not None:
        return literal(left.literal + right.literal)
    return Required(None, max(left, right, key=strength).needles)


def either(left: Required, right: Required) -> Required:
    if left.literal is not None and left.literal == right.literal:
        return left
    if not left.needles or not right.needles:
        return UNKNOWN
    needles = tuple(dict.fromkeys(left.needles + right.needles))
    return Required(None, needles) if len(needles) <= LIMIT else UNKNOWN


class RequiredLiterals:
    """A bounded partial parser: syntax it does not know disables skipping.

    Args:
        source (str): the host regex source, printable ASCII only.
    """

    def __init__(self, source: str) -> None:
        self.source = source
        self.at = 0
        self.valid = True

    def peek(self) -> str:
        return self.source[self.at : self.at + 1]

    def needles(self) -> tuple[str, ...]:
        required = self.alternation(0)
        if not self.valid or self.at != len(self.source):
            return ()
        return required.needles

    def alternation(self, depth: int) -> Required:
        if depth > LIMIT:
            self.valid = False
            return UNKNOWN
        required = self.concatenation(depth)
        while self.valid and self.peek() == "|":
            self.at += 1
            required = either(required, self.concatenation(depth))
        return required

    def concatenation(self, depth: int) -> Required:
        required = EMPTY
        run: list[str] = []
        while self.valid and self.peek() not in ("", "|", ")"):
            atom = self.quantified(self.atom(depth))
            if atom.literal is not None:
                run.append(atom.literal)
            else:
                required = sequence(
                    sequence(required, literal("".join(run))), atom
                )
                run = []
        return sequence(required, literal("".join(run)))

    def quantified(self, atom: Required) -> Required:
        if self.peek() not in ("*", "+", "?", "{"):
            return atom
        bound = QUANTIFIER.match(self.source, self.at)
        if bound is None:
            self.valid = False
            return UNKNOWN
        self.at = bound.end()
        if self.peek() == "?":
            self.at += 1
        least = bound["least"]
        if bound[0] == "+" or least is not None and int(least) > 0:
            return Required(None, atom.needles)
        return UNKNOWN

    def atom(self, depth: int) -> Required:
        char = self.peek()
        self.at += 1
        if char == "(":
            return self.group(depth)
        if char == "[":
            return self.bracket()
        if char == "\\":
            return self.escape()
        if char == ".":
            return UNKNOWN
        if char in ("^", "$"):
            return EMPTY
        if char in ("*", "+", "?", "{", "}"):
            self.valid = False
            return UNKNOWN
        return literal(char)

    def group(self, depth: int) -> Required:
        """A group's requirement; a lookaround consumes nothing.

        Inline flags, comments, conditionals and named backreferences are
        refused.

        Args:
            depth (int): the nesting depth of the group's parent.
        """
        opener = GROUP.match(self.source, self.at)
        if opener is not None:
            self.at = opener.end()
        elif self.peek() == "?":
            self.valid = False
            return UNKNOWN
        inner = self.alternation(depth + 1)
        if self.peek() != ")":
            self.valid = False
            return UNKNOWN
        self.at += 1
        return EMPTY if opener is not None and opener["look"] else inner

    def bracket(self) -> Required:
        """Step over a bracket expression, which requires no literal.

        A leading ``]`` is a member in Python and closes an empty set in
        JavaScript, and a ``[`` inside is a nested set under JavaScript's
        ``v`` flag, so both are refused rather than guessed.
        """
        if self.peek() == "^":
            self.at += 1
        if self.peek() == "]":
            self.valid = False
            return UNKNOWN
        while self.at < len(self.source):
            member = self.peek()
            self.at += 1
            if member == "]":
                return UNKNOWN
            if member == "[":
                break
            if member == "\\":
                self.at += 1
        self.valid = False
        return UNKNOWN

    def escape(self) -> Required:
        char = self.peek()
        self.at += 1
        if char in ("b", "B", "A", "Z"):
            return EMPTY
        if char in ("d", "D", "s", "S", "w", "W", "n", "r", "t", "f", "v"):
            return UNKNOWN
        if char and not char.isalnum():
            return literal(char)
        self.valid = False
        return UNKNOWN


def folds_by_unicode(pat: re.Pattern[str]) -> bool:
    """Whether ``pat`` ignores case by Unicode folding (``ſ`` matches ``s``).

    Args:
        pat (re.Pattern[str]): the compiled line matcher.
    """
    return bool(pat.flags & re.IGNORECASE) and not folds_ascii_only(pat)


def required_needles(pat: re.Pattern[str]) -> tuple[bytes, ...] | None:
    """Byte literals, one of which every line ``pat`` matches contains.

    Under ``re.IGNORECASE`` they are lowercase, for a search of an
    ASCII-lowercased view. Unicode case folding matches non-ASCII
    spellings of three ASCII letters (``ſ`` for ``s``), which only the
    line matcher can see, so under it a needle holding one of them gives
    the pattern none.

    Args:
        pat (re.Pattern[str]): the compiled line matcher.
    """
    fold = bool(pat.flags & re.IGNORECASE)
    if (
        pat.flags & re.VERBOSE
        or len(pat.pattern) > LONGEST
        or any(not " " <= char <= "~" for char in pat.pattern)
    ):
        return None
    needles = RequiredLiterals(pat.pattern).needles()
    if fold:
        needles = tuple(dict.fromkeys(needle.lower() for needle in needles))
        if folds_by_unicode(pat) and any(
            UNICODE_FOLDED & set(needle) for needle in needles
        ):
            return None
    return tuple(needle.encode("ascii") for needle in needles) or None
