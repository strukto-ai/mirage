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
from collections.abc import Callable, Sequence
from dataclasses import replace

from mirage.commands.cli.builtin.git.constants import DWIM_RULES
from mirage.commands.cli.builtin.git.dates import parse_date_mode, show_date
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    UnsupportedFieldError,
)
from mirage.commands.cli.builtin.git.mailmap import mapped_identity
from mirage.commands.cli.builtin.git.types import (
    FieldCompare,
    FieldSource,
    FieldValue,
    RefContext,
    RefField,
    RefItem,
    RefKind,
    RefObject,
)

TEXT = FieldCompare.TEXT
NUMBER = FieldCompare.NUMBER
TIME = FieldCompare.TIME
REF = FieldSource.REF
OBJECT = FieldSource.OBJECT
INFO = FieldSource.OBJECT_INFO

# git's valid_atom table: every field a format or a sort key may name,
# with where its value comes from and how it sorts.
FIELDS: dict[str, tuple[FieldSource, FieldCompare]] = {
    "refname": (REF, TEXT),
    "objecttype": (INFO, TEXT),
    "objectsize": (INFO, NUMBER),
    "objectname": (INFO, TEXT),
    "deltabase": (INFO, TEXT),
    "tree": (OBJECT, TEXT),
    "parent": (OBJECT, TEXT),
    "numparent": (OBJECT, NUMBER),
    "object": (OBJECT, TEXT),
    "type": (OBJECT, TEXT),
    "tag": (OBJECT, TEXT),
    "author": (OBJECT, TEXT),
    "authorname": (OBJECT, TEXT),
    "authoremail": (OBJECT, TEXT),
    "authordate": (OBJECT, TIME),
    "committer": (OBJECT, TEXT),
    "committername": (OBJECT, TEXT),
    "committeremail": (OBJECT, TEXT),
    "committerdate": (OBJECT, TIME),
    "tagger": (OBJECT, TEXT),
    "taggername": (OBJECT, TEXT),
    "taggeremail": (OBJECT, TEXT),
    "taggerdate": (OBJECT, TIME),
    "creator": (OBJECT, TEXT),
    "creatordate": (OBJECT, TIME),
    "describe": (OBJECT, TEXT),
    "subject": (OBJECT, TEXT),
    "body": (OBJECT, TEXT),
    "trailers": (OBJECT, TEXT),
    "contents": (OBJECT, TEXT),
    "signature": (OBJECT, TEXT),
    "raw": (OBJECT, TEXT),
    "upstream": (REF, TEXT),
    "push": (REF, TEXT),
    "symref": (REF, TEXT),
    "flag": (REF, TEXT),
    "HEAD": (REF, TEXT),
    "color": (REF, TEXT),
    "worktreepath": (REF, TEXT),
    "align": (REF, TEXT),
    "end": (REF, TEXT),
    "if": (REF, TEXT),
    "then": (REF, TEXT),
    "else": (REF, TEXT),
    "rest": (REF, TEXT),
    "ahead-behind": (INFO, TEXT),
    "is-base": (INFO, TEXT),
}

# Real git fields this build does not render: a GPG check, a trailer
# parser, a describe walk, pack internals, push destinations, colors,
# reachability counts and the packed/symref flag word.
UNSUPPORTED = frozenset(
    {
        "deltabase",
        "describe",
        "trailers",
        "signature",
        "push",
        "color",
        "flag",
        "ahead-behind",
        "is-base",
    }
)

PEOPLE = ("author", "committer", "tagger")
DATE_FIELDS = frozenset(
    {"authordate", "committerdate", "taggerdate", "creatordate"}
)
ALIGN_POSITIONS = ("left", "middle", "right")
# parse_signed_buffer's markers: a line starting with one begins the
# signature a tag message carries.
SIGNATURE_MARKERS = (
    "-----BEGIN PGP SIGNATURE-----",
    "-----BEGIN PGP MESSAGE-----",
    "-----BEGIN SIGNED MESSAGE-----",
    "-----BEGIN SSH SIGNATURE-----",
)
MINIMUM_ABBREV = 4
C_INTEGER = re.compile(r"[ \t\n\v\f\r]*([+-]?)([0-9]+)")
INT_MAX = 2**31 - 1
UINT_MAX = 2**32 - 1
TITLE_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._"
)


