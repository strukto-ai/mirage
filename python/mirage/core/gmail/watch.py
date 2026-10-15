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
from datetime import datetime, timezone
from http import HTTPStatus
from typing import Any

import aiohttp

from mirage.accessor.gmail import GmailAccessor
from mirage.core.gmail.history import current_history_id, list_history
from mirage.core.gmail.labels import list_labels
from mirage.core.gmail.messages import (
    _extract_attachments,
    _extract_header,
    get_message_raw,
)
from mirage.core.gmail.readdir import (
    MSG_SUFFIX,
    _attach_dir_name,
    _date_from_internal,
    _msg_filename,
)
from mirage.core.google.client import TokenManager
from mirage.types import Delta, FileChangeKind, FileEvent, PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.watch.base import DeltaHook
from mirage.watch.delta import spec_for

logger = logging.getLogger(__name__)


def message_paths(
    prefix: str,
    raw: dict[str, Any],
    labels: dict[str, dict[str, Any]],
    label_ids: list[str],
) -> list[str]:
    """The paths a message is under ``label_ids``: its file in each label's
    day directory, and its attachment directory beside it when it has
    attachments, named as the listings name them.

    Args:
        prefix (str): The mount's prefix.
        raw (dict[str, Any]): The full message.
        labels (dict[str, dict[str, Any]]): The mailbox's labels, by id.
        label_ids (list[str]): The labels to name it under.
    """
    mid = raw["id"]
    headers = raw.get("payload", {}).get("headers", [])
    subject = _extract_header(headers, "Subject") or "No Subject"
    day = _date_from_internal(raw.get("internalDate", "0"))
    attached = bool(_extract_attachments(raw.get("payload", {})))
    paths: list[str] = []
    for label_id in label_ids:
        label = labels.get(label_id)
        if label is None:
            continue
        name = label_id if label.get("type") == "system" else label["name"]
        base = f"{prefix}/{name}/{day}"
        paths.append(f"{base}/{_msg_filename(subject, mid)}")
        if attached:
            paths.append(f"{base}/{_attach_dir_name(subject, mid)}")
    return paths


def label_folders(labels: list[dict[str, Any]]) -> dict[str, str]:
    """Each label's folder name, by label id, as the root listing names it:
    a system label by its id, any other by its name.

    Args:
        labels (list[dict[str, Any]]): The mailbox's labels.
    """
    return {
        lb["id"]: lb["id"]
        if lb.get("type") == "system"
        else lb.get("name", lb["id"])
        for lb in labels
    }


def _folders_moved(
    changes: list[tuple[FileChangeKind, str]],
    known: dict[str, list[str]],
    prefix: str,
    before: dict[str, str],
    after: dict[str, str],
) -> None:
    """Record each label folder that left or was renamed, then each that
    appeared or took a new name, and move the known paths below a renamed
    one (or forget them below one that left), so a later change to one of
    its messages starts where the message now is.

    Every path moves once, by the folder it was in: one label can take
    the name another gave up in the same pull.

    Args:
        changes (list[tuple[FileChangeKind, str]]): The changes so far.
        known (dict[str, list[str]]): Each seen message's paths.
        prefix (str): The mount's prefix.
        before (dict[str, str]): The folders the last pull saw, by id.
        after (dict[str, str]): The folders now, by id.
    """
    moves = {
        f"{prefix}/{name}": (
            None if label_id not in after else f"{prefix}/{after[label_id]}"
        )
        for label_id, name in before.items()
        if after.get(label_id) != name
    }
    changes.extend((FileChangeKind.DELETE, old) for old in moves)
    changes.extend(
        (FileChangeKind.CREATE, f"{prefix}/{name}")
        for label_id, name in after.items()
        if before.get(label_id) != name
    )
    for mid, paths in known.items():
        known[mid] = _moved(paths, moves)


def _moved(paths: list[str], moves: dict[str, str | None]) -> list[str]:
    """``paths`` with each one in a moved folder put in its new one, or
    dropped when its folder left.

    Args:
        paths (list[str]): A message's paths, each ``folder/day/name``.
        moves (dict[str, str | None]): Each moved folder's new place, None
            for one that left.
    """
    moved: list[str] = []
    for path in paths:
        folder, day, name = path.rsplit("/", 2)
        if folder not in moves:
            moved.append(path)
        elif (new := moves[folder]) is not None:
            moved.append(f"{new}/{day}/{name}")
    return moved


def _changed(
    changes: list[tuple[FileChangeKind, str]],
    before: list[str],
    after: list[str],
) -> None:
    """Record how one message's paths moved: a path it left, one it
    reached, and each message file it kept, whose labels changed.

    Args:
        changes (list[tuple[FileChangeKind, str]]): The changes so far.
        before (list[str]): The paths it was.
        after (list[str]): The paths it is now.
    """
    kept = set(before) & set(after)
    changes.extend((FileChangeKind.DELETE, v) for v in before if v not in kept)
    changes.extend((FileChangeKind.CREATE, v) for v in after if v not in kept)
    changes.extend(
        (FileChangeKind.UPDATE, v)
        for v in after
        if v in kept and v.endswith(MSG_SUFFIX)
    )


