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

# Relation behavior adapted from schpet/linear-cli v3.1.0,
# 02571d34be662e5487204841fb80bf23ed79b4f0, ISC.
# Copyright (c) Peter Schilling and contributors.
# See licenses/third_party/schpet-linear-cli.txt for the permission notice.

import re
from urllib.parse import unquote, urlsplit

from mirage.accessor.linear import LinearAccessor
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.linear.client import (
    RelationType,
    get_relation_issue,
    issue_relation_create,
    issue_relation_delete,
    list_issue_relations,
    relation_input,
)
from mirage.core.linear.normalize import normalize_relation
from mirage.core.render.json import json_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

ISSUE_KEY_RE = re.compile(r"^[A-Za-z0-9]+-[1-9][0-9]*$")
RAW_ID_RE = re.compile(
    r"^(?:[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_-]+)$"
)


def prepare_reference(token: str) -> str:
    if ISSUE_KEY_RE.fullmatch(token):
        return token.upper()
    if RAW_ID_RE.fullmatch(token):
        return token
    candidate = token.strip()
    if candidate.lower().startswith(("linear.app/", "www.linear.app/")):
        candidate = "https://" + candidate
    try:
        url = urlsplit(candidate)
        parts: list[str] = []
        for encoded in url.path.split("/"):
            part = unquote(encoded, errors="strict")
            if part == ".":
                continue
            if part == "..":
                if parts:
                    parts.pop()
            else:
                parts.append(part)
        parts = [part for part in parts if part]
        host = (url.hostname or "").removesuffix(".").lower()
        default_port = 443 if url.scheme == "https" else 80
        if (
            url.scheme in ("http", "https")
            and host in ("linear.app", "www.linear.app")
            and url.port in (None, default_port)
            and not url.username
            and not url.password
        ):
            anchor_ok = not url.fragment or re.fullmatch(
                r"comment-[0-9a-f]{8}", url.fragment
            )
            if (
                len(parts) >= 3
                and parts[1] == "issue"
                and ISSUE_KEY_RE.fullmatch(parts[2])
                and anchor_ok
            ):
                return parts[2].upper()
    except ValueError as exc:
        raise ValueError(f"invalid issue reference: {token}") from exc
    raise ValueError(f"invalid issue reference: {token}")


def relation_operands(texts: list[str]) -> tuple[str, RelationType, str]:
    if len(texts) != 3:
        raise ValueError("expected ISSUE RELATION RELATED")
    try:
        kind = RelationType(texts[1].lower())
    except ValueError:
        raise ValueError(f"invalid relation type: {texts[1]}") from None
    return prepare_reference(texts[0]), kind, prepare_reference(texts[2])


async def add(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    source, kind, target = relation_operands(texts)
    issue = await get_relation_issue(accessor, source)
    related = await get_relation_issue(accessor, target)
    relation = await issue_relation_create(
        accessor, relation_input(kind, issue["id"], related["id"])
    )
    return json_bytes(normalize_relation(relation, issue["id"])), IOResult()


async def list_relations(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    if len(texts) != 1:
        raise ValueError("expected ISSUE")
    issue = await get_relation_issue(accessor, prepare_reference(texts[0]))
    outgoing = await list_issue_relations(accessor, issue["id"])
    incoming = await list_issue_relations(accessor, issue["id"], incoming=True)
    return json_bytes(
        [normalize_relation(row, issue["id"]) for row in outgoing + incoming]
    ), IOResult()


async def delete_relation(
    accessor: LinearAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    source, kind, target = relation_operands(texts)
    issue = await get_relation_issue(accessor, source)
    related = await get_relation_issue(accessor, target)
    payload = relation_input(kind, issue["id"], related["id"])
    relations = await list_issue_relations(accessor, payload["issueId"])
    relation = next(
        (
            row
            for row in relations
            if row["type"] == payload["type"]
            and row["relatedIssue"]["id"] == payload["relatedIssueId"]
        ),
        None,
    )
    if relation is None:
        raise FileNotFoundError(f"relation {source} {kind.value} {target}")
    if not FlagView(ctx.flags).as_bool("yes"):
        raise ValueError("--yes is required to delete a relation")
    await issue_relation_delete(accessor, relation["id"])
    return json_bytes(normalize_relation(relation, issue["id"])), IOResult()