def c_int(text: str) -> int | None:
    """``strtol_i``: a whole decimal ``int``, None for anything else.

    Args:
        text (str): the digits, after C's optional blanks and sign.
    """
    found = C_INTEGER.fullmatch(text)
    if found is None:
        return None
    value = int(found.group(1) + found.group(2))
    return value if -INT_MAX - 1 <= value <= INT_MAX else None


def c_uint(text: str) -> int | None:
    """``strtoul_ui``: a whole decimal ``unsigned int``, None for
    anything else, a minus sign anywhere included.

    Args:
        text (str): the digits, after C's optional blanks and plus.
    """
    found = C_INTEGER.fullmatch(text)
    if "-" in text or found is None:
        return None
    value = int(found.group(2))
    return value if value <= UINT_MAX else None


def _label(name: str) -> str:
    """A field's name up to its arguments, as git's refusals print it.

    Args:
        name (str): the field as typed.
    """
    return name.split(":", 1)[0]


def _bad_arg(name: str, arg: str) -> GitError:
    """git's ``err_bad_arg``.

    Args:
        name (str): the field (or the word git names it by).
        arg (str): the argument it refused.
    """
    return GitError(f"unrecognized %({_label(name)}) argument: {arg}")


def _no_arg(word: str) -> GitError:
    """git's ``err_no_arg``, which names the field without its ``*``.

    Args:
        word (str): the field's own name.
    """
    return GitError(f"%({word}) does not take arguments")


def refname_option(arg: str | None, name: str) -> tuple[str, int]:
    """``refname_atom_parser_internal``: how a ref name is shown.

    Args:
        arg (str | None): the argument, None for the name as is.
        name (str): the field, for the refusal.
    """
    if arg is None:
        return "", 0
    if arg == "short":
        return "short", 0
    for prefix in ("lstrip=", "strip="):
        if arg.startswith(prefix):
            count = c_int(arg[len(prefix) :])
            if count is None:
                raise GitError(
                    "Integer value expected refname:lstrip="
                    f"{arg[len(prefix) :]}"
                )
            return "lstrip", count
    if arg.startswith("rstrip="):
        count = c_int(arg[len("rstrip=") :])
        if count is None:
            raise GitError(
                "Integer value expected refname:rstrip="
                f"{arg[len('rstrip=') :]}"
            )
        return "rstrip", count
    raise _bad_arg(name, arg)


def _parse_refname(field: RefField) -> RefField:
    option, number = refname_option(field.arg, field.name)
    return replace(field, option=option, number=number)


def _parse_upstream(field: RefField) -> RefField:
    """``remote_ref_atom_parser``: which fact about the upstream shows.

    git hands the refname parser the whole argument rather than the
    word it failed to recognize, so a refname option only parses as the
    argument's one word (``upstream:short,track`` is refused whole).

    Args:
        field (RefField): the field, arguments unparsed.
    """
    if field.arg is None:
        return replace(field, option="ref")
    option, how, count = "ref", "", 0
    words: set[str] = set()
    for word in field.arg.split(","):
        if word in ("track", "trackshort", "remotename", "remoteref"):
            option = word
        elif word == "nobracket":
            words.add(word)
        else:
            option = "ref"
            how, count = refname_option(field.arg, field.name)
    return replace(
        field, option=option, text=how, number=count, words=frozenset(words)
    )


def _no_argument(word: str) -> Callable[[RefField], RefField]:
    """A parser for a field that refuses any argument.

    Args:
        word (str): the field's name, as git's refusal spells it.
    """

    def parse(field: RefField) -> RefField:
        if field.arg is not None:
            raise _no_arg(word)
        return field

    return parse


