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

import re

# The strings glibc's `regerror` produces, which every GNU tool that
# compiles a BRE prints verbatim after its own `<prog>: ` prefix. Measured
# pattern by pattern on glibc 2.39 through BOTH `expr abc : PAT` and
# `nl -b pPAT`, which answer identically, so this is one table and not two.
# They are glibc-specific -- POSIX does not word these, and BSD libc words
# them differently -- so they look unusual on purpose: `expr abc : '\('`
# really does say `Unmatched ( or \(`.
UNMATCHED_OPEN = "Unmatched ( or \\("
UNMATCHED_CLOSE = "Unmatched ) or \\)"
UNMATCHED_BRACE = "Unmatched \\{"
UNMATCHED_BRACKET = "Unmatched [, [^, [:, [., or [="
INVALID_PATTERN = "Invalid regular expression"
TRAILING_BACKSLASH = "Trailing backslash"
BAD_CLASS_NAME = "Invalid character class name"
BAD_COLLATE = "Invalid collation character"
BAD_BRACE_CONTENT = "Invalid content of \\{\\}"
BAD_BACKREF = "Invalid back reference"
BAD_RANGE = "Invalid range end"
TOO_BIG = "Regular expression too big"

# glibc's RE_DUP_MAX. An interval past it is refused by glibc rather than
# handed to the matcher, and both host engines have their own much larger
# ceilings, so the check has to live here for the two to agree.
RE_DUP_MAX = 32767

WORD_CHARS = "0-9A-Za-z_"
SPACE_CHARS = " \\t\\n\\v\\f\\r"

# `LC_ALL=C` expansions of the POSIX class names. expr runs in the C
# locale, so every class is the ASCII set and can be inlined into a host
# bracket expression, which is the only form python `re` and JavaScript
# `RegExp` both understand.
POSIX_CLASSES = {
    "alnum": "0-9A-Za-z",
    "alpha": "A-Za-z",
    "blank": " \\t",
    "cntrl": "\\x00-\\x1f\\x7f",
    "digit": "0-9",
    "graph": "!-~",
    "lower": "a-z",
    "print": " -~",
    "punct": "!-/:-@\\[-`{-~",
    "space": SPACE_CHARS,
    "upper": "A-Z",
    "xdigit": "0-9A-Fa-f",
}

# GNU's `\w`/`\W`/`\s`/`\S` are expanded rather than passed through
# because python's own `\w` is Unicode-aware by default while GNU's is
# ASCII under `LC_ALL=C`. Expanding them also keeps this host and the
# TypeScript twin emitting the same character set instead of each
# inheriting its engine's idea of a word character.
CLASS_ESCAPES = {
    "w": f"[{WORD_CHARS}]",
    "W": f"[^{WORD_CHARS}]",
    "s": f"[{SPACE_CHARS}]",
    "S": f"[^{SPACE_CHARS}]",
}

# The dialect-specific tokens. Three of them differ from the TypeScript
# twin (`bre.ts`), and only one of the three is a real difference:
# python's `$` also matches just before a trailing newline, so a BRE `$`
# anchor has to become `\Z`, where JavaScript's `$` without the `m` flag
# already means end-of-input. `BUFFER_START` and `BUFFER_END` (GNU's
# `\``/`\'`) are spelled `\A`/`\Z` here and `^`/`$` there, which is the
# same thing on both hosts because neither side ever sets the multiline
# flag -- a 20,720-pattern differential over both dialects finds zero
# behavioural difference. A reader should not take either of those two
# for drift.
ANCHOR_START = "^"
ANCHOR_END = "\\Z"
BUFFER_START = "\\A"
BUFFER_END = "\\Z"
WORD_START = f"\\b(?=[{WORD_CHARS}])"
WORD_END = f"\\b(?<=[{WORD_CHARS}])"

OUTSIDE_SPECIAL = "\\^$.|?*+()[]{}"
INSIDE_SPECIAL = "\\]^-["

# An interval body. The low bound is optional, because glibc reads
# `\{,3\}` as `{0,3}` rather than refusing it (measured: `nl -b 'pa\{,3\}'`
# matches, and so does `pa\{,\}`); an entirely empty body is still refused.
# Read with `fullmatch`, never `match`: python's `$` also matches just
# before a trailing newline, so `a\{2<newline>\}` compiled here and was
# refused on TypeScript, where GNU refuses it too
# (`expr aa : 'a\{2<newline>\}'` is `Invalid content of \{\}`).
INTERVAL_RE = re.compile(r"^([0-9]*)(,([0-9]*))?$")

