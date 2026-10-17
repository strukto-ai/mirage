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
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.accessor.airtable import AirtableAccessor
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.core.airtable.config import AirtableConfig
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec

Outcome = tuple[ByteSource | None, IOResult]

Verb = Callable[
    [AirtableAccessor, list[str], Context, FlagView], Awaitable[Outcome]
]


def no_operands(texts: list[str]) -> None:
    """Refuse an operand on a verb that takes none.

    Args:
        texts (list[str]): the line's operands.
    """
    if texts:
        raise UsageError(f"unrecognized arguments: {' '.join(texts)}")


def one_operand(texts: list[str], name: str) -> str:
    """The one operand a verb requires.

    Args:
        texts (list[str]): the line's operands.
        name (str): the operand's name in the verb's usage line.
    """
    if not texts:
        raise UsageError(f"the following arguments are required: {name}")
    no_operands(texts[1:])
    return texts[0]


def optional_operand(texts: list[str]) -> str | None:
    """The operand a verb may take once, None when the line has none.

    Args:
        texts (list[str]): the line's operands.
    """
    no_operands(texts[1:])
    return texts[0] if texts else None


def scoped_base(config: AirtableConfig, base_id: str) -> str:
    """The base a line addresses, refused when ``base_ids`` excludes it.

    Refused here, before any request, so a base the install was not
    given is never reached: the scope the mount enforces on reads. The
    executor prefixes the refusal with the words the line was typed
    under, ``<head> base get: <base-id>: Permission denied``, exit 1.

    Args:
        config (AirtableConfig): the install and its scope.
        base_id (str): the base id the line names.

    Raises:
        PermissionError: the base is outside ``base_ids`` (EACCES).
    """
    wanted = config.base_ids
    if wanted is not None and base_id not in wanted:
        raise PermissionError(f"{base_id}: Permission denied")
    return base_id


def find_table(
    tables: list[dict[str, Any]], ref: str
) -> dict[str, Any] | None:
    """The schema table a line names, by id first and then by name.

    Airtable takes either spelling in a path, and an id can never be
    another table's name, so the id match wins.

    Args:
        tables (list[dict[str, Any]]): the base's schema tables.
        ref (str): the table, by id or by name.
    """
    return next((t for t in tables if t.get("id") == ref), None) or next(
        (t for t in tables if t.get("name") == ref), None
    )


def _no_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def parse_json(text: str) -> Any:
    """Decode strict JSON: NaN and Infinity are refused, as JSON.parse does.

    Args:
        text (str): the JSON text.
    """
    return json.loads(text, parse_constant=_no_constant)


def json_object(flag: str, text: str) -> dict[str, Any]:
    """A flag's value decoded as a JSON object.

    Args:
        flag (str): the flag's spelling, for the refusal.
        text (str): the value as typed.
    """
    try:
        value = parse_json(text)
    except ValueError as exc:
        raise UsageError(f"{flag} must be valid JSON") from exc
    if not isinstance(value, dict):
        raise UsageError(f"{flag} must be a JSON object")
    return value


async def stdin_text(stdin: ByteSource) -> str:
    """Piped input as text, a leading byte order mark dropped.

    Args:
        stdin (ByteSource): the line's stdin.
    """
    return (await materialize(stdin)).decode("utf-8-sig", errors="replace")


async def run(
    verb: Verb,
    accessor: AirtableAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> Outcome:
    """Run one verb on the install's accessor.

    The accessor outlives the line: the workspace closes it with the
    install, so every line of one install rides one connection pool. A
    verb never names itself: the CLI may be installed under any head
    word, so a refusal is left to the executor, which prefixes it with
    the words the line was typed under.

    Args:
        verb (Verb): the verb's body.
        accessor (AirtableAccessor): the install's accessor.
        paths (list[PathSpec]): the cwd-resolved path operands.
        texts (list[str]): the line's operands.
        ctx (Context): the leaf's context.
    """
    return await verb(accessor, texts, ctx, FlagView(ctx.flags, ctx.spec))