def _parse_objectsize(field: RefField) -> RefField:
    if field.arg is None:
        return field
    if field.arg == "disk":
        raise UnsupportedFieldError(field.name)
    raise _bad_arg("objectsize", field.arg)


def _parse_subject(field: RefField) -> RefField:
    if field.arg is None:
        return replace(field, option="subject")
    if field.arg == "sanitize":
        return replace(field, option="sanitize")
    raise _bad_arg("subject", field.arg)


def _parse_contents(field: RefField) -> RefField:
    arg = field.arg
    if arg is None:
        return replace(field, option="bare")
    if arg in ("body", "signature", "subject"):
        return replace(field, option=arg)
    if arg == "size":
        return replace(field, option="size", compare=NUMBER)
    if arg == "trailers" or arg.startswith("trailers:"):
        raise UnsupportedFieldError(field.name)
    if arg.startswith("lines="):
        count = c_uint(arg[len("lines=") :])
        if count is None:
            raise GitError(f"positive value expected contents:lines={arg[6:]}")
        return replace(field, option="lines", number=count)
    raise _bad_arg("contents", arg)


def _parse_raw(field: RefField) -> RefField:
    if field.arg is None:
        return replace(field, option="bare")
    if field.arg == "size":
        return replace(field, option="size", compare=NUMBER)
    raise _bad_arg("raw", field.arg)


def _parse_oid(field: RefField) -> RefField:
    """``oid_atom_parser``: a full id, or one abbreviated.

    Args:
        field (RefField): the field, arguments unparsed.
    """
    arg = field.arg
    if arg is None:
        return replace(field, option="full")
    if arg == "short":
        return replace(field, option="short")
    if arg.startswith("short="):
        count = c_uint(arg[len("short=") :])
        if not count:
            raise GitError(
                f"positive value expected '{arg[6:]}' in %({field.name})"
            )
        return replace(
            field, option="length", number=max(count, MINIMUM_ABBREV)
        )
    raise _bad_arg(field.name, arg)


def _parse_person_name(field: RefField) -> RefField:
    if field.arg is None:
        return field
    if field.arg == "mailmap":
        return replace(field, option="mailmap")
    raise _bad_arg(field.name, field.arg)


def _parse_person_email(field: RefField) -> RefField:
    """``person_email_atom_parser``: ``trim``, ``localpart`` and
    ``mailmap``, comma-separated, each a prefix git reads off in turn.

    Args:
        field (RefField): the field, arguments unparsed.
    """
    words: set[str] = set()
    rest = field.arg
    while rest is not None:
        word = next(
            (
                w
                for w in ("trim", "localpart", "mailmap")
                if rest.startswith(w)
            ),
            None,
        )
        if word is None:
            raise _bad_arg(field.name, rest)
        words.add(word)
        rest = rest[len(word) :]
        if not rest:
            break
        if not rest.startswith(","):
            raise _bad_arg(field.name, rest)
        rest = rest[1:]
    return replace(field, words=frozenset(words))


def _parse_align(field: RefField) -> RefField:
    """``align_atom_parser``: a width and a position, in either order.

    Args:
        field (RefField): the field, arguments unparsed.
    """
    if field.arg is None:
        raise GitError("expected format: %(align:<width>,<position>)")
    position, width = "left", None
    for word in field.arg.split(","):
        if word.startswith("position="):
            if word[len("position=") :] not in ALIGN_POSITIONS:
                raise GitError(
                    f"unrecognized position:{word[len('position=') :]}"
                )
            position = word[len("position=") :]
        elif word.startswith("width="):
            width = c_uint(word[len("width=") :])
            if width is None:
                raise GitError(f"unrecognized width:{word[len('width=') :]}")
        elif c_uint(word) is not None:
            width = c_uint(word)
        elif word in ALIGN_POSITIONS:
            position = word
        else:
            raise GitError(f"unrecognized %(align) argument: {word}")
    if width is None:
        raise GitError("positive width expected with the %(align) atom")
    return replace(field, number=width, text=position)