# What an empty bracket expression becomes. An inverted plain-character
# range is not an error in glibc's expr/nl dialect -- `[z-a]` compiles
# and matches nothing, `[^z-a]` compiles and matches any one character --
# but a host `[]` is a syntax error in python and an always-failing set
# in JavaScript, so the two are spelled out instead of left to the
# engine.
MATCHES_NOTHING = "[^\\s\\S]"
MATCHES_ANY_ONE = "[\\s\\S]"

# The bracket items a range endpoint may be. A collating element is one
# (`[[.a.]-z]` compiles); a character class and an equivalence class are
# not (`[[:alpha:]-z]`, `[[=a=]-z]` and `[a-[:alpha:]]` are all
# `Invalid range end`).
RANGE_KINDS = frozenset({"char", "."})


class BreError(Exception):
    """A pattern glibc's regex compiler refuses, worded as it words it."""


def escape_outside(ch: str) -> str:
    """One literal character, safe outside a host bracket expression.

    Args:
        ch (str): the character the BRE means literally.

    Returns:
        str: the character, backslash-escaped when the host engine would
            otherwise read it as an operator.
    """
    return "\\" + ch if ch in OUTSIDE_SPECIAL else ch


def escape_inside(ch: str) -> str:
    """One literal character, safe inside a host bracket expression.

    Args:
        ch (str): the character the BRE means literally.

    Returns:
        str: the character, backslash-escaped when it would otherwise
            close the set, negate it, or open a range.
    """
    return "\\" + ch if ch in INSIDE_SPECIAL else ch


def interval_token(body: str) -> str:
    """The text between `\\{` and `\\}`, re-emitted as a host interval.

    Args:
        body (str): the interval body, without its delimiters.

    Returns:
        str: the host quantifier, e.g. `{2}` or `{1,3}`.

    Raises:
        BreError: the body is not `n`, `n,` or `n,m`, the bounds are
            inverted, or a bound is past glibc's RE_DUP_MAX.
    """
    matched = INTERVAL_RE.fullmatch(body)
    if matched is None or body == "":
        raise BreError(BAD_BRACE_CONTENT)
    low = int(matched.group(1) or "0")
    open_ended = matched.group(2) is not None and matched.group(3) == ""
    if matched.group(2) is None:
        high = low
    elif open_ended:
        high = None
    else:
        high = int(matched.group(3))
    if low > RE_DUP_MAX or (high is not None and high > RE_DUP_MAX):
        raise BreError(TOO_BIG)
    if high is None:
        return f"{{{low},}}"
    if high < low:
        raise BreError(BAD_BRACE_CONTENT)
    if matched.group(2) is None:
        return f"{{{low}}}"
    return f"{{{low},{high}}}"


def bracket_item(src: str, i: int) -> tuple[int, str, str]:
    """One member of a bracket expression, read at `i`.

    Answers the value unescaped, because the caller needs it twice and
    wants it differently each time: escaped for the host set, and raw to
    compare against the other end of a range.

    Args:
        src (str): the whole BRE.
        i (int): where the member starts, inside the brackets.

    Returns:
        tuple[int, str, str]: the index just past the member, its kind
            (`char` for an ordinary byte, else the `:`/`.`/`=` of the
            construct it is), and its value -- one character for a byte,
            a collating element or an equivalence class, and the whole
            expanded set for a `[:class:]`.

    Raises:
        BreError: an unterminated construct, a class name that is not a
            POSIX one, or a collating element the C locale has not got.
    """
    after = src[i + 1:i + 2]
    if src[i] == "[" and after in (":", ".", "="):
        close = src.find(after + "]", i + 2)
        if close < 0:
            raise BreError(UNMATCHED_BRACKET)
        name = src[i + 2:close]
        if after == ":":
            expansion = POSIX_CLASSES.get(name)
            if expansion is None:
                raise BreError(BAD_CLASS_NAME)
            return close + 2, after, expansion
        if len(name) != 1:
            raise BreError(BAD_COLLATE)
        return close + 2, after, name
    return i + 1, "char", src[i]