class GmailDeltaHook:
    """Checkpointed delta over Gmail's history.

    The checkpoint holds the history id the next pull starts after, each
    label's folder name and, by message id, the paths of each message a
    pull has seen. History records no label created, renamed or deleted,
    so each pull lists the labels and compares the folders: one that
    appeared, left or moved is reported whatever its messages did. A record
    names a message by id only, so each one added or relabeled is read to
    name its paths: one under each label it holds, in the day it arrived.
    Its labels before the record follow from the label changes the
    records carry, so a relabel moves exactly the paths it should, and a
    file it keeps is updated, since its labels are part of its content.
    A message deleted for good cannot be read any more: one a pull has
    seen leaves the paths it was, and one it has not reports the watch
    root as unknown, as a history id Gmail no longer keeps does.
    """

    def __init__(self, accessor: GmailAccessor) -> None:
        """Args:
        accessor (GmailAccessor): Backend handle.
        """
        self._accessor = accessor

    async def pull(self, root: PathSpec, checkpoint: str | None) -> Delta:
        """Return the changes under ``root`` since ``checkpoint``.

        Args:
            root (PathSpec): Watch root.
            checkpoint (str | None): The previous pull's state, or None for
                a baseline.
        """
        tm = self._accessor.token_manager
        state = _decode(checkpoint)
        if state is None:
            return Delta((), await _baseline(tm))
        start, folders, known = state
        observed = datetime.now(timezone.utc)
        try:
            records, latest = await list_history(tm, start)
        except aiohttp.ClientResponseError as exc:
            if exc.status != HTTPStatus.NOT_FOUND:
                raise
            logger.debug("gmail history %s is gone: %s", start, exc)
            lost = FileEvent(
                kind=FileChangeKind.UNKNOWN, path=root, timestamp=observed
            )
            return Delta((lost,), await _baseline(tm))
        prefix = mount_prefix_of(root.virtual, root.vfs_path).rstrip("/")
        listed = await list_labels(tm)
        labels = {lb["id"]: lb for lb in listed}
        now_folders = label_folders(listed)
        changes: list[tuple[FileChangeKind, str]] = []
        _folders_moved(changes, known, prefix, folders, now_folders)
        added: set[str] = set()
        first: dict[str, dict[str, bool]] = {}
        gone: list[str] = []
        for record in records:
            for item in record.get("messagesAdded", []):
                added.add(item["message"]["id"])
                first.setdefault(item["message"]["id"], {})
            for key, removes in (
                ("labelsAdded", False),
                ("labelsRemoved", True),
            ):
                for item in record.get(key, []):
                    seen = first.setdefault(item["message"]["id"], {})
                    for label_id in item.get("labelIds", []):
                        seen.setdefault(label_id, removes)
            for item in record.get("messagesDeleted", []):
                gone.append(item["message"]["id"])
        for mid, seen in first.items():
            if mid in gone:
                continue
            try:
                raw = await get_message_raw(tm, mid)
            except aiohttp.ClientResponseError as exc:
                if exc.status != HTTPStatus.NOT_FOUND:
                    raise
                gone.append(mid)
                continue
            now = list(raw.get("labelIds", []))
            after = message_paths(prefix, raw, labels, now)
            before = known.get(mid)
            if before is None:
                held = [lb for lb in now if lb not in seen] + [
                    lb for lb, removes in seen.items() if removes
                ]
                before = (
                    []
                    if mid in added
                    else message_paths(prefix, raw, labels, held)
                )
            _changed(changes, before, after)
            known[mid] = after
        unknown = False
        for mid in dict.fromkeys(gone):
            was = known.pop(mid, None)
            if was is not None:
                _changed(changes, was, [])
            elif mid not in added:
                unknown = True
        top = root.virtual.rstrip("/")
        events = [
            FileEvent(kind=kind, path=spec_for(root, v), timestamp=observed)
            for kind, v in changes
            if v == top or v.startswith(top + "/")
        ]
        if unknown:
            events.append(
                FileEvent(
                    kind=FileChangeKind.UNKNOWN, path=root, timestamp=observed
                )
            )
        return Delta(tuple(events), _encode(latest, now_folders, known))


async def _baseline(tm: TokenManager) -> str:
    """A checkpoint at the mailbox's present: its history id and its
    label folders, with no message seen yet.

    Args:
        tm (TokenManager): The mailbox's token manager.
    """
    history = await current_history_id(tm)
    return _encode(history, label_folders(await list_labels(tm)), {})


def _encode(
    history_id: str, folders: dict[str, str], known: dict[str, list[str]]
) -> str:
    return json.dumps(
        {
            "gmail": {
                "history": history_id,
                "labels": folders,
                "messages": known,
            }
        },
        sort_keys=True,
    )


def _decode(
    checkpoint: str | None,
) -> tuple[str, dict[str, str], dict[str, list[str]]] | None:
    """The history id, the label folders and the known paths a checkpoint
    holds, None for a baseline.

    Args:
        checkpoint (str | None): What the previous pull handed out.
    """
    if checkpoint is None:
        return None
    data = json.loads(checkpoint)
    state = data.get("gmail") if isinstance(data, dict) else None
    if not isinstance(state, dict) or not isinstance(
        state.get("history"), str
    ):
        return None
    messages = state.get("messages") or {}
    folders = state.get("labels") or {}
    return (
        state["history"],
        {str(k): str(v) for k, v in folders.items()},
        {mid: [str(p) for p in paths] for mid, paths in messages.items()},
    )


def build_delta_hook(accessor: GmailAccessor) -> DeltaHook:
    """Build the Gmail delta hook (``GmailDeltaHook``).

    Args:
        accessor (GmailAccessor): Backend handle.
    """
    return GmailDeltaHook(accessor)