def _parse_if(field: RefField) -> RefField:
    arg = field.arg
    if arg is None:
        return field
    for word in ("equals=", "notequals="):
        if arg.startswith(word):
            return replace(field, option=word[:-1], text=arg[len(word) :])
    raise _bad_arg("if", arg)


PARSERS: dict[str, Callable[[RefField], RefField]] = {
    "refname": _parse_refname,
    "symref": _parse_refname,
    "upstream": _parse_upstream,
    "objecttype": _no_argument("objecttype"),
    "objectsize": _parse_objectsize,
    "objectname": _parse_oid,
    "tree": _parse_oid,
    "parent": _parse_oid,
    "body": _no_argument("body"),
    "subject": _parse_subject,
    "contents": _parse_contents,
    "raw": _parse_raw,
    "HEAD": _no_argument("HEAD"),
    "align": _parse_align,
    "if": _parse_if,
    "rest": _no_argument("rest"),
    **{f"{who}name": _parse_person_name for who in PEOPLE},
    **{f"{who}email": _parse_person_email for who in PEOPLE},
}


def parse_field(name: str) -> RefField:
    """Read one field the way git's ``parse_ref_filter_atom`` does.

    Args:
        name (str): the text between ``%(`` and ``)``, or a sort key
            without its prefixes.

    Raises:
        GitError: a malformed or unknown field, or an argument its
            parser refuses, in git's words.
        UnsupportedFieldError: a real git field this build lacks.
    """
    deref = name.startswith("*")
    body = name[1:] if deref else name
    if not body:
        raise GitError(f"malformed field name: {name}")
    head, _, arg = body.partition(":")
    if head not in FIELDS:
        raise GitError(f"unknown field name: {name}")
    if head in UNSUPPORTED:
        raise UnsupportedFieldError(name)
    source, compare = FIELDS[head]
    if head in DATE_FIELDS and ":" in body:
        compare = TEXT
    field = RefField(
        name=name,
        field=head,
        deref=deref,
        arg=arg or None,
        compare=compare,
        source=source,
    )
    parser = PARSERS.get(head)
    return parser(field) if parser is not None else field


def needs_object(field: RefField) -> bool:
    """Whether a field reads the ref's object, not only its name and id.

    Args:
        field (RefField): the parsed field.
    """
    return (
        field.deref
        or field.source is OBJECT
        or field.field in ("objecttype", "objectsize")
    )


def shorten_ref(name: str, known: frozenset[str], strict: bool = True) -> str:
    """``shorten_unambiguous_ref``: the shortest name that still names
    the ref.

    Each rev-parse rule after the first is tried from the last back, and
    a rule's short name is kept only if no other rule (``strict``, which
    is ``core.warnAmbiguousRefs``) or no earlier one would find a ref
    under it: ``refs/remotes/origin/HEAD`` is ``origin``, and a branch
    that shares its name with a tag keeps its ``heads/``.

    Args:
        name (str): the full ref name.
        known (frozenset[str]): every name that resolves.
        strict (bool): whether a later rule's ref makes it ambiguous too.
    """
    for i in range(len(DWIM_RULES) - 1, 0, -1):
        prefix, _, suffix = DWIM_RULES[i].partition("{}")
        if (
            not name.startswith(prefix)
            or not name.endswith(suffix)
            or len(name) < len(prefix) + len(suffix)
        ):
            continue
        short = name[len(prefix) : len(name) - len(suffix)]
        tried = range(len(DWIM_RULES)) if strict else range(i)
        if not any(
            j != i and DWIM_RULES[j].format(short) in known for j in tried
        ):
            return short
    return name


def _components_to_strip(name: str, count: int) -> int:
    """How many ``/``-separated components a strip count means.

    Args:
        name (str): the ref name.
        count (int): the count as given; a negative one counts the
            components to keep instead.
    """
    return count if count >= 0 else name.count("/") + count + 1


def lstrip_ref(name: str, count: int) -> str:
    """``lstrip_ref_components``: a ref name less its leading components.

    Args:
        name (str): the ref name.
        count (int): components to drop, or to keep when negative.
    """
    remaining = _components_to_strip(name, count)
    parts = name.split("/")
    if remaining <= 0:
        return name
    return "" if remaining >= len(parts) else "/".join(parts[remaining:])


