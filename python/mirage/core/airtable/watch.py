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
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from mirage.accessor.airtable import AirtableAccessor
from mirage.core.airtable.client import (
    list_bases,
    list_tables,
    list_webhooks,
    webhook_payloads,
)
from mirage.core.airtable.errors import AirtableAPIError
from mirage.core.airtable.normalize import as_row, as_rows
from mirage.core.airtable.pathing import base_dirname, table_dirname
from mirage.core.airtable.scope import detect_scope
from mirage.types import Delta, FileChangeKind, FileEvent, PathSpec
from mirage.watch.base import DeltaHook
from mirage.watch.delta import events_under
from mirage.watch.events import event_at, text_field

logger = logging.getLogger(__name__)

_RECORD_KEYS = (
    "createdRecordsById",
    "changedRecordsById",
    "destroyedRecordIds",
    "createdFieldsById",
    "changedFieldsById",
    "destroyedFieldIds",
)
_SCHEMA_KEYS = (
    "createdFieldsById",
    "changedFieldsById",
    "destroyedFieldIds",
    "changedMetadata",
)


@dataclass
class _BaseFeed:
    """What a pull keeps for one base: its directory, each webhook's
    next cursor, and each table's directory.
    """

    dir: str
    hooks: dict[str, int] = field(default_factory=dict)
    tables: dict[str, str] = field(default_factory=dict)


def _encode(feeds: dict[str, _BaseFeed]) -> str:
    return json.dumps(
        {"airtable": {k: asdict(v) for k, v in feeds.items()}},
        sort_keys=True,
    )


def _decode(checkpoint: str | None) -> dict[str, _BaseFeed] | None:
    """The bases a checkpoint keeps, None for a baseline.

    Args:
        checkpoint (str | None): What the previous pull handed out.
    """
    if checkpoint is None:
        return None
    state = as_row(json.loads(checkpoint).get("airtable"))
    return {
        str(base_id): _BaseFeed(
            dir=str(as_row(feed).get("dir")),
            hooks={
                str(k): int(v) for k, v in as_row(feed.get("hooks")).items()
            },
            tables={
                str(k): str(v) for k, v in as_row(feed.get("tables")).items()
            },
        )
        for base_id, feed in state.items()
    }


class _Changes:
    """The changes a pull found, each once, in the order found."""

    def __init__(self) -> None:
        self.found: dict[tuple[FileChangeKind, str], None] = {}
        self.lost = False

    def add(self, kind: FileChangeKind, path: str) -> None:
        self.found[(kind, path)] = None


