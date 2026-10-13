import math
import re
from typing import NamedTuple

from mirage.concurrency.constants import LOOP_BUDGET

QUANTIFIER = re.compile(r"\{(\d*)(,?)(\d*)\}")
FLAGS = re.compile(r"\(\?([aiLmsux]*)(?:-([imsx]*))?([:)])")
LOOKAROUNDS = ("(?=", "(?!", "(?<=", "(?<!")


class _Shape(NamedTuple):
    """How far a backtracking search of a pattern can branch.

    Args:
        width (int): characters one path matches outside unbounded repeats.
        choices (int): paths through alternation and bounded repeats.
        repeats (int): unbounded repeats, each up to one count per
            subject character.
    """

    width: int
    choices: int
    repeats: int


ZERO_WIDTH = _Shape(0, 1, 0)
ONE_CHAR = _Shape(1, 1, 0)


class _Reader:
    """Read a pattern's source into its search shape, or None.

    None stands for every construct whose backtracking has no bound in
    the subject's length that this reading can state: a backreference, a
    conditional, a repeated group that branches or repeats inside, a
    lookaround that repeats, a verbose group, or anything it does not
    recognize.
    """

    def __init__(self, source: str) -> None:
        self.source = source
        self.pos = 0
        self.depth = 0
        self.branches = 1

    def alternation(self) -> _Shape | None:
        branches: list[_Shape] = []
        while True:
            branch = self.sequence()
            if branch is None:
                return None
            branches.append(branch)
            if not self.source.startswith("|", self.pos):
                break
            self.pos += 1
        if self.depth == 0:
            self.branches = len(branches)
        return _Shape(
            max(b.width for b in branches),
            sum(b.choices for b in branches),
            max(b.repeats for b in branches),
        )

    def sequence(self) -> _Shape | None:
        width, choices, repeats = 0, 1, 0
        while (
            self.pos < len(self.source) and self.source[self.pos] not in "|)"
        ):
            item = self.item()
            if item is None:
                return None
            shape = self.repeated(*item)
            if shape is None:
                return None
            width += shape.width
            choices *= shape.choices
            repeats += shape.repeats
        return _Shape(width, choices, repeats)

    def item(self) -> tuple[_Shape, bool] | None:
        char = self.source[self.pos]
        if char == "(":
            return self.group()
        if char == "[":
            return self.char_class()
        if char == "\\":
            return self.escape()
        if char in "*+?":
            return None
        self.pos += 1
        if char in "^$":
            return ZERO_WIDTH, False
        return ONE_CHAR, True

    def group(self) -> tuple[_Shape, bool] | None:
        source, start = self.source, self.pos
        if source.startswith("(?#", start):
            close = source.find(")", start)
            if close < 0:
                return None
            self.pos = close + 1
            return ZERO_WIDTH, False
        lookaround = source.startswith(LOOKAROUNDS, start)
        if source.startswith(("(?:", "(?>"), start):
            self.pos += 3
        elif source.startswith("(?P<", start):
            close = source.find(">", start)
            if close < 0:
                return None
            self.pos = close + 1
        elif lookaround:
            self.pos += 4 if source.startswith("(?<", start) else 3
        elif source.startswith("(?", start):
            flags = FLAGS.match(source, start)
            if flags is None or "x" in flags.group(1):
                return None
            self.pos = flags.end()
            if flags.group(3) == ")":
                return ZERO_WIDTH, False
        else:
            self.pos += 1
        self.depth += 1
        inner = self.alternation()
        self.depth -= 1
        if inner is None or not source.startswith(")", self.pos):
            return None
        self.pos += 1
        if lookaround:
            if inner.repeats:
                return None
            return _Shape(inner.width, inner.choices, 0), False
        fixed = inner.choices == 1 and inner.repeats == 0 and inner.width > 0
        return inner, fixed

    def char_class(self) -> tuple[_Shape, bool] | None:
        source, end = self.source, self.pos + 1
        if source.startswith("^", end):
            end += 1
        if source.startswith("]", end):
            end += 1
        while end < len(source) and source[end] != "]":
            end += 2 if source[end] == "\\" else 1
        if end >= len(source):
            return None
        self.pos = end + 1
        return ONE_CHAR, True

    def escape(self) -> tuple[_Shape, bool] | None:
        source, start = self.source, self.pos
        if start + 1 >= len(source):
            return None
        char = source[start + 1]
        if char in "123456789g":
            return None
        if char in "AZzbB":
            self.pos += 2
            return ZERO_WIDTH, False
        if char == "N":
            close = source.find("}", start)
            if close < 0:
                return None
            self.pos = close + 1
        else:
            self.pos += {"x": 4, "u": 6, "U": 10}.get(char, 2)
        return ONE_CHAR, True

    def repeated(self, shape: _Shape, repeatable: bool) -> _Shape | None:
        source, start = self.source, self.pos
        if start >= len(source):
            return shape
        char = source[start]
        high: int | None
        if char in "*+?":
            low, high = (1 if char == "+" else 0), (1 if char == "?" else None)
            self.pos += 1
        else:
            bounds = QUANTIFIER.match(source, start) if char == "{" else None
            if bounds is None or bounds.group() == "{}":
                return shape
            low = int(bounds.group(1) or 0)
            high = low
            if bounds.group(3):
                high = int(bounds.group(3))
            elif bounds.group(2):
                high = None
            self.pos = bounds.end()
        if not repeatable:
            return None
        if source.startswith(("?", "+"), self.pos):
            self.pos += 1
        if high is None:
            return _Shape(low * shape.width, 1, 1)
        return _Shape(high * shape.width, high - low + 1, 0)


def _search_cost(shape: _Shape, length: int, anchored: bool) -> int:
    """The steps a search of one subject can take, at most.

    Each start tries every path: up to ``length + 1`` counts per
    unbounded repeat, times the choices, each path walking its width.
    An anchored pattern fails at once past its first start.

    Args:
        shape (_Shape): the pattern's shape.
        length (int): the subject's length.
        anchored (bool): whether only the first start can match.
    """
    counts = math.prod([length + 1] * shape.repeats)
    path = shape.choices * counts * (shape.width + 2)
    return length + 1 + path if anchored else (length + 1) * path


def loop_limit(pattern: re.Pattern[str]) -> int:
    """The longest subject a search of ``pattern`` can run on the loop.

    A subject up to this length has a worst case within ``LOOP_BUDGET``
    steps, so it is searched in place; a longer one, and every subject
    of a pattern whose shape cannot be bounded (-1), goes to a worker.
    The reading is conservative: some shapes that would finish fast
    still take the worker, and a linear-time engine would remove the
    worker for all but backreferences (strukto-ai/mirage#1590).

    Args:
        pattern (re.Pattern[str]): the compiled host pattern.
    """
    if pattern.flags & re.VERBOSE:
        return -1
    reader = _Reader(pattern.pattern)
    shape = reader.alternation()
    if shape is None or reader.pos != len(pattern.pattern):
        return -1
    anchored = (
        not pattern.flags & re.MULTILINE
        and reader.branches == 1
        and pattern.pattern.startswith(("^", "\\A"))
    )
    if _search_cost(shape, 0, anchored) > LOOP_BUDGET:
        return -1
    low, high = 0, LOOP_BUDGET
    while low < high:
        middle = (low + high + 1) // 2
        if _search_cost(shape, middle, anchored) <= LOOP_BUDGET:
            low = middle
        else:
            high = middle - 1
    return low