def rstrip_ref(name: str, count: int) -> str:
    """``rstrip_ref_components``: a ref name less its trailing
    components.

    Args:
        name (str): the ref name.
        count (int): components to drop, or to keep when negative.
    """
    remaining = _components_to_strip(name, count)
    parts = name.split("/")
    if remaining <= 0:
        return name
    return (
        ""
        if remaining >= len(parts)
        else "/".join(parts[: len(parts) - remaining])
    )


def show_ref(option: str, count: int, name: str, ctx: RefContext) -> str:
    """A ref name as a ``refname``-style option shows it.

    Args:
        option (str): ``short``, ``lstrip``, ``rstrip`` or empty.
        count (int): the strip count.
        name (str): the full ref name.
        ctx (RefContext): the listing's facts, for ``short``.
    """
    if option == "short":
        return shorten_ref(name, ctx.known, ctx.strict)
    if option == "lstrip":
        return lstrip_ref(name, count)
    if option == "rstrip":
        return rstrip_ref(name, count)
    return name


def _text_of(obj: RefObject) -> str:
    return obj.raw.decode("utf-8", "replace")


def header_line(text: str, who: str) -> str:
    """``find_wholine``: the rest of the buffer after the first header
    line that starts with ``who``, empty when the header has none.

    Args:
        text (str): the object's content.
        who (str): the header word, e.g. ``author``.
    """
    start = 0
    while start < len(text):
        if text.startswith(f"{who} ", start):
            return text[start + len(who) + 1 :]
        end = text.find("\n", start)
        if end == -1 or text.startswith("\n", end + 1):
            return ""
        start = end + 1
    return ""


def header_values(text: str, word: str) -> list[str]:
    """Every header line's value for ``word``, in order (``parent``).

    Args:
        text (str): the object's content.
        word (str): the header word.
    """
    head = text.split("\n\n", 1)[0]
    return [
        line[len(word) + 1 :]
        for line in head.split("\n")
        if line.startswith(f"{word} ")
    ]


def _first_line(text: str) -> str:
    return text.split("\n", 1)[0]


def person_name(line: str) -> str:
    """``copy_name``: the name before the first `` <`` of the line.

    Args:
        line (str): the ident line onward.
    """
    first = _first_line(line)
    marker = first.find(" <")
    return first[:marker] if marker != -1 else ""


def person_email(line: str, words: frozenset[str]) -> str:
    """``copy_email``: the email, bracketed unless trimmed.

    Args:
        line (str): the ident line onward.
        words (frozenset[str]): ``trim``, ``localpart``, ``mailmap``.
    """
    start = line.find("<")
    if start == -1:
        return ""
    if words & {"trim", "localpart"}:
        start += 1
    if "localpart" in words:
        end = line.find("@", start)
        if end == -1:
            end = line.find(">", start)
    elif "trim" in words:
        end = line.find(">", start)
    else:
        end = line.find(">", start)
        end = end + 1 if end != -1 else -1
    return line[start:end] if end != -1 else ""


LEADING_DIGITS = re.compile(r"[ \t\n\v\f\r]*([0-9]*)")
LEADING_ZONE = re.compile(r"[ \t\n\v\f\r]*([+-]?[0-9]+)")


def ident_date(line: str) -> tuple[int, int] | None:
    """The timestamp and offset after an ident's email, as ``grab_date``
    reads them: None when there is no ``> `` to read after.

    Args:
        line (str): the ident line onward.

    Returns:
        tuple[int, int] | None: epoch seconds and the offset in seconds
        east of UTC.
    """
    marker = line.find("> ")
    if marker == -1:
        return None
    rest = line[marker + 2 :]
    stamp = LEADING_DIGITS.match(rest)
    digits = stamp.group(1) if stamp else ""
    timestamp = int(digits) if digits else 0
    zone = LEADING_ZONE.match(rest[stamp.end() if stamp else 0 :])
    hhmm = int(zone.group(1)) if zone else 0
    sign = -1 if hhmm < 0 else 1
    hours, minutes = divmod(abs(hhmm), 100)
    return timestamp, sign * (hours * 3600 + minutes * 60)


