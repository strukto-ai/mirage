import copy
import json
import logging
from typing import NamedTuple

from mirage.policy.errors import ApprovalUnavailable
from mirage.rs.stream import close_stream, open_stream
from mirage.utils.ids import authority_id
from mirage.workspace.mount.namespace.store import NamespaceStore
from mirage.workspace.record.types import (
    CAS_MAX_RETRIES,
    RecordFields,
    generation_of,
)
from mirage.workspace.session.session import SessionState

logger = logging.getLogger(__name__)

AUTHORITY_FIELDS = (
    "commands",
    "scripts",
    "profile",
    "mount_modes",
    "hidden_paths",
    "shown_paths",
    "hide_reasons",
    "hidden_vars",
    "processes",
    "command_limits",
)


class ApprovalReply(NamedTuple):
    fields: RecordFields
    result: RecordFields


class SessionReset(NamedTuple):
    fields: RecordFields
    event: RecordFields
    expected_epoch: str | None
    expected_closed: str | None
    transition: str


def plan_reset(
    fields: RecordFields, current: RecordFields | None, *, close: bool
) -> SessionReset:
    """Capture a replacement payload and its observed storage fence.

    Args:
        fields (RecordFields): the session payload being replaced or closed.
        current (RecordFields | None): the authoritative record just read.
        close (bool): whether the replacement is a terminal marker.
    """
    payload = copy.deepcopy(fields)
    payload["generation"] = generation_of(current)
    payload.pop("incarnation", None)
    payload.pop("approval_state", None)
    return SessionReset(
        payload,
        {
            "op": "reset",
            "incarnation": authority_id(),
            "closed": authority_id() if close else None,
        },
        None if current is None else current.get("incarnation"),
        None if current is None else current.get("closed"),
        authority_id(),
    )


def authority_fields(fields: RecordFields) -> RecordFields:
    """Select the session facts the policy domain compares.

    Args:
        fields (RecordFields): serialized host session facts.
    """
    return {key: fields.get(key) for key in AUTHORITY_FIELDS}


def approval_session(fields: RecordFields) -> SessionState:
    """Decode host session facts accompanying an approval acknowledgement.

    Args:
        fields (RecordFields): the confirmed session record.
    """
    return SessionState.from_dict(copy.deepcopy(fields))


def approval_epoch(state: RecordFields | None) -> str | None:
    """Read the identity of an opaque Rust approval snapshot.

    Args:
        state (RecordFields | None): a stored approval snapshot.
    """
    if state is None:
        return None
    incarnation = state.get("incarnation")
    if not isinstance(incarnation, str) or not incarnation:
        raise ValueError("invalid approval incarnation")
    return incarnation


def empty_approvals(incarnation: str | None = None) -> RecordFields:
    """Create a fresh approval incarnation without importing legacy grants."""
    return {
        "version": 1,
        "incarnation": authority_id() if incarnation is None else incarnation,
        "revision": 0,
        "records": [],
        "claims": [],
        "receipts": [],
        "retired": [],
    }


async def transact_approvals(
    store: NamespaceStore,
    baseline: RecordFields,
    event: RecordFields,
    expected_epoch: str | None,
    expected_closed: str | None = None,
    transition_id: str | None = None,
) -> ApprovalReply:
    """Apply one Rust transition through acknowledged session-record CAS.

    Args:
        store (NamespaceStore): the existing session table.
        baseline (RecordFields): the caller's current session facts.
        event (RecordFields): the typed policy event in its wire shape.
        expected_epoch (str | None): the incarnation this host observed.
        expected_closed (str | None): the exact closure this replacement observed.
        transition_id (str | None): a retained lifecycle retry identity.
    """
    baseline = copy.deepcopy(baseline)
    session_id = baseline["session_id"]
    transition = authority_id() if transition_id is None else transition_id
    initial = empty_approvals(expected_epoch)
    own_epoch = (
        event["incarnation"]
        if event.get("op") == "reset"
        else initial["incarnation"]
    )
    last_error: Exception | None = None
    for _ in range(CAS_MAX_RETRIES):
        current = await store.get(session_id)
        if current is None:
            if (
                generation_of(baseline) > 0
                or baseline.get("approval_state") is not None
            ):
                raise ApprovalUnavailable("session_disappeared")
            current = copy.deepcopy(baseline)
            current["generation"] = 0
            current.pop("approval_state", None)
        own_reset = (
            event.get("op") == "reset"
            and current.get("incarnation") == own_epoch
        )
        if current.get("closed") != expected_closed and not own_reset:
            raise ApprovalUnavailable("session_closed")
        if current.get("incarnation") != expected_epoch and not (
            current.get("incarnation") == own_epoch
        ):
            raise ApprovalUnavailable("session_replaced")
        state = current.get("approval_state")
        if state is None:
            state = initial
        elif approval_epoch(state) != current.get("incarnation"):
            raise ApprovalUnavailable("session_invalid")
        stream = open_stream("policy_decisions", {})
        try:
            stream.feed(
                json.dumps(
                    {
                        "evaluation": transition,
                        "transition": transition,
                        "ledger": state,
                        "event": event,
                        "expected_incarnation": current.get("incarnation"),
                        "facts": {
                            "expected": authority_fields(baseline),
                            "current": authority_fields(current),
                        },
                    }
                ).encode()
            )
            stream.finish()
            taken = stream.request()
            if taken is None:
                result = json.loads(stream.finish())
                if result["kind"] == "blocked":
                    raise ApprovalUnavailable(result["status"])
                return ApprovalReply(current, result)
            effect, data = taken
            if data or effect["op"] != "persist_approvals":
                raise RuntimeError("invalid approval storage effect")
            if effect["approval_required"]:
                try:
                    await store.approval_guarantee()
                except Exception as exc:
                    raise ApprovalUnavailable("storage_unqualified") from exc
            proposed = effect["ledger"]
            if not isinstance(proposed, dict):
                raise RuntimeError("invalid approval storage state")
            fields = {
                **(
                    baseline
                    if event.get("op") in {"session_write", "reset"}
                    else current
                ),
                "approval_state": proposed,
                "incarnation": proposed["incarnation"],
                "generation": generation_of(current) + 1,
            }
            if proposed.get("closed") is None:
                fields.pop("closed", None)
            else:
                fields["closed"] = proposed["closed"]
            authority = effect.get("authority")
            if authority is not None:
                if not isinstance(authority, dict):
                    raise RuntimeError("invalid session authority projection")
                for key, value in authority.items():
                    if value is None:
                        fields.pop(key, None)
                    else:
                        fields[key] = value
            try:
                placed = await store.cas_set(
                    session_id, fields, generation_of(current)
                )
            except Exception as exc:
                logger.debug(
                    "approval write has an uncertain outcome", exc_info=True
                )
                last_error = exc
                continue
            stream.respond(
                {
                    "evaluation": effect["evaluation"],
                    "effect": effect["effect"],
                    "transition": effect["transition"],
                    "status": "committed" if placed else "conflict",
                    "revision": proposed["revision"],
                },
                b"",
            )
            result = json.loads(stream.finish())
            if placed:
                return ApprovalReply(fields, result)
        finally:
            await close_stream(stream)
    raise ApprovalUnavailable("storage_unconfirmed") from last_error
