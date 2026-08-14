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

# The characters that make a name unsafe to paste back into a shell, so
# GNU wraps it. Probed byte by byte against coreutils 9.7 on
# debian:stable-slim; ``:`` is in the set because a diagnostic uses it as
# the separator, and ``]``/``%``/``+``/``,``/``-``/``.``/``@``/``_`` are
# deliberately absent because GNU leaves them bare.
_ALWAYS_SPECIAL = frozenset(" !\"$&'()*:;<=>?[\\^`|")

# ``#`` starts a comment and ``~`` starts a home-directory expansion, but
# only as the first character of a word, so GNU quotes them there alone.
_LEADING_SPECIAL = frozenset("#~")

# Brace expansion needs a pair to mean anything, so GNU quotes a lone
# brace and leaves one inside a longer name bare.
_SOLO_SPECIAL = frozenset({"{", "}"})

# What rules out the ``"name"`` form for a name holding a single quote.
# Narrower than the trigger set: a space and a ``:`` are harmless inside
# double quotes, while the four conditional characters above lose their
# position rule and always rule it out.
_DQ_BLOCKERS = frozenset("!\"#$&()*;<=>?[\\^`{|}~")

_NAMED_ESCAPES = {
    "\a": "a",
    "\b": "b",
    "\t": "t",
    "\n": "n",
    "\v": "v",
    "\f": "f",
    "\r": "r",
}

# The commands whose operand mirage reports shell-quoted, each one probed
# against its own GNU original on debian:stable-slim. GNU picks the policy
# per diagnostic, not per command family: cat/wc/cut and most of the read
# family quote only when the name needs it (gnulib's ``shell_escape``
# style), while head/tail/tac/fmt/split/csplit/truncate/strings quote
# always and word the line differently ("cannot open X for reading").
# mirage renders one line shape for the whole read family, so it renders
# one policy too: quote when the name needs it, which is the same answer
# for every name that carries a metacharacter and differs only for the
# plain ones GNU's always-quoting half would dress up.
#
# Absent on purpose, in two groups. GNU prints the operand bare for grep,
# sed, cmp, diff, rev (util-linux), md5 (BSD) and zcat (gzip). And the
# tools that are nobody's coreutils -- awk, column, file, iconv, jq, look,
# xxd -- keep their own original's diagnostic, which is not this one.
SHELL_QUOTED_COMMANDS: frozenset[str] = frozenset({
    "base64",
    "cat",
    "comm",
    "csplit",
    "cut",
    "df",
    "expand",
    "fmt",
    "fold",
    "head",
    "join",
    "md5sum",
    "nl",
    "od",
    "paste",
    "sha1sum",
    "sha256sum",
    "sha384sum",
    "sha512sum",
    "shuf",
    "sort",
    "split",
    "strings",
    "tac",
    "tail",
    "tee",
    "truncate",
    "tsort",
    "unexpand",
    "uniq",
    "wc",
})


def _needs_escape(char: str) -> bool:
    code = ord(char)
    if code < 0x20 or code == 0x7F:
        return True
    # The C1 controls and the two line/paragraph separators are the only
    # code points above ASCII that glibc's iswprint refuses in a UTF-8
    # locale, so they are the only ones GNU escapes there (probed: NBSP,
    # a soft hyphen, ZWSP, a BOM, a private-use character and an emoji
    # all print as themselves). Deliberately not covered is the third
    # class GNU escapes, an unassigned code point: which ones those are
    # moves with the Unicode version each language happens to ship, and
    # a python/typescript split is worse than the gap.
    return 0x80 <= code <= 0x9F or code in (0x2028, 0x2029)


def _escape(char: str) -> str:
    named = _NAMED_ESCAPES.get(char)
    if named is not None:
        return f"\\{named}"
    # GNU escapes bytes, not code points, so a non-ASCII character costs
    # one octal group per UTF-8 byte (U+0085 is ``\302\205``).
    return "".join(f"\\{byte:03o}" for byte in char.encode("utf-8"))


def quotes_operands(cmd_name: str) -> bool:
    """Whether a command reports its path operands shell-quoted.

    Args:
        cmd_name (str): The command name a diagnostic is prefixed with.
    """
    return cmd_name in SHELL_QUOTED_COMMANDS


def needs_shell_quote(name: str) -> bool:
    """Whether a name cannot be pasted back into a shell as written.

    Args:
        name (str): The name as it would be reported bare.
    """
    # An empty operand has to be quoted or it disappears from the line
    # entirely, taking the answer to "which name failed" with it.
    if not name or name in _SOLO_SPECIAL:
        return True
    for index, char in enumerate(name):
        if char in _ALWAYS_SPECIAL or _needs_escape(char):
            return True
        if index == 0 and char in _LEADING_SPECIAL:
            return True
    return False


def shell_quote_always(name: str) -> str:
    """Wrap a name so a shell would read it back as itself.

    GNU's ``shell_escape_always`` rendering: the ``"name"`` form when the
    name holds a single quote and nothing else that would need escaping
    there, otherwise the ``'name'`` form, where an embedded quote becomes
    ``'\\''`` and a run of control characters becomes one ``$'...'``
    group. Deliberate divergence: a non-ASCII character is ordinary and
    stays as itself, which is GNU under a UTF-8 locale; the C locale
    would render every byte of it in octal, and mirage has no locale to
    switch on.

    Args:
        name (str): The name to wrap.
    """
    if "'" in name and not any(char in _DQ_BLOCKERS or _needs_escape(char)
                               for char in name):
        return f'"{name}"'
    parts = ["'"]
    in_escape = False
    for char in name:
        if _needs_escape(char):
            if not in_escape:
                parts.append("'$'")
                in_escape = True
            parts.append(_escape(char))
            continue
        # A quote closes whichever group is open and reopens the plain
        # one, so it costs the same three characters either way; only a
        # plain character after an escape run needs a group swap.
        if char == "'":
            parts.append("'\\''")
            in_escape = False
            continue
        if in_escape:
            parts.append("''")
            in_escape = False
        parts.append(char)
    parts.append("'")
    return "".join(parts)


def shell_quote(name: str) -> str:
    """Wrap a name only when a shell would read it back as something else.

    GNU's ``shell_escape`` rendering, byte-identical with the TypeScript
    ``shellQuote``: ``nope.txt`` stays bare and ``*.txt`` becomes
    ``'*.txt'``, which is what makes a name carrying a metacharacter
    readable in a diagnostic without dressing up every ordinary one.

    Args:
        name (str): The name to report.
    """
    if not needs_shell_quote(name):
        return name
    return shell_quote_always(name)
