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

from mirage.rs.stream import open_stream
from mirage.shell.bytes import decode_text, encode_text

# ``#`` starts a comment and ``~`` starts a home-directory expansion, but
# only as the first character of a word, so GNU quotes them there alone.
LEADING_SPECIAL = frozenset("#~")

# What rules out the ``"name"`` form for a name holding a single quote.
# Narrower than the trigger set: a space and a ``:`` are harmless inside
# double quotes, while the conditional characters #, ~, { and } lose their
# position rule and always rule it out.
DQ_BLOCKERS = frozenset('!"#$&()*;<=>?[\\^`{|}~')

NAMED_ESCAPES = {
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
# family quote only when the name needs it (the ``shell-escape`` quoting
# style), while head/tail/tac/fmt/split/csplit/truncate/strings quote
# always and word the line differently ("cannot open X for reading").
# Those say it in GNU's words (``FAILURE_WORDING`` in
# mirage.errors.render). For the rest mirage renders one line shape, so it
# renders one policy too: quote when the name needs it, which is the same
# answer for every name that carries a metacharacter and differs only for
# the plain ones GNU's always-quoting half would dress up.
#
# Absent on purpose, in two groups. GNU prints the operand bare for grep,
# sed, cmp, diff, rev (util-linux), md5 (BSD) and zcat (gzip). And the
# tools that are nobody's coreutils -- awk, column, file, iconv, jq, look,
# xxd -- keep their own original's diagnostic, which is not this one.
SHELL_QUOTED_COMMANDS: frozenset[str] = frozenset(
    {
        "b2sum",
        "base64",
        "cat",
        "comm",
        "csplit",
        "cut",
        "df",
        "expand",
        "fmt",
        "fold",
        "join",
        "md5sum",
        "nl",
        "od",
        "paste",
        "readlink",
        "realpath",
        "sha1sum",
        "sha224sum",
        "sha256sum",
        "sha384sum",
        "sha512sum",
        "shuf",
        "sort",
        "split",
        "strings",
        "tee",
        "tsort",
        "unexpand",
        "uniq",
        "wc",
    }
)


def _quote(name: str, style: str) -> str:
    stream = open_stream("quote", {"style": style})
    stream.feed(encode_text(name))
    return decode_text(stream.finish())


def quotes_operands(cmd_name: str) -> bool:
    """Whether a command reports its path operands shell-quoted.

    Args:
        cmd_name (str): The command name a diagnostic is prefixed with.
    """
    return cmd_name in SHELL_QUOTED_COMMANDS


def escape_name(name: str) -> str:
    """GNU ls -b names: C escapes, with spaces and backslashes protected.

    Uses the same UTF-8 locale policy as shell_quote_always, including
    its documented divergence for unassigned Unicode characters.

    Args:
        name (str): the filename or symlink target to display.
    """
    return _quote(name, "escape")


def shell_quote_always(name: str) -> str:
    """Wrap a name so a shell would read it back as itself.

    GNU's ``shell-escape-always`` quoting style: the ``"name"`` form when the
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
    return _quote(name, "shell_always")


def shell_quote(name: str) -> str:
    """Wrap a name only when a shell would read it back as something else.

    GNU's ``shell-escape`` quoting style, byte-identical with the TypeScript
    ``shellQuote``: ``nope.txt`` stays bare and ``*.txt`` becomes
    ``'*.txt'``, which is what makes a name carrying a metacharacter
    readable in a diagnostic without dressing up every ordinary one.

    Args:
        name (str): The name to report.
    """
    return _quote(name, "shell")


def single_quote(text: str) -> str:
    """Wrap text so bash reads it back as exactly one word.

    The quoting bash itself writes: always the ``'text'`` form, with an
    embedded quote spelled ``'\\''`` and every other character, newlines
    included, left as itself. This is not
    :func:`shell_quote_always`, which is GNU's diagnostic rendering and
    may answer with the ``"text"`` form or a ``$'...'`` group; bash uses
    this one wherever it builds a command line out of data (``alias``
    printing a value, ``mapfile -C`` handing a record to a callback), so
    text that is shell syntax stays a single argument.

    Args:
        text (str): The text to wrap.
    """
    return "'" + text.replace("'", "'\\''") + "'"
