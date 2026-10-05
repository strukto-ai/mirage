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

from typing import Any

from mirage.commands.cli.builtin.gh.accessor import (
    body_value,
    camel,
    csv_values,
    gh_bool,
    list_limit,
    repo_for,
    text_out,
    typed_out,
)
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.core.github.config import GhConfig
from mirage.core.github.release import (
    create_release,
    get_latest_release,
    get_release,
    list_releases,
)
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue

RELEASE_FIELDS = (
    "body",
    "createdAt",
    "isDraft",
    "isLatest",
    "isPrerelease",
    "name",
    "publishedAt",
    "tagName",
    "targetCommitish",
    "url",
)


def _release(value: JsonValue) -> dict[str, Any]:
    row = camel(value)
    result = row if isinstance(row, dict) else {}
    if "draft" in result:
        result["isDraft"] = result.pop("draft")
    if "prerelease" in result:
        result["isPrerelease"] = result.pop("prerelease")
    result.setdefault("isLatest", False)
    return result


def _list_line(row: dict[str, Any]) -> str:
    kind = (
        "Draft"
        if row.get("isDraft")
        else "Pre-release"
        if row.get("isPrerelease")
        else "Latest"
        if row.get("isLatest")
        else ""
    )
    return (
        f"{row.get('name', '')}\t{row.get('tagName', '')}\t{kind}\t"
        f"{row.get('publishedAt', '')}\n"
    )


def _list_text(rows: list[dict[str, Any]]) -> str:
    return "".join(_list_line(row) for row in rows)


async def list_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    rows = [
        _release(value)
        for value in await list_releases(
            inv.config, repo_for(inv, fl), list_limit(fl, 30)
        )
    ]
    latest = next(
        (
            row
            for row in rows
            if not row.get("isDraft") and not row.get("isPrerelease")
        ),
        None,
    )
    if latest is not None:
        latest["isLatest"] = True
    return await typed_out(rows, fl, _list_text(rows), RELEASE_FIELDS)


async def view_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    tag = inv.texts[0] if inv.texts else ""
    if not tag:
        raise ValueError("a release tag is required")
    ref = repo_for(inv, fl)
    row = _release(await get_release(inv.config, ref, tag))
    if "isLatest" in csv_values([fl.as_str("json") or ""]):
        latest = await get_latest_release(inv.config, ref)
        latest_row = _release(latest) if latest is not None else {}
        row["isLatest"] = latest_row.get("tagName") == row.get("tagName")
    human = (
        f"title:\t{row.get('name', '')}\n"
        f"tag:\t{row.get('tagName', '')}\n"
        f"draft:\t{str(bool(row.get('isDraft'))).lower()}\n"
        f"prerelease:\t{str(bool(row.get('isPrerelease'))).lower()}\n--\n"
        f"{row.get('body', '')}\n"
    )
    return await typed_out(row, fl, human, RELEASE_FIELDS)


async def create_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    tag = inv.texts[0] if inv.texts else ""
    if not tag:
        raise ValueError("a release tag is required in noninteractive mode")
    notes = await body_value(inv, fl, value="notes", file="notes_file")
    body: dict[str, JsonValue] = {
        "tag_name": tag,
        "name": fl.as_str("title") or tag,
        "body": notes or "",
        "draft": gh_bool(fl, "draft"),
        "prerelease": gh_bool(fl, "prerelease"),
        "generate_release_notes": gh_bool(fl, "generate_notes"),
    }
    if fl.as_str("target") is not None:
        body["target_commitish"] = fl.as_str("target") or ""
    created = _release(
        await create_release(inv.config, repo_for(inv, fl), body)
    )
    return text_out(f"{created.get('url', '')}\n")