def _mailmapped(line: str, ctx: RefContext) -> str:
    """An ident line with the mailmap applied, as
    ``apply_mailmap_to_header`` rewrites it.

    Args:
        line (str): the ident line onward.
        ctx (RefContext): carries the mailmap.
    """
    first, newline, rest = line.partition("\n")
    close = first.rfind(">")
    if close == -1:
        return line
    identity = mapped_identity(first[: close + 1], ctx.mailmap)
    return identity + first[close + 1 :] + newline + rest


def _date_value(line: str, field: RefField, ctx: RefContext) -> FieldValue:
    """``grab_date``: an ident's date in the field's style.

    The style is read only here, when a ref has the ident, so a bad one
    is refused only by a listing that holds such a ref, as git's is.

    Args:
        line (str): the ident line onward.
        field (RefField): the date field.
        ctx (RefContext): carries the clock.
    """
    body = field.name[1:] if field.deref else field.name
    mode = ctx.date
    if ":" in body:
        mode = parse_date_mode(body.split(":", 1)[1], ctx.date)
    found = ident_date(line)
    if found is None:
        return FieldValue("")
    timestamp, offset = found
    return FieldValue(show_date(timestamp, offset, mode), timestamp)


def _person(obj: RefObject, field: RefField, ctx: RefContext) -> FieldValue:
    """``grab_person``: one of an object's idents, or a part of it.

    ``creator`` is the committer of a commit and the tagger of a tag;
    an ident field the object has no header for is empty.

    Args:
        obj (RefObject): the object.
        field (RefField): the person field.
        ctx (RefContext): the listing's facts.
    """
    text = _text_of(obj)
    head = field.field
    if head.startswith("creator"):
        who = {"commit": "committer", "tag": "tagger"}.get(obj.type)
        if who is None:
            return FieldValue("")
        line = header_line(text, who)
        if head == "creator":
            return FieldValue(_first_line(line))
        return _date_value(line, field, ctx)
    who = next(w for w in PEOPLE if head.startswith(w))
    if who not in {"commit": ("author", "committer"), "tag": ("tagger",)}.get(
        obj.type, ()
    ):
        return FieldValue("")
    part = head[len(who) :]
    if part == "" and ":" in field.name:
        return FieldValue("")
    line = header_line(text, who)
    mapped = (part == "name" and field.option == "mailmap") or (
        part == "email" and "mailmap" in field.words
    )
    if mapped:
        line = _mailmapped(line, ctx)
    if part == "":
        return FieldValue(_first_line(line))
    if part == "name":
        return FieldValue(person_name(line))
    if part == "email":
        return FieldValue(person_email(line, field.words))
    return _date_value(line, field, ctx)


def _signature_start(message: str) -> int:
    """``parse_signed_buffer``: where the last signature block begins,
    the message's length when it has none.

    Args:
        message (str): the message, after the header.
    """
    found = len(message)
    start = 0
    while start < len(message):
        if message.startswith(SIGNATURE_MARKERS, start):
            found = start
        end = message.find("\n", start)
        start = len(message) if end == -1 else end + 1
    return found


def message_parts(text: str) -> tuple[str, str, int, int]:
    """``find_subpos``: where an object's subject, body and signature
    lie.

    Args:
        text (str): the object's content.

    Returns:
        tuple[str, str, int, int]: the message from the subject on, the
        subject paragraph, and where in the message the body and the
        signature start (the message's length when it is unsigned).
    """
    cursor = 0
    while cursor < len(text) and text[cursor] != "\n":
        end = text.find("\n", cursor)
        cursor = len(text) if end == -1 else end + 1
    while cursor < len(text) and text[cursor] == "\n":
        cursor += 1
    message = text[cursor:]
    sig = _signature_start(message)
    ends = [
        i for i in (message.find("\n\n"), message.find("\r\n\r\n")) if i != -1
    ]
    end = min(ends[0], sig) if ends else sig
    subject = message[:end].rstrip("\r\n")
    body = end
    while body < len(message) and message[body] in "\r\n":
        body += 1
    return message, subject, body, sig


