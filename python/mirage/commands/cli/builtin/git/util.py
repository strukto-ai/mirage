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
from collections.abc import Mapping, Sequence
from string import hexdigits

from dulwich.config import ConfigFile

from mirage.commands.cli.builtin.git.constants import HEAD
from mirage.commands.cli.builtin.git.errors import (
    BadConfigValueError,
    BadNumericConfigError,
    ColorValueError,
    CommandLineConfigError,
    ConfigKeyError,
    GitError,
    NotAWorkTreeError,
    UnrecognizedArgumentError,
    UsageError,
)
from mirage.commands.cli.refusal import (
    HELP_SWITCH,
    git_option_refusal,
    git_usage,
)
from mirage.commands.config import Context
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandSpec
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import byte_char
from mirage.types import PathSpec
from mirage.workspace.files import Files

ROOT = "/"
STDOUT = "stdout"
STDERR = "stderr"
# The end-of-options marker, which the parser consumes.
MARKER = "--"
TRUE_WORDS = (b"true", b"yes", b"on")
FALSE_WORDS = (b"false", b"no", b"off", b"")
# A config integer as git reads one: C-locale space, a number read the
# way C's strtoimax reads base 0, then at most one unit, and the product
# has to fit an int.
INTEGER = re.compile(
    rb"[ \t\n\v\f\r]*([-+]?)"
    rb"(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([kKmMgG]?)"
)
UNIT_SHIFTS = {b"": 0, b"k": 10, b"m": 20, b"g": 30}
# The options before the verb that set a config variable for one line,
# and the others there that take a separate value.
CONFIG_OPTION = "-c"
CONFIG_ENV_OPTION = "--config-env"
VALUE_GLOBALS = ("-C", "--git-dir", "--work-tree")
INT_BITS = 31
WIDE_INT_BITS = 63
COLOR_WORDS = ("always", "auto", "never")
VALUE_ESCAPES = {"\n": "\\n", "\t": "\\t", '"': '\\"', "\\": "\\\\"}
COMMENT_STARTS = (";", "#")
COMMENT_BYTES = (b";", b"#")
QUOTED_HEADER = re.compile(
    rb'\s*\[([A-Za-z0-9.-]+)\s+"((?:[^"\\\n]|\\.)*)"\s*\]'
)
DOTTED_HEADER = re.compile(rb"\s*\[([A-Za-z0-9-]+)\.([^\]\s]*)\]")
ESCAPED = re.compile(rb"\\(.)")


def start_point(fl: FlagView) -> PathSpec:
    """Where repository discovery begins for this invocation.

    ``-C`` changes directory before anything else happens, git's own
    reading of the option. It needs no separate session-cwd fact: the
    option is declared with a ``"."`` default, and a PATH default lands
    as if typed, so an absent ``-C`` resolves to the session cwd and a
    relative ``-C build`` is already absolute by the time it arrives.

    Keep the PathSpec until the directory walk is checked. Repository-relative
    pathspec matching uses its virtual spelling after that check.

    Args:
        fl (FlagView): spec-validated view over the leaf's flag bag.
    """
    return fl.as_path("C") or PathSpec.from_str_path(ROOT)


def revision_arg(texts: tuple[str, ...], default: str = HEAD) -> str:
    """The revision operand a verb was given, or git's own default.

    Args:
        texts (tuple[str, ...]): positional text operands.
        default (str): what an absent operand means.
    """
    return texts[0] if texts else default


def escaped(argv: tuple[str, ...]) -> frozenset[str]:
    """The words a ``--`` on the line marked as operands, not options.

    ``--`` is exactly how a caller names a file whose name begins with a
    dash, and git says so in every synopsis that ends
    ``[--] [<pathspec>...]``: ``git rm -draft`` is a refused switch and
    ``git rm -- -draft`` removes the file. The parser consumes the
    marker, so the words themselves are what carries the fact forward,
    read back off the verbatim argv the record already holds.

    A set is enough. A dash word before the marker was read as an
    option and never reached the operands, so a word that is here and
    also spelled earlier on the line is still the escaped one.

    Args:
        argv (tuple[str, ...]): the line's verbatim tokens after the
            head word, subcommand words included.
    """
    if MARKER not in argv:
        return frozenset()
    return frozenset(argv[argv.index(MARKER) + 1 :])