class BreTranslator:
    """A POSIX BRE scanned once and re-emitted in this host's dialect.

    GNU expr compiles its `:` and `match` patterns with
    `RE_SYNTAX_POSIX_BASIC`, where `\\(`, `\\|`, `\\+`, `\\?` and `\\{n\\}`
    are the operators and their bare spellings are literals -- the exact
    inverse of python `re` and JavaScript `RegExp`. Handing the pattern to
    either engine unchanged is wrong for every one of those constructs, so
    it is scanned here and emitted as the host's own syntax. The method
    names are mirrored one for one in `bre.ts` so the two dialects
    cannot drift apart.
    """

    def __init__(self, pattern: str, refuse_inverted_range: bool) -> None:
        self.src = pattern
        self.refuse_inverted_range = refuse_inverted_range
        self.pos = 0
        self.out: list[str] = []
        self.groups = 0
        self.open_groups: list[int] = []
        self.group_starts: list[int] = []
        # Where `^` is the anchor rather than a literal caret: the start
        # of the pattern, just after `\(`, and just after `\|`. Nowhere
        # else, and that is narrower than "nothing precedes": `^^a`
        # matches a line starting `^a`, so the second `^` is a literal
        # although an anchor is all that precedes it.
        self.caret_anchors = True
        # Where the last repeatable atom begins in `out`, or None when
        # there is nothing to repeat: at the start of the pattern, after
        # `\(`, after `\|`, and after an anchor. BRE reads `*` as a
        # literal in exactly those positions, where both host engines
        # instead throw "nothing to repeat".
        self.atom_start: int | None = None
        self.atom_quantified = False

    def translate(self) -> tuple[str, int]:
        """Scan the whole pattern.

        Returns:
            tuple[str, int]: the host pattern source, and how many
                capturing groups it has. The count is what tells `:`
                whether to answer with group 1 or with the match length,
                and it has to survive a failed match, where there is no
                match object to ask.

        Raises:
            BreError: the pattern is one glibc would refuse.
        """
        while self.pos < len(self.src):
            ch = self.src[self.pos]
            if ch == "\\":
                self.escape()
            elif ch == "[":
                self.bracket()
            elif ch == "*":
                self.pos += 1
                self.repeat("*", "*")
            elif ch == ".":
                self.pos += 1
                self.atom(".")
            elif ch == "^":
                self.pos += 1
                if self.caret_anchors:
                    self.anchor(ANCHOR_START)
                else:
                    self.atom(escape_outside("^"))
            elif ch == "$":
                self.pos += 1
                if self.dollar_is_anchor():
                    self.anchor(ANCHOR_END)
                else:
                    self.atom(escape_outside("$"))
            else:
                self.pos += 1
                self.atom(escape_outside(ch))
        if self.open_groups:
            raise BreError(UNMATCHED_OPEN)
        return "".join(self.out), self.groups

    def dollar_is_anchor(self) -> bool:
        """Whether the `$` just consumed was an anchor rather than a char.

        glibc reads `$` as an anchor only at the very end of the pattern
        or immediately before `\\)` or `\\|`; anywhere else it is a
        literal dollar sign, which is why `expr 'a$b' : 'a$b'` is 3.

        Returns:
            bool: True when the `$` anchors.
        """
        if self.pos >= len(self.src):
            return True
        return self.src[self.pos:self.pos + 2] in ("\\)", "\\|")

    def atom(self, text: str) -> None:
        """Emit one repeatable atom.

        Args:
            text (str): the host source for the atom.
        """
        self.atom_start = len(self.out)
        self.out.append(text)
        self.atom_quantified = False
        self.caret_anchors = False

    def anchor(self, text: str) -> None:
        """Emit one anchor, which no quantifier may follow.

        Args:
            text (str): the host source for the anchor.
        """
        self.out.append(text)
        self.atom_start = None
        self.atom_quantified = False
        self.caret_anchors = False

    def repeat(self, token: str, literal: str) -> None:
        """Apply a quantifier to the last atom, or emit it as a literal.

        There is no "nothing to repeat" refusal, because glibc has none:
        every position where it cannot repeat, it re-reads the operator
        as an ordinary character instead. `nl -b 'p*'` matches a literal
        `*`, `p\\+` matches a `+`, and `p\\{1\\}` matches the three bytes
        `{1}` -- all exit 0. Both host engines refuse those patterns
        outright, which is why this arm exists and why glibc's
        `Invalid preceding regular expression` is absent from the table
        at the top of this module: no BRE reaches it.

        Args:
            token (str): the host quantifier to emit.
            literal (str): the character to emit instead when there is
                no atom to repeat.
        """
        start = self.atom_start
        if start is None:
            self.atom(escape_outside(literal))
            return
        if self.atom_quantified:
            # glibc stacks quantifiers (`a**` is `(a*)*`); both host
            # engines reject a bare second one, so the atom is wrapped.
            self.out.insert(start, "(?:")
            self.out.append(")")
        self.out.append(token)
        self.atom_quantified = True

    def escape(self) -> None:
        """Scan one backslash sequence.

        Raises:
            BreError: a trailing backslash, an unbalanced `\\)`, a
                backreference to a group that is not closed yet, or an
                interval glibc would refuse.
        """
        if self.pos + 1 >= len(self.src):
            raise BreError(TRAILING_BACKSLASH)
        ch = self.src[self.pos + 1]
        self.pos += 2
        if ch == "(":
            self.groups += 1
            self.open_groups.append(self.groups)
            self.group_starts.append(len(self.out))
            self.out.append("(")
            self.atom_start = None
            self.atom_quantified = False
            self.caret_anchors = True
        elif ch == ")":
            if not self.open_groups:
                raise BreError(UNMATCHED_CLOSE)
            self.open_groups.pop()
            start = self.group_starts.pop()
            self.out.append(")")
            self.atom_start = start
            self.atom_quantified = False
            self.caret_anchors = False
        elif ch == "|":
            self.out.append("|")
            self.atom_start = None
            self.atom_quantified = False
            self.caret_anchors = True
        elif ch == "+":
            self.repeat("+", "+")
        elif ch == "?":
            self.repeat("?", "?")
        elif ch == "{":
            self.interval()
        elif ch in "123456789":
            if int(ch) > self.groups or int(ch) in self.open_groups:
                raise BreError(BAD_BACKREF)
            self.atom("\\" + ch)
        elif ch in CLASS_ESCAPES:
            self.atom(CLASS_ESCAPES[ch])
        elif ch == "b":
            self.anchor("\\b")
        elif ch == "B":
            self.anchor("\\B")
        elif ch == "<":
            self.anchor(WORD_START)
        elif ch == ">":
            self.anchor(WORD_END)
        elif ch == "`":
            self.anchor(BUFFER_START)
        elif ch == "'":
            self.anchor(BUFFER_END)
        else:
            self.atom(escape_outside(ch))

    def interval(self) -> None:
        """Scan one `\\{n,m\\}`, the position already past the `\\{`.

        With nothing to repeat there is no interval to scan at all:
        glibc re-reads the `\\{` as a literal `{` and carries on from
        just after it, so the body is never examined and `p\\{2,1\\}`,
        `p\\{x\\}` and `p\\{32768\\}` are all accepted although every
        one of those bodies is refused in a real interval. Measured:
        `nl -b 'p\\{2,1\\}'` matches the five bytes `{2,1}`.

        Raises:
            BreError: the interval is unclosed or its body is malformed.
        """
        if self.atom_start is None:
            self.atom(escape_outside("{"))
            return
        close = self.src.find("\\}", self.pos)
        if close < 0:
            raise BreError(UNMATCHED_BRACE)
        body = self.src[self.pos:close]
        self.pos = close + 2
        self.repeat(interval_token(body), "{")

    def bracket(self) -> None:
        """Scan one `[...]`, whose escaping rules are their own dialect.

        Inside a POSIX bracket expression a backslash is an ordinary
        character, a `]` in the first slot is a member rather than the
        close, and `[:alpha:]`-style constructs are the only escapes
        there are. So the members are re-emitted one at a time, each
        escaped for the host set, rather than passed through.

        Two of glibc's answers here are the opposite of what both host
        engines say, and both are measured:

        * An inverted plain range is **legal** in expr's and nl's
          dialect. `[z-a]` compiles and matches nothing, `[^z-a]`
          compiles and matches any one character; python and JavaScript
          both refuse the range. So an inverted range contributes no
          members and an empty set is spelled out (`MATCHES_NOTHING` /
          `MATCHES_ANY_ONE`). grep and sed are the exception and refuse
          it (`grep '[z-a]'` is `Invalid range end`, exit 2), which is
          what `refuse_inverted_range` says.
        * `Invalid range end` is about the **kind** of endpoint, not its
          order: a `[:class:]` or `[=equiv=]` on either side of the `-`
          is refused, a `[.elem.]` is not, and a `-x` that follows an
          already-completed range is (`[a-c-e]`).

        Raises:
            BreError: the set is unterminated, names a class that does
                not exist, or spells a range glibc refuses.
        """
        src = self.src
        i = self.pos + 1
        negated = False
        if i < len(src) and src[i] == "^":
            negated = True
            i += 1
        if i >= len(src):
            # `[` or `[^` and then nothing. glibc answers REG_BADPAT for
            # exactly these two and REG_EBRACK for every other run-off,
            # so `p[` is `Invalid regular expression` while `p[a` is
            # `Unmatched [, [^, [:, [., or [=`.
            raise BreError(INVALID_PATTERN)
        members: list[str] = []
        first = True
        while True:
            if i >= len(src):
                raise BreError(UNMATCHED_BRACKET)
            if src[i] == "]" and not first:
                i += 1
                break
            first = False
            i, kind, value = bracket_item(src, i)
            if src[i:i + 1] != "-" or src[i + 1:i + 2] in ("", "]"):
                members.append(value if kind == ":" else escape_inside(value))
                continue
            if kind not in RANGE_KINDS:
                raise BreError(BAD_RANGE)
            i, high_kind, high = bracket_item(src, i + 1)
            if high_kind not in RANGE_KINDS:
                raise BreError(BAD_RANGE)
            if high >= value:
                members.append(
                    escape_inside(value) + "-" + escape_inside(high))
            elif self.refuse_inverted_range:
                raise BreError(BAD_RANGE)
            # A `-` straight after a closed range is a second range end,
            # which glibc refuses: `[a-c-e]` is `Invalid range end` while
            # `[a-c-]` and `[a-cd-f]` both compile.
            if src[i:i + 1] == "-" and src[i + 1:i + 2] not in ("", "]"):
                raise BreError(BAD_RANGE)
        self.pos = i
        if not members:
            self.atom(MATCHES_ANY_ONE if negated else MATCHES_NOTHING)
            return
        self.atom("[" + ("^" if negated else "") + "".join(members) + "]")