class AirtableDeltaHook:
    """What changed in the Airtable bases under a watch root since the
    last cursors, for the consumer to call when Airtable pings.

    An Airtable webhook's notification names the base, the webhook and a
    time, never the change, so each ping is answered by reading, for
    every webhook on each base the root covers, its ``payloads`` from
    the cursor the last pull kept. The bases are those the root names,
    or the account's (``list_bases``) when the root is above them, as
    ``readdir`` lists them. A baseline takes each webhook's
    ``cursorForNextPayload`` and each base's table names and reports
    nothing. A webhook made after the last pull is read from its first
    payload, and a base the last pull did not cover is UNKNOWN.

    A payload names tables by id, so the checkpoint keeps each table's
    directory, named from the base schema the first time and kept
    current by the renames the payloads carry. A record or field change
    updates the table's ``records.jsonl``, and a field or description
    change its ``table.json``; which saved views show a record is the
    view's own filter, so a table's ``views`` is UNKNOWN when its
    records change. A table made, renamed or destroyed also updates
    ``base.json``, which lists the tables; a renamed table moves
    everything below it, so its old and new directory are UNKNOWN.

    Airtable keeps payloads for seven days, and a cursor older than that
    reads from the oldest left, which shows as a later cursor than the
    payloads read account for. That, a webhook the last pull read that
    is gone, and a payload marked ``error`` all mean changes were lost,
    so the watch root is UNKNOWN and the base's table names are read
    from its schema again.
    """

    def __init__(self, accessor: AirtableAccessor) -> None:
        """Args:
        accessor (AirtableAccessor): Backend handle.
        """
        self._accessor = accessor

    async def _bases(self, root: PathSpec) -> dict[str, str]:
        """The bases the root covers that the mount shows, each with its
        directory.

        Args:
            root (PathSpec): Watch root.
        """
        base_id = detect_scope(root.vfs_path).slots.get("base_id")
        if base_id is not None:
            wanted = self._accessor.config.base_ids
            if wanted is not None and base_id not in wanted:
                return {}
            return {base_id: root.vfs_path.strip("/").split("/")[1]}
        return {
            str(base["id"]): base_dirname(base)
            for base in await list_bases(self._accessor)
        }

    async def _tables(self, base_id: str) -> dict[str, str]:
        """Each table's directory, from the base schema.

        Args:
            base_id (str): The base.
        """
        return {
            str(table["id"]): table_dirname(table)
            for table in await list_tables(self._accessor, base_id)
        }

    async def _present(self, base_id: str, base_dir: str) -> _BaseFeed:
        """A base's webhooks at their present cursors, and its tables.

        Args:
            base_id (str): The base.
            base_dir (str): Its directory.
        """
        hooks = {
            str(hook["id"]): int(hook.get("cursorForNextPayload") or 1)
            for hook in await list_webhooks(self._accessor, base_id)
        }
        return _BaseFeed(base_dir, hooks, await self._tables(base_id))

    async def _payloads(
        self, base_id: str, hook_id: str, cursor: int
    ) -> tuple[list[dict[str, Any]], int | None, bool]:
        """Every payload of a webhook from ``cursor``, the cursor after
        them (None when the webhook is gone), and whether any were lost.

        Args:
            base_id (str): The base.
            hook_id (str): The webhook.
            cursor (int): The first to read; a webhook numbers its
                payloads from 1.
        """
        found: list[dict[str, Any]] = []
        lost = False
        while True:
            try:
                page = await webhook_payloads(
                    self._accessor, base_id, hook_id, cursor
                )
            except AirtableAPIError as exc:
                if not exc.not_found:
                    raise
                logger.debug("airtable webhook %s is gone: %s", hook_id, exc)
                return found, None, True
            rows = as_rows(page.get("payloads"))
            found.extend(rows)
            after = page.get("cursor")
            if not isinstance(after, int):
                return found, cursor, lost
            if after - cursor > len(rows):
                lost = True
            more = page.get("mightHaveMore") is True and after != cursor
            cursor = after
            if not more:
                return found, cursor, lost

    async def _map(
        self,
        base_id: str,
        feed: _BaseFeed,
        payload: dict[str, Any],
        changes: _Changes,
    ) -> bool:
        """Add the changes one payload names, and say whether it is the
        error payload a webhook leaves when it lost changes.

        Args:
            base_id (str): The base.
            feed (_BaseFeed): What the pull keeps for it, kept current.
            payload (dict[str, Any]): One webhook payload.
            changes (_Changes): Where the changes go.
        """
        if payload.get("error") is True:
            return True
        base = f"bases/{feed.dir}"
        for table_id, made in as_row(payload.get("createdTablesById")).items():
            name = text_field(as_row(made).get("metadata"), "name")
            made_dir = f"{base}/" + table_dirname(
                {"id": table_id, "name": name}
            )
            feed.tables[table_id] = made_dir.rsplit("/", 1)[1]
            changes.add(FileChangeKind.CREATE, f"{made_dir}/table.json")
            changes.add(FileChangeKind.CREATE, f"{made_dir}/records.jsonl")
            changes.add(FileChangeKind.UNKNOWN, f"{made_dir}/views")
            changes.add(FileChangeKind.UPDATE, f"{base}/base.json")
        destroyed = payload.get("destroyedTableIds")
        for table_id in destroyed if isinstance(destroyed, list) else []:
            gone = feed.tables.pop(str(table_id), "")
            if gone:
                changes.add(FileChangeKind.DELETE, f"{base}/{gone}")
            else:
                changes.add(FileChangeKind.UNKNOWN, base)
            changes.add(FileChangeKind.UPDATE, f"{base}/base.json")
        for table_id, changed in as_row(
            payload.get("changedTablesById")
        ).items():
            body = as_row(changed)
            table = feed.tables.get(table_id)
            if table is None:
                feed.tables.update(await self._tables(base_id))
                table = feed.tables.get(table_id)
            renamed = text_field(
                as_row(body.get("changedMetadata")).get("current"), "name"
            )
            if renamed is not None:
                now = table_dirname({"id": table_id, "name": renamed})
                if table is not None and table != now:
                    changes.add(FileChangeKind.UNKNOWN, f"{base}/{table}")
                feed.tables[table_id] = now
                changes.add(FileChangeKind.UNKNOWN, f"{base}/{now}")
                changes.add(FileChangeKind.UPDATE, f"{base}/base.json")
                continue
            if table is None:
                changes.add(FileChangeKind.UNKNOWN, base)
                continue
            where = f"{base}/{table}"
            if any(body.get(key) is not None for key in _SCHEMA_KEYS):
                changes.add(FileChangeKind.UPDATE, f"{where}/table.json")
            if any(body.get(key) is not None for key in _RECORD_KEYS):
                changes.add(FileChangeKind.UPDATE, f"{where}/records.jsonl")
                changes.add(FileChangeKind.UNKNOWN, f"{where}/views")
            elif body.get("changedViewsById") is not None:
                changes.add(FileChangeKind.UNKNOWN, f"{where}/views")
        return False

    async def _read(
        self,
        base_id: str,
        feed: _BaseFeed,
        was: dict[str, int],
        changes: _Changes,
    ) -> None:
        """Read each of a base's webhooks from its kept cursor, and one
        first seen since from its first payload, so a new webhook whose
        first payloads expired lost them too.

        A lost payload may have made, renamed or destroyed a table, so a
        base that lost any names its tables from the schema again.

        Args:
            base_id (str): The base.
            feed (_BaseFeed): What the pull keeps for it, filled in.
            was (dict[str, int]): Each webhook's cursor the last pull kept.
            changes (_Changes): Where the changes go.
        """
        listed = [
            str(hook["id"])
            for hook in await list_webhooks(self._accessor, base_id)
        ]
        lost = bool(set(was) - set(listed))
        for hook_id in listed:
            payloads, cursor, gap = await self._payloads(
                base_id, hook_id, was.get(hook_id, 1)
            )
            lost = lost or gap
            for payload in payloads:
                lost = await self._map(base_id, feed, payload, changes) or lost
            if cursor is not None:
                feed.hooks[hook_id] = cursor
        if lost:
            feed.tables = await self._tables(base_id)
            changes.lost = True

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Return the changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Watch root.
            checkpoint (str | None): The previous pull's state, or None
                for a baseline.
        """
        state = _decode(checkpoint)
        observed = datetime.now(timezone.utc)
        bases = await self._bases(root)
        if state is None:
            return Delta(
                (),
                _encode(
                    {
                        base_id: await self._present(base_id, base_dir)
                        for base_id, base_dir in bases.items()
                    }
                ),
            )
        changes = _Changes()
        feeds: dict[str, _BaseFeed] = {}
        for base_id, base_dir in bases.items():
            kept = state.get(base_id)
            if kept is None:
                feeds[base_id] = await self._present(base_id, base_dir)
                changes.add(FileChangeKind.UNKNOWN, f"bases/{base_dir}")
                continue
            if kept.dir != base_dir:
                changes.add(FileChangeKind.UNKNOWN, f"bases/{kept.dir}")
                changes.add(FileChangeKind.UNKNOWN, f"bases/{base_dir}")
            feed = _BaseFeed(base_dir, {}, dict(kept.tables))
            await self._read(base_id, feed, kept.hooks, changes)
            feeds[base_id] = feed
        for base_id, kept in state.items():
            if base_id not in bases:
                changes.add(FileChangeKind.DELETE, f"bases/{kept.dir}")
        events = events_under(
            root,
            (event_at(root, path, kind) for kind, path in changes.found),
        )
        if changes.lost:
            events.insert(
                0,
                FileEvent(
                    kind=FileChangeKind.UNKNOWN, path=root, timestamp=observed
                ),
            )
        return Delta(tuple(events), _encode(feeds))


def build_delta_hook(accessor: AirtableAccessor) -> DeltaHook:
    """Build the Airtable delta hook.

    Args:
        accessor (AirtableAccessor): Backend handle.
    """
    return AirtableDeltaHook(accessor)