def _sanitized(subject: str) -> str:
    """``format_sanitized_subject``: a subject fit for a file name.

    Args:
        subject (str): the subject paragraph.
    """
    out: list[str] = []
    space = 2
    i = 0
    while i < len(subject):
        char = subject[i]
        if char in TITLE_CHARS:
            if space == 1:
                out.append("-")
            space = 0
            out.append(char)
            if char == ".":
                while subject.startswith(".", i + 1):
                    i += 1
        else:
            space |= 1
        i += 1
    return "".join(out).rstrip(".-")


def _lines_of(text: str, count: int) -> str:
    """``append_lines``: the first lines of a message, continued lines
    indented by four spaces.

    Args:
        text (str): the message without its signature.
        count (int): how many lines.
    """
    lines = text.split("\n")
    if text.endswith("\n"):
        lines.pop()
    return "\n    ".join(lines[:count])


def _message(obj: RefObject, field: RefField) -> FieldValue:
    """``grab_sub_body_contents``: a message field of a commit or tag.

    ``%(body)`` keeps a tag's signature and ``%(contents:body)`` drops
    it; both are git's own, the first kept for compatibility.

    Args:
        obj (RefObject): the object.
        field (RefField): the message field.
    """
    if obj.type not in ("commit", "tag"):
        return FieldValue("")
    message, subject, body, sig = message_parts(_text_of(obj))
    option = "signed-body" if field.field == "body" else field.option
    if option == "subject":
        return FieldValue(subject.replace("\r\n", "\n").replace("\n", " "))
    if option == "sanitize":
        return FieldValue(_sanitized(subject))
    if option == "signed-body":
        return FieldValue(message[body:])
    if option == "body":
        return FieldValue(message[body:sig])
    if option == "signature":
        return FieldValue(message[sig:])
    if option == "size":
        size = len(message.encode())
        return FieldValue(str(size), size)
    if option == "lines":
        return FieldValue(_lines_of(message[:sig], field.number))
    return FieldValue(message)


def _abbreviated(field: RefField, oid: str, ctx: RefContext) -> str:
    """An id as ``oid_atom_parser`` asked for it.

    Args:
        field (RefField): the id field.
        oid (str): the full hex id.
        ctx (RefContext): carries the repository's abbreviation.
    """
    if field.option not in ("short", "length"):
        return oid
    width = ctx.abbrev if field.option == "short" else field.number
    return oid[: max(width, ctx.abbreviations.get(oid, 0))]


def abbreviation_requests(
    fields: Sequence[RefField], items: Sequence[RefItem], ctx: RefContext
) -> dict[str, int]:
    """The smallest requested width per object id, including peeled ids,
    trees and parents, using the same field readers as rendering.

    Args:
        fields (Sequence[RefField]): the listing's format and sort fields.
        items (Sequence[RefItem]): the selected refs and loaded objects.
        ctx (RefContext): carries the default abbreviation width.
    """
    widths: dict[str, int] = {}
    for atom in fields:
        if atom.field not in (
            "objectname",
            "tree",
            "parent",
        ) or atom.option not in ("short", "length"):
            continue
        width = ctx.abbrev if atom.option == "short" else atom.number
        full = replace(atom, option="")
        for item in items:
            for oid in field_value(full, item, ctx).text.split():
                widths[oid] = min(width, widths.get(oid, len(oid)))
    return widths


