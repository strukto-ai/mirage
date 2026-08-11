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

import json

from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.core.notion.config import NotionConfig
from mirage.io.types import ByteSource, materialize
from mirage.types import JsonValue

CHECKED = "✓"


async def content_or_stdin(inline: str | None,
                           stdin: ByteSource | None) -> str:
    """Resolve Markdown from `--content` or the pipe.

    The upstream CLI's third source is ``$EDITOR``, which a virtualized
    CLI has no terminal for, so the two non-interactive sources are the
    whole surface here.

    Args:
        inline (str | None): the ``--content`` value.
        stdin (ByteSource | None): piped input.

    Returns:
        str: the Markdown body.
    """
    if inline is not None:
        return inline
    if stdin is None:
        raise UsageError("provide Markdown with --content or on stdin")
    return (await materialize(stdin)).decode("utf-8", "replace")


def pretty_json(value: JsonValue) -> bytes:
    """Render a payload the way `ntn <verb> --json` does.

    Two spaces of indent and keys in sorted order, matching the
    upstream binary's serializer, so a golden recorded from the real
    CLI compares byte for byte.

    Args:
        value (JsonValue): the payload to render.

    Returns:
        bytes: the rendered JSON with its trailing newline.
    """
    text = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False)
    return f"{text}\n".encode()


def compact_json(value: JsonValue) -> bytes:
    """Render a payload the way `ntn api` does: one line, sorted keys.

    Args:
        value (JsonValue): the payload to render.

    Returns:
        bytes: the rendered JSON with its trailing newline.
    """
    text = json.dumps(value,
                      separators=(",", ":"),
                      sort_keys=True,
                      ensure_ascii=False)
    return f"{text}\n".encode()


def rust_debug(text: str) -> str:
    """Quote a string the way Rust's `{:?}` renders one.

    `ntn` interpolates the offending token into its parse errors with
    the Debug formatter, so a token carrying a quote, a backslash or a
    tab comes back escaped. Non-ASCII is left alone, which is why an
    accented character appears verbatim in the real binary's message.

    Args:
        text (str): the token to render.

    Returns:
        str: the token wrapped in quotes, escaped as Rust escapes it.
    """
    out = ['"']
    for char in text:
        if char in ('"', "\\"):
            out.append(f"\\{char}")
        elif char == "\n":
            out.append("\\n")
        elif char == "\r":
            out.append("\\r")
        elif char == "\t":
            out.append("\\t")
        elif ord(char) < 0x20 or ord(char) == 0x7F:
            out.append(f"\\u{{{ord(char):x}}}")
        else:
            out.append(char)
    out.append('"')
    return "".join(out)


def first_text(texts: tuple[str, ...], what: str) -> str:
    """Take the leading positional operand or refuse the line.

    Args:
        texts (tuple[str, ...]): the leaf's text operands.
        what (str): what the operand names, for the message.

    Returns:
        str: the first operand.
    """
    if not texts:
        raise UsageError(f"{what} is required")
    return texts[0]


def plain_text_of(fragments: JsonValue) -> str:
    """Join a rich-text array down to its plain text.

    Args:
        fragments (JsonValue): a Notion rich-text array.

    Returns:
        str: the concatenated plain text.
    """
    if not isinstance(fragments, list):
        return ""
    out = ""
    for fragment in fragments:
        if isinstance(fragment, dict):
            text = fragment.get("plain_text")
            if isinstance(text, str):
                out += text
    return out


def property_cell(prop: JsonValue) -> str:
    """Render one property value as `ntn datasources query` prints it.

    The formats are pinned against the real binary: a checked box is a
    check mark and an unchecked one is empty, a date shows its start, a
    multi-select joins with a comma and a space, and anything unset is
    the empty string.

    Args:
        prop (JsonValue): one entry of a page's ``properties``.

    Returns:
        str: the cell text, empty when the value is unset.
    """
    if not isinstance(prop, dict):
        return ""
    kind = prop.get("type")
    value = prop.get(kind) if isinstance(kind, str) else None
    if kind in ("title", "rich_text"):
        return plain_text_of(value)
    if kind == "checkbox":
        return CHECKED if value is True else ""
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return ""
        return str(int(value)) if float(value).is_integer() else str(value)
    if kind == "select" or kind == "status":
        return str(value.get("name", "")) if isinstance(value, dict) else ""
    if kind == "multi_select":
        if not isinstance(value, list):
            return ""
        names = [
            str(one.get("name", "")) for one in value if isinstance(one, dict)
        ]
        return ", ".join(names)
    if kind == "date":
        return str(value.get("start", "")) if isinstance(value, dict) else ""
    if kind == "people":
        if not isinstance(value, list):
            return ""
        return ", ".join(
            str(one.get("name", "")) for one in value if isinstance(one, dict))
    if isinstance(value, str):
        return value
    if isinstance(value, bool) or value is None:
        return ""
    return str(value)


def parse_json_text(text: str, flag: str) -> dict[str, JsonValue]:
    """Parse a JSON object out of already-resolved text.

    Args:
        text (str): the JSON source.
        flag (str): the flag's spelling for error messages.

    Returns:
        dict: the parsed object, empty when the text is empty.
    """
    if text == "":
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        # One wording in both languages: the engines' own parse messages
        # ("Expecting value" vs "Unexpected token") can never agree.
        raise UsageError(f"{flag} must be valid JSON") from exc
    if not isinstance(parsed, dict):
        raise UsageError(f"{flag} must be a JSON object")
    return parsed


def parse_json_flag(value: FlagValue | None,
                    flag: str) -> dict[str, JsonValue]:
    """Parse a JSON-object flag, sharing the gws wording.

    Args:
        value (FlagValue | None): the raw flag value from the bag.
        flag (str): the flag's spelling for error messages.

    Returns:
        dict: the parsed object, empty when the flag is absent.
    """
    if value is None or value == "":
        return {}
    if not isinstance(value, str):
        raise UsageError(f"{flag} must be a JSON string")
    return parse_json_text(value, flag)


def notion_config(inv: CLIInvocation[NotionConfig]) -> NotionConfig:
    """The install's config with this line's Notion-Version applied.

    ``--notion-version`` is upstream's per-invocation override of the
    header, and the executor has already filled it from
    ``NOTION_API_VERSION`` when the line omitted it, so a verb reads one
    flag and never the environment. Every verb goes through here rather
    than passing ``inv.config`` straight down, or the override would
    work on whichever verbs remembered it.

    Args:
        inv (CLIInvocation): the line's invocation record.

    Returns:
        NotionConfig: the config to hand the transport.
    """
    version = FlagView(inv.flags).as_str("notion_version")
    if not version:
        return inv.config
    return inv.config.model_copy(update={"api_version": version})