def split_marked(
    texts: tuple[str, ...], argv: tuple[str, ...]
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """The operands before a ``--`` on the line and the ones after it.

    ``git diff A B -- docs`` reads what comes before the marker as
    revisions and what follows as pathspecs, whatever either looks
    like. Every word after the marker is an operand, so they are the
    tail of the operands, as many as the verbatim argv holds past it.

    Args:
        texts (tuple[str, ...]): positional text operands, as typed.
        argv (tuple[str, ...]): the line's verbatim tokens after the
            head word, subcommand words included.
    """
    if MARKER not in argv:
        return texts, ()
    cut = len(texts) - (len(argv) - argv.index(MARKER) - 1)
    return texts[:cut], texts[cut:]


def switches(ctx: Context) -> frozenset[str]:
    """The one-letter switches the leaf declares, without their dash.

    Read off the spec the line was parsed against, so the set is the
    verb's own and never a copy of it; empty where no executor built
    the record.

    Args:
        ctx (Context): the line's context, carrying its leaf.
    """
    if ctx.spec is None:
        return frozenset()
    return frozenset(
        name[1:]
        for option in compile_spec(ctx.spec).options
        for name in option.names
        if len(name) == 2
    )


def offending_switch(text: str, known: frozenset[str] | None) -> str:
    """The part of a dash word parse-options would refuse.

    git reads a short cluster letter by letter, consumes the ones the
    verb declares and stops at the first it does not, so ``git mv -nx``
    says `x' and ``git mv -draft`` says `d' (git 2.50.1); a verb that
    declares no switch at all (``reset``) still names the first letter.
    A long option is refused as typed, and so is a cluster for a verb
    that hands over no set: log, show and diff word the whole argument.

    Args:
        text (str): the dash word as the user spelled it.
        known (frozenset[str] | None): the verb's one-letter switches,
            None for a verb that refuses the word whole.
    """
    if known is None or text.startswith("--"):
        return text
    for letter in text[1:]:
        if letter not in known:
            return f"-{letter}"
    return text


def offending(
    texts: Sequence[str],
    marked: frozenset[str] = frozenset(),
    known: frozenset[str] | None = None,
) -> str | None:
    """The first operand that is really an option this build lacks.

    A verb taking a revision accepts free text, so every flag mirage
    does not declare reaches it as one. Resolving it as a revision is
    the wrong answer twice over: it fails, and it fails saying the
    repository has no such commit, when what happened is that mirage
    has no such flag. Found here, before any object is read, so the
    refusal names the real problem.

    Unless the caller said otherwise. A word after ``--`` is an operand
    by the caller's own instruction whatever it starts with, so it is
    never read as an option here; see ``escaped``, which is where the
    marker survives the parser.

    Which side of the marker an operand fell on says nothing about what
    it *means* here. ``diff``, ``show``, ``diff-tree`` and the walks
    (``log``, ``rev-list``, ``shortlog``) read what follows the marker
    as pathspecs (``split_marked``).

    Args:
        texts (Sequence[str]): positional text operands, as typed.
        marked (frozenset[str]): operands a ``--`` on the line escaped.
        known (frozenset[str] | None): the verb's one-letter switches,
            which narrow a refused cluster to its first unknown letter
            the way parse-options does; None names the whole word.
    """
    for text in texts:
        if text.startswith("-") and text not in marked:
            return offending_switch(text, known)
    return None


def option_operand(
    ctx: Context,
    texts: Sequence[str],
    help_stream: str = STDOUT,
) -> str | None:
    """The first operand that is really an option, once ``-h`` is out.

    ``-h`` asks for the verb's usage block, which git prints on stdout
    for most verbs and on stderr for a few (``diff``); every other word
    is the caller's to refuse in the verb's own words. See
    ``offending`` for which words count.

    Args:
        ctx (Context): the line's context, carrying its leaf.
        texts (Sequence[str]): positional text operands, as typed.
        help_stream (str): where ``-h`` puts the usage block.

    Raises:
        UsageError: the line asked for the usage block.
    """
    word = offending(texts, escaped(ctx.argv))
    if word == HELP_SWITCH:
        usage = verb_usage(ctx)
        if help_stream == STDOUT:
            raise UsageError(usage, "")
        raise UsageError("", usage)
    return word


def lone_help(ctx: Context, texts: Sequence[str]) -> str:
    """Where ``-h`` puts the usage block for a verb that takes it as help
    only alone.

    ``rev-list``, ``rev-parse`` and ``diff-tree`` print it on stdout,
    exiting 0, when ``-h`` is their one word, and beside anything else
    on stderr as a refusal, exiting 129 (git 2.56).

    Args:
        ctx (Context): the line's context, carrying its leaf.
        texts (Sequence[str]): the verb's positional text operands.
    """
    verb = (ctx.spec or CommandSpec()).name
    alone = tuple(ctx.argv[-2:]) == (verb, HELP_SWITCH)
    return STDOUT if alone and list(texts) == [HELP_SWITCH] else STDERR


def check_operands(
    ctx: Context, texts: Sequence[str], help_stream: str = STDOUT
) -> None:
    """Refuse an operand that is really an option, as an unrecognized
    argument.

    For the verbs git words without a usage block (``log``, ``show``,
    ``reflog``), whose refusal names the whole word (git 2.50.1).

    Args:
        ctx (Context): the line's context, carrying its leaf.
        texts (Sequence[str]): positional text operands, as typed.
        help_stream (str): where ``-h`` puts the usage block.
    """
    word = option_operand(ctx, texts, help_stream)
    if word is not None:
        raise UnrecognizedArgumentError(word)


def verb_usage(ctx: Context) -> str:
    """The verb's usage block, as parse-options prints it.

    Args:
        ctx (Context): the line's context, carrying its leaf.
    """
    spec = ctx.spec or CommandSpec()
    return git_usage(spec.name, spec)


def check_switches(ctx: Context, texts: Sequence[str]) -> None:
    """Refuse an operand that is really an option, as parse-options does.

    The verbs built on parse-options (``status``, ``add``, ``branch``,
    ``commit`` and most others) name an unknown option or switch and
    follow it with the usage block, refuse a boolean handed a value on
    one line, and print the usage block on stdout for ``-h``; see
    ``git_option_refusal``. Measured on git 2.50.1.

    Args:
        ctx (Context): the line's context, carrying its leaf.
        texts (Sequence[str]): positional text operands, as typed.
    """
    word = offending(texts, escaped(ctx.argv), switches(ctx))
    if word is not None:
        spec = ctx.spec or CommandSpec()
        raise UsageError(*git_option_refusal(word, spec.name, spec))


def require_vfs(ctx: Context) -> Files:
    """The session's files, which every verb reads and writes through.

    Only a leaf called directly, outside a workspace, has none; git
    words that the way it words a bare repository.

    Args:
        ctx (Context): the line's context.

    Raises:
        NotAWorkTreeError: no files are wired.
    """
    if ctx.vfs is None:
        raise NotAWorkTreeError()
    return ctx.vfs


def fatal(exc: GitError) -> tuple[ByteSource | None, IOResult]:
    """Render a git error: ``<prefix>: <message>``, on its own stream.

    git uses 128 for a fatal, which is neither the dispatcher's usage
    exit (2) nor its generic handler-error exit (1), so leaves return
    the code rather than raising into the catch-all. A refused option
    carries its own prefix and code instead, which is git's own split,
    and a refusal that is really a report ("nothing to commit") carries
    no prefix and goes to stdout.

    An error carrying a ``report`` puts that on stdout beside the
    stderr line, because git writes some refusals to both streams at
    once: ``<path>: needs merge`` is the diagnosis and "you need to
    resolve your current index first" is the refusal.

    Args:
        exc (GitError): the error to render.
    """
    body = f"{exc}\n" if exc.prefix is None else f"{exc.prefix}: {exc}\n"
    data = body.encode()
    if exc.stream == STDOUT:
        return data, IOResult(exit_code=exc.exit_code)
    told = exc.report.encode() if exc.report else None
    return told, IOResult(exit_code=exc.exit_code, stderr=data)


def git_bool(values: Sequence[bytes], key: str, default: bool) -> bool:
    """A config boolean read the way git's config callbacks read one.

    Every occurrence is parsed and the last one wins, so a value git
    cannot read fails even when a later line would have read fine. A
    value is ``true``/``yes``/``on`` or ``false``/``no``/``off`` in any
    case, empty for false, or an integer for whether it is nonzero
    (pinned against git 2.54).

    Args:
        values (Sequence[bytes]): every value the variable takes, in file
            order; a bare name arrives as ``b"true"``.
        key (str): the variable, section and name lowercased.
        default (bool): the answer when the variable is unset.

    Raises:
        BadConfigValueError: a value git cannot read as a boolean.
    """
    answer = default
    for value in values:
        parsed = maybe_bool(value)
        if parsed is None:
            raise BadConfigValueError(value.decode(errors="replace"), key)
        answer = parsed
    return answer


def parse_config_key(key: str, error: type[GitError] = ConfigKeyError) -> str:
    """A config name as git keys it, section and name lowercased.

    Args:
        key (str): the name as typed.
        error (type[GitError]): the refusal to raise.

    Raises:
        GitError: a name that is not ``section[.subsection].name``.
    """
    if "." not in key:
        raise error(f"key does not contain a section: {key}")
    section, _, rest = key.partition(".")
    subsection, dot, name = rest.rpartition(".")
    if not name:
        raise error(f"key does not contain variable name: {key}")
    if (
        not section
        or not all(
            char.isascii() and (char.isalnum() or char == "-")
            for char in section
        )
        or not (name[0].isalpha() and name[0].isascii())
        or not all(
            char.isascii() and (char.isalnum() or char == "-") for char in name
        )
    ):
        raise error(f"invalid key: {key}")
    middle = f".{subsection}" if dot else ""
    return f"{section.lower()}{middle}.{name.lower()}"


def _assignment(text: str) -> tuple[str, str | None]:
    """One ``-c`` operand as a key and its value.

    Args:
        text (str): ``name=value``, or ``name`` for a bare true.
    """
    name, equals, value = text.partition("=")
    if not name:
        raise CommandLineConfigError("empty config key")
    return (
        parse_config_key(name, CommandLineConfigError),
        value if equals else None,
    )


def _from_env(text: str, env: Mapping[str, str]) -> tuple[str, str | None]:
    """One ``--config-env`` operand as a key and the value it points at.

    Args:
        text (str): ``name=envvar``.
        env (Mapping[str, str]): the session environment.
    """
    name, equals, variable = text.rpartition("=")
    if not equals:
        raise GitError(f"invalid config format: {text}")
    if variable not in env:
        raise GitError(
            f"missing environment variable '{variable}' "
            f"for configuration '{name}'"
        )
    return parse_config_key(name, CommandLineConfigError), env[variable]


def command_line_config(ctx: Context) -> tuple[tuple[str, str | None], ...]:
    """What the words before the verb set with ``-c`` and ``--config-env``.

    The two are one spec option, whose values alone cannot say which
    spelling each came from, so this reads the verbatim line. Only the
    words before the verb count: a later ``-c`` is the verb's own.

    Args:
        ctx (Context): the line's context.
    """
    words = ctx.argv or ()
    env = ctx.env or {}
    rows: list[tuple[str, str | None]] = []
    at = 0
    while at < len(words) and words[at].startswith("-"):
        word = words[at]
        if word == CONFIG_OPTION and at + 1 < len(words):
            rows.append(_assignment(words[at + 1]))
            at += 2
        elif word == CONFIG_ENV_OPTION and at + 1 < len(words):
            rows.append(_from_env(words[at + 1], env))
            at += 2
        elif word.startswith(f"{CONFIG_ENV_OPTION}="):
            rows.append(_from_env(word[len(CONFIG_ENV_OPTION) + 1 :], env))
            at += 1
        else:
            at += 2 if word in VALUE_GLOBALS else 1
    return tuple(rows)


def config_int(
    value: bytes, spelled: str, key: str, bits: int = INT_BITS
) -> int:
    """An integer-typed config value, or git's refusal of it.

    Args:
        value (bytes): the value.
        spelled (str): the value as it prints in the refusal.
        key (str): the variable.
        bits (int): the magnitude bits the value may use.

    Raises:
        BadNumericConfigError: no integer, or one out of range.
    """
    number = _integer(value, bits)
    if number is not None:
        return number
    reason = "out of range" if INTEGER.fullmatch(value) else "invalid unit"
    raise BadNumericConfigError(spelled, key, reason)


def render_format(template: str, atoms: Mapping[str, str], verb: str) -> str:
    """One row of a ``--format`` template.

    Args:
        template (str): the template, with ``%(atom)``, ``%%`` and
            ``%xNN`` placeholders.
        atoms (Mapping[str, str]): each atom's text for this row.
        verb (str): the command, named in the refusal.

    Raises:
        GitError: a placeholder the command does not have.
    """
    out: list[str] = []
    at = 0
    while at < len(template):
        char = template[at]
        if char != "%":
            out.append(char)
            at += 1
        elif template.startswith("%%", at):
            out.append("%")
            at += 2
        elif (
            template.startswith("%x", at)
            and len(template) >= at + 4
            and all(c in hexdigits for c in template[at + 2 : at + 4])
        ):
            out.append(byte_char(int(template[at + 2 : at + 4], 16)))
            at += 4
        else:
            end = template.find(")", at)
            name = (
                template[at + 2 : end]
                if template.startswith("%(", at) and end != -1
                else None
            )
            if name is None or name not in atoms:
                raise GitError(f"bad {verb} format: {template[at:]}")
            out.append(atoms[name])
            at = end + 1
    return "".join(out)


def check_color(fl: FlagView) -> None:
    """Refuse a ``--color`` value git refuses; a good one changes nothing.

    Args:
        fl (FlagView): the leaf's flags.

    Raises:
        ColorValueError: neither a color word nor a boolean.
    """
    when = fl.raw("color")
    if (
        isinstance(when, str)
        and when.lower() not in COLOR_WORDS
        and maybe_bool(when.encode("utf-8", "surrogateescape")) is None
    ):
        raise ColorValueError()


def maybe_bool(value: bytes) -> bool | None:
    """A config boolean as git reads it: a boolean word, empty, or an integer.

    ``true``/``yes``/``on`` or ``false``/``no``/``off`` in any case,
    empty for false, or an integer for whether it is nonzero; None for
    anything else, which each caller answers in its own way.

    Args:
        value (bytes): the value as typed or as the config spells it.
    """
    word = value.lower()
    if word in TRUE_WORDS:
        return True
    if word in FALSE_WORDS:
        return False
    number = _integer(value)
    return None if number is None else number != 0


def multivar(
    config: ConfigFile, section: tuple[bytes, ...], name: bytes
) -> list[bytes]:
    """Every value of one variable, empty when it is not set.

    Args:
        config (ConfigFile): the parsed config.
        section (tuple[bytes, ...]): section and subsection.
        name (bytes): the variable.
    """
    try:
        return list(config.get_multivar(section, name))
    except KeyError:
        return []


def config_section(
    section: str, name: str, pairs: Sequence[tuple[str, str]]
) -> str:
    """One ``[section "name"]`` block the way git's config writer spells it.

    The subsection escapes ``"`` and ``\\``; a value escapes those plus
    newline and tab, and is quoted when it starts or ends with a space
    or holds ``;`` or ``#``. A branch may be named ``a"b`` or ``a#b``,
    and either one written raw reads back as a different name (pinned
    against git 2.50.1).

    Args:
        section (str): the section, e.g. ``branch``.
        name (str): the subsection, e.g. the branch name.
        pairs (Sequence[tuple[str, str]]): variables and values, in order.
    """
    quoted = name.replace("\\", "\\\\").replace('"', '\\"')
    text = f'[{section} "{quoted}"]\n'
    for key, value in pairs:
        body = "".join(VALUE_ESCAPES.get(ch, ch) for ch in value)
        if (
            value.startswith(" ")
            or value.endswith(" ")
            or any(ch in value for ch in COMMENT_STARTS)
        ):
            body = f'"{body}"'
        text += f"\t{key} = {body}\n"
    return text


def without_section(
    data: bytes,
    section: str,
    name: str,
    keys: frozenset[bytes] | None = None,
) -> bytes:
    """A config's text with every block for ``section.name`` taken out.

    ``git branch -d`` drops the deleted branch's settings this way, so a
    branch made again under the same name starts with no upstream
    rather than with two. A header names the block the way git
    matches it, spelled exactly: ``[branch "x"]``
    with its escapes, or the older ``[branch.x]``. ``[Branch "x"]`` and
    ``[branch.X]`` are left, as git leaves them, and a line opening with
    ``[`` ends a block (pinned against git 2.50.1).

    With ``keys`` only those variables leave the blocks, and a block
    they leave holding no variable leaves with them, header and all, as
    ``git branch --delete-merged`` clears an upstream (git 2.56.0). A
    variable sharing its header's line leaves the header behind.

    A value continued onto the next line by a trailing backslash is
    followed, so a continuation that opens with ``[`` is still part of
    the block. git 2.50.1 reads it as a header there and leaves the
    rest of the block behind, which it then refuses as a bad config
    line; mirage keeps the file readable instead.

    Args:
        data (bytes): the config file's contents.
        section (str): the section as git writes it, e.g. ``branch``.
        name (str): the subsection, e.g. the branch name.
        keys (frozenset[bytes] | None): the variables to take out,
            lowercase; None takes the whole block.
    """
    kept: list[bytes] = []
    block: list[bytes] = []
    dropping = continued = inside = holding = False
    word = b""
    want = (section.encode(), name.encode())
    for line in data.splitlines(keepends=True):
        value = line
        head = b""
        if not continued:
            rest = line
            if line.lstrip().startswith(b"["):
                if holding:
                    kept.extend(block)
                block, holding = [], False
                quoted = QUOTED_HEADER.match(line)
                dotted = DOTTED_HEADER.match(line)
                dropping = (
                    quoted is not None
                    and (quoted.group(1), ESCAPED.sub(rb"\1", quoted.group(2)))
                    == want
                ) or (dotted is not None and dotted.groups() == want)
                header = quoted or dotted
                end = header.end() if header else line.find(b"]") + 1
                head = line[:end] + line[len(line.rstrip(b"\r\n")) :]
                rest = line[end:]
            variable, equals, value = rest.partition(b"=")
            comment = rest.lstrip().startswith(COMMENT_BYTES)
            if not equals or comment:
                value = b""
            word = b"" if comment else variable.strip().lower()
            inside = False
        continued, inside = _continues(value, inside)
        if not dropping:
            kept.append(line)
        elif keys is not None and word not in keys:
            block.append(line)
            holding = holding or bool(word)
        elif keys is not None and head:
            block.append(head)
    if holding:
        kept.extend(block)
    return b"".join(kept)


def _continues(value: bytes, inside: bool) -> tuple[bool, bool]:
    """Whether a config value runs onto the next line, as git parses one.

    A backslash ending the line continues the value unless it is itself
    escaped or sits in a comment; a comment starts at ``;`` or ``#``
    outside double quotes. Returns whether the value continues and
    whether the next line starts inside quotes.

    Args:
        value (bytes): the rest of the line, from the value on.
        inside (bool): whether the line starts inside double quotes.
    """
    body = value.removesuffix(b"\n").removesuffix(b"\r")
    at = 0
    while at < len(body):
        ch = body[at : at + 1]
        if ch == b"\\":
            if at == len(body) - 1:
                return True, inside
            at += 2
            continue
        if ch == b'"':
            inside = not inside
        elif not inside and ch in COMMENT_BYTES:
            break
        at += 1
    return False, False


def _integer(value: bytes, bits: int = INT_BITS) -> int | None:
    """The integer a config value spells as git reads it, None for none.

    Hex after ``0x`` and octal after a leading zero, then an optional
    ``k``, ``m`` or ``g``; a product outside the range is no integer.

    Args:
        value (bytes): the value as the config file spells it.
        bits (int): the magnitude bits the value may use.
    """
    match = INTEGER.fullmatch(value)
    if match is None:
        return None
    sign, digits, unit = match.groups()
    if digits[1:2] in (b"x", b"X"):
        magnitude = int(digits[2:], 16)
    else:
        magnitude = int(digits, 8 if digits.startswith(b"0") else 10)
    number = -magnitude if sign == b"-" else magnitude
    shift = UNIT_SHIFTS[unit.lower()]
    lowest = -(1 << bits) >> shift
    highest = ((1 << bits) - 1) >> shift
    if not lowest <= number <= highest:
        return None
    return number << shift