def _object_value(
    obj: RefObject, field: RefField, ctx: RefContext
) -> FieldValue:
    """A field read off an object's type, size or content.

    Args:
        obj (RefObject): the ref's object, or what its tag peels to.
        field (RefField): the field.
        ctx (RefContext): the listing's facts.
    """
    head = field.field
    if head == "objecttype":
        return FieldValue(obj.type)
    if head == "objectsize":
        return FieldValue(str(len(obj.raw)), len(obj.raw))
    if head == "objectname":
        return FieldValue(_abbreviated(field, obj.oid, ctx))
    if head == "raw":
        if field.option == "size":
            return FieldValue(str(len(obj.raw)), len(obj.raw))
        return FieldValue(_text_of(obj))
    text = _text_of(obj)
    if obj.type == "tag" and head in ("tag", "type", "object"):
        return FieldValue(_first_line(header_line(text, head)))
    if obj.type == "commit" and head == "tree":
        return FieldValue(
            _abbreviated(field, _first_line(header_line(text, "tree")), ctx)
        )
    if obj.type == "commit" and head == "parent":
        return FieldValue(
            " ".join(
                _abbreviated(field, parent, ctx)
                for parent in header_values(text, "parent")
            )
        )
    if obj.type == "commit" and head == "numparent":
        count = len(header_values(text, "parent"))
        return FieldValue(str(count), count)
    if head in ("subject", "body", "contents"):
        return _message(obj, field)
    if head.startswith(PEOPLE) or head.startswith("creator"):
        return _person(obj, field, ctx)
    return FieldValue("")


def field_value(field: RefField, item: RefItem, ctx: RefContext) -> FieldValue:
    """One field's value for one ref, as git's ``populate_value`` fills
    it.

    Args:
        field (RefField): the parsed field.
        item (RefItem): the ref, with the objects its fields read.
        ctx (RefContext): the listing's facts.
    """
    head = field.field
    if head in ("refname", "symref"):
        if head == "symref":
            name = (
                show_ref(field.option, field.number, item.symref, ctx)
                if item.symref
                else ""
            )
        elif item.kind is RefKind.DETACHED:
            name = ctx.head_description
        else:
            name = show_ref(field.option, field.number, item.name, ctx)
        return FieldValue(f"{name}^{{}}" if field.deref else name)
    if head == "worktreepath":
        return FieldValue(item.worktree if item.kind is RefKind.BRANCH else "")
    if head == "upstream":
        return FieldValue(_upstream_text(field, item, ctx))
    if head == "HEAD":
        return FieldValue(
            "*" if ctx.head is not None and item.name == ctx.head else " "
        )
    if head == "if":
        body = field.name[1:] if field.deref else field.name
        return FieldValue(body[3:] if body.startswith("if:") else "")
    if head in ("align", "end", "then", "else", "rest"):
        return FieldValue("")
    if head == "objectname" and not field.deref:
        return FieldValue(_abbreviated(field, item.oid, ctx))
    if field.deref:
        if item.obj is None or item.obj.type != "tag" or item.peeled is None:
            return FieldValue("")
        return _object_value(item.peeled, field, ctx)
    if item.obj is None:
        return FieldValue("")
    return _object_value(item.obj, field, ctx)


def _upstream_text(field: RefField, item: RefItem, ctx: RefContext) -> str:
    """``fill_remote_ref_details``: what an ``upstream`` field shows.

    Only a local branch has an upstream, and only one whose merge ref
    maps to a ref shows anything; the counts come from the loader.

    Args:
        field (RefField): the upstream field.
        item (RefItem): the ref.
        ctx (RefContext): the listing's facts.
    """
    up = item.upstream
    if up is None or not item.name.startswith("refs/heads/"):
        return ""
    if field.option == "track":
        if up.gone:
            text = "gone"
        else:
            parts = ([f"ahead {up.ahead}"] if up.ahead else []) + (
                [f"behind {up.behind}"] if up.behind else []
            )
            text = ", ".join(parts)
        return f"[{text}]" if text and "nobracket" not in field.words else text
    if field.option == "trackshort":
        if up.gone:
            return ""
        return {
            (False, False): "=",
            (False, True): "<",
            (True, False): ">",
            (True, True): "<>",
        }[(bool(up.ahead), bool(up.behind))]
    if field.option == "remotename":
        return up.remote
    if field.option == "remoteref":
        return up.merge
    return show_ref(field.text, field.number, up.ref, ctx)