def translate_bre(pattern: str,
                  refuse_inverted_range: bool = False) -> tuple[str, int]:
    """Translate a POSIX BRE into this host's regex dialect.

    The raw entry point, for a caller that needs the source text rather
    than a matcher: `grep` splices several translated patterns into one
    alternation and wraps each in `\\b` for `-w`, which it can only do
    with a string.

    Args:
        pattern (str): the BRE exactly as it arrived on the line.
        refuse_inverted_range (bool): True for grep's dialect, where a
            range whose end sorts before its start is refused; False for
            expr's and nl's, where it compiles to an empty set. This is
            the one place the two GNU dialects disagree about what a
            pattern means (`grep '[z-a]'` is `Invalid range end` and
            exits 2, while `nl -b 'p[z-a]'` and `expr x : '[z-a]'` both
            exit 0 having matched nothing).

    Returns:
        tuple[str, int]: the host pattern source and its group count.

    Raises:
        BreError: the pattern is one glibc would refuse.
    """
    return BreTranslator(pattern, refuse_inverted_range).translate()


def compile_bre(pattern: str) -> tuple[re.Pattern[str], int]:
    """Translate a POSIX BRE and compile it.

    `re.DOTALL` is set because `RE_SYNTAX_POSIX_BASIC` carries
    `RE_DOT_NEWLINE`, and `re.ASCII` because GNU's word boundary is the
    ASCII one under `LC_ALL=C` while python's default is Unicode.

    Args:
        pattern (str): the BRE exactly as it arrived on the line.

    Returns:
        tuple[re.Pattern[str], int]: the compiled pattern and its group
            count.

    Raises:
        BreError: the pattern is one glibc would refuse, or one this
            translator emitted in a form the host engine rejects.
    """
    source, groups = translate_bre(pattern)
    try:
        compiled = re.compile(source, re.DOTALL | re.ASCII)
    except re.error as exc:
        raise BreError(INVALID_PATTERN) from exc
    return compiled, groups


def search_bre(pattern: str) -> re.Pattern[str]:
    """Translate a POSIX BRE and compile it for an unanchored search.

    The companion to `compile_bre`, and the difference between them is
    the one thing the two callers disagree about. `expr` matches with
    `re_match`, which is anchored at position 0 -- so `expr abc : 'b'`
    is 0 -- while `nl` matches its `-b p<re>` style with `re_search`,
    which is not: `printf 'foo\\n' | nl -b po` numbers the line. python
    spells that distinction at the call site (`match` versus `search`),
    JavaScript spells it in the flags, so the two hosts would drift if
    each caller picked its own; this keeps one function per behaviour
    and mirrors `searchBre` in `bre.ts`.

    Args:
        pattern (str): the BRE exactly as it arrived on the line.

    Returns:
        re.Pattern[str]: the compiled pattern, to be used with
            `search`. The group count `compile_bre` reports is not
            returned, because a search only ever asks whether the
            subject matched.

    Raises:
        BreError: the pattern is one glibc would refuse, or one this
            translator emitted in a form the host engine rejects.
    """
    source, _ = translate_bre(pattern)
    try:
        return re.compile(source, re.DOTALL | re.ASCII)
    except re.error as exc:
        raise BreError(INVALID_PATTERN) from exc
