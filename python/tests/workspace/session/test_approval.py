import asyncio
import copy
import json
import sys
from pathlib import Path

import pytest

from mirage.policy.errors import ApprovalUnavailable
from mirage.policy.types import AdmissionRules
from mirage.workspace.mount.namespace.ram import RAMNamespaceStore
from mirage.workspace.mount.namespace.store import RecordNamespaceStore
from mirage.workspace.record.disk import DiskRecordClient
from mirage.workspace.session.approval import (
    approval_session,
    empty_approvals,
    plan_reset,
    transact_approvals,
)
from mirage.workspace.session.manager import SessionManager
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import seed_var


def question(ticket: str = "request"):
    rule = {
        "reason": [ord(c) for c in "review"],
        "commands": [],
        "paths": [],
        "mount": [],
    }
    return {
        "op": "resolve",
        "question": {
            "id": ticket,
            "session_id": "s",
            "command": [103, 105, 116],
            "argv": [],
            "cwd": [47],
            "paths": [],
            "reason": rule["reason"],
            "rule": rule,
        },
        "rules": [rule],
        "claimant": None,
    }


class UncertainStore(RAMNamespaceStore):
    def __init__(self, *, commit: bool):
        super().__init__()
        self.commit = commit
        self.attempts = 0

    async def cas_set(self, key, fields, expected_generation):
        self.attempts += 1
        if self.attempts == 1 or not self.commit:
            if self.commit:
                await super().cas_set(key, fields, expected_generation)
            raise OSError("write reply lost")
        return await super().cas_set(key, fields, expected_generation)


def test_policy_projection_preserves_an_inherited_shown_path_mode():
    restored = approval_session(
        {"session_id": "s", "shown_paths": {"entries": [{"path": "/data"}]}}
    )
    assert restored.visibility.shown.entries[0].mode is None
    assert restored.to_dict()["shown_paths"] == {
        "entries": [{"path": "/data"}]
    }


@pytest.mark.asyncio
async def test_lost_first_reply_requires_a_confirmed_republication():
    store = UncertainStore(commit=True)
    reply = await transact_approvals(
        store, SessionState(session_id="s").to_dict(), question(), None
    )
    assert reply.result["kind"] == "pending"
    assert store.attempts == 2
    fields = await store.get("s")
    assert fields["generation"] == 2
    assert fields["approval_state"]["revision"] == 1
    assert len(fields["approval_state"]["records"]) == 1
    assert len(fields["approval_state"]["receipts"]) == 1


@pytest.mark.asyncio
async def test_unknown_writes_never_publish_authority():
    store = UncertainStore(commit=False)
    with pytest.raises(ApprovalUnavailable, match="storage_unconfirmed"):
        await transact_approvals(
            store, SessionState(session_id="s").to_dict(), question(), None
        )
    assert await store.get("s") is None


class RacingStore(RAMNamespaceStore):
    async def cas_set(self, key, fields, expected_generation):
        await asyncio.sleep(0)
        return await super().cas_set(key, fields, expected_generation)


@pytest.mark.asyncio
async def test_competing_callers_cannot_consume_one_answer_twice():
    store = RacingStore()
    pending = await transact_approvals(
        store, SessionState(session_id="s").to_dict(), question(), None
    )
    epoch = pending.fields["incarnation"]
    answered = await transact_approvals(
        store,
        pending.fields,
        {
            "op": "answer",
            "id": "request",
            "outcome": "allow",
            "scope": "once",
            "note": [],
            "claimant": None,
        },
        epoch,
    )
    replies = await asyncio.gather(
        *[
            transact_approvals(store, answered.fields, question(ticket), epoch)
            for ticket in ["caller-a", "caller-b"]
        ]
    )
    assert sorted(reply.result["kind"] for reply in replies) == [
        "allow",
        "pending",
    ]
    fields = await store.get("s")
    assert "request" in fields["approval_state"]["retired"]
    assert len(fields["approval_state"]["records"]) == 1


@pytest.mark.asyncio
async def test_stale_policy_facts_refuse_without_publishing():
    store = RAMNamespaceStore()
    pending = await transact_approvals(
        store, SessionState(session_id="s").to_dict(), question(), None
    )
    changed = copy.deepcopy(pending.fields)
    changed["commands"] = {"allow": [], "ask": [], "deny": []}
    changed["generation"] += 1
    await store.set("s", changed)
    with pytest.raises(ApprovalUnavailable, match="stale_facts"):
        await transact_approvals(
            store,
            pending.fields,
            question("later"),
            pending.fields["incarnation"],
        )
    assert await store.get("s") == changed


@pytest.mark.asyncio
async def test_stale_flush_keeps_new_restrictions_and_approval_state():
    store = RAMNamespaceStore()
    manager = SessionManager("s", store)
    await manager.ensure_loaded()
    await manager.flush()
    epoch = manager.incarnation_of("s")
    await manager.approval_event("s", question(), epoch)
    old = SessionManager("s", store)
    await old.ensure_loaded()
    current = await store.get("s")
    newer = copy.deepcopy(current)
    newer["commands"] = {"allow": [], "ask": [], "deny": []}
    newer["generation"] += 1
    await store.set("s", newer)
    seed_var(old.get("s"), "LOCAL", "kept")
    await old.flush()
    stored = await store.get("s")
    assert stored["commands"] == newer["commands"]
    assert (
        stored["approval_state"]["records"]
        == newer["approval_state"]["records"]
    )
    assert stored["env"]["LOCAL"] == "kept"
    assert old.get("s").commands.allow == ()


@pytest.mark.asyncio
async def test_old_session_identity_cannot_rejoin_a_replacement():
    store = RAMNamespaceStore()
    first = await transact_approvals(
        store, SessionState(session_id="s").to_dict(), question(), None
    )
    replacement = copy.deepcopy(first.fields)
    replacement["incarnation"] = "replacement"
    replacement["approval_state"]["incarnation"] = "replacement"
    replacement["generation"] += 1
    await store.set("s", replacement)
    with pytest.raises(ApprovalUnavailable, match="session_replaced"):
        await transact_approvals(
            store, first.fields, question("old"), first.fields["incarnation"]
        )
    assert await store.get("s") == replacement


@pytest.mark.asyncio
async def test_unqualified_store_cannot_create_approval_authority():
    class UnqualifiedStore(RAMNamespaceStore):
        async def approval_guarantee(self):
            raise RuntimeError("unsupported durability")

    store = UnqualifiedStore()
    with pytest.raises(ApprovalUnavailable, match="storage_unqualified"):
        await transact_approvals(
            store, SessionState(session_id="s").to_dict(), question(), None
        )
    assert await store.get("s") is None


@pytest.mark.asyncio
async def test_gate_refresh_publishes_policy_without_publishing_unconfirmed_scratch():
    store = RAMNamespaceStore()
    manager = SessionManager("s", store)
    epoch = await manager.activate("s")
    session = manager.get("s")
    seed_var(session, "UNCONFIRMED", "pending")
    session.commands = AdmissionRules(allow=())
    await manager.refresh_approval("s", epoch)
    stored = await store.get("s")
    assert stored["commands"]["allow"] == []
    assert "UNCONFIRMED" not in stored["env"]
    assert session.env["UNCONFIRMED"] == "pending"


@pytest.mark.asyncio
async def test_a_clean_stale_session_cannot_activate_after_closure():
    store = RAMNamespaceStore()
    manager = SessionManager("default", store)
    manager.create("s")
    await manager.activate("s")
    old = SessionManager("default", store)
    await old.ensure_loaded()
    await manager.close("s")
    with pytest.raises(ApprovalUnavailable, match="session_closed"):
        await old.activate("s")


@pytest.mark.asyncio
async def test_close_fences_old_writers_and_explicit_recreation_gets_a_new_identity():
    store = RAMNamespaceStore()
    manager = SessionManager("default", store)
    manager.create("s")
    await manager.flush()
    old = SessionManager("default", store)
    await old.ensure_loaded()
    epoch = old.incarnation_of("s")
    await manager.close("s")
    seed_var(old.get("s"), "OLD", "stale")
    with pytest.raises(ApprovalUnavailable, match="session_closed"):
        await old.flush("s")
    fresh = SessionManager("default", store)
    await fresh.ensure_loaded()
    assert not fresh.has("s")
    fresh.create("s")
    await fresh.flush("s")
    assert fresh.incarnation_of("s") != epoch
    with pytest.raises(ApprovalUnavailable, match="session_replaced"):
        await old.flush("s")
    assert "OLD" not in (await store.get("s"))["env"]


@pytest.mark.asyncio
async def test_snapshot_restore_invalidates_answers_and_fences_old_holders():
    store = RAMNamespaceStore()
    manager = SessionManager("s", store)
    await manager.ensure_loaded()
    await manager.flush()
    epoch = manager.incarnation_of("s")
    await manager.approval_event("s", question(), epoch)
    await manager.approval_event(
        "s",
        {
            "op": "answer",
            "id": "request",
            "outcome": "allow",
            "scope": "session",
            "note": [],
            "claimant": None,
        },
        epoch,
    )
    old = SessionManager("s", store)
    await old.ensure_loaded()
    snapshot = SessionState.from_dict(manager.get("s").to_dict())
    await manager.replace_from_snapshot([snapshot])
    assert manager.incarnation_of("s") != epoch
    assert (await store.get("s"))["approval_state"]["records"] == []
    with pytest.raises(ApprovalUnavailable, match="session_replaced"):
        await old.approval_event("s", question("late"), epoch)


class LostClosureStore(RAMNamespaceStore):
    lose_replies = False

    async def cas_set(self, key, fields, expected_generation):
        placed = await super().cas_set(key, fields, expected_generation)
        if self.lose_replies:
            raise OSError("committed but acknowledgement lost")
        return placed


@pytest.mark.asyncio
async def test_unknown_closure_remains_blocked_until_reconfirmed():
    store = LostClosureStore()
    manager = SessionManager("default", store)
    manager.create("s")
    await manager.flush()
    store.lose_replies = True
    with pytest.raises(ApprovalUnavailable, match="storage_unconfirmed"):
        await manager.close("s")
    assert manager.has("s")
    with pytest.raises(
        ApprovalUnavailable, match="session_transition_pending"
    ):
        await manager.approval_event(
            "s", question(), manager.incarnation_of("s")
        )
    marker = await store.get("s")
    store.lose_replies = False
    await manager.close("s")
    assert not manager.has("s")
    confirmed = await store.get("s")
    assert confirmed["incarnation"] == marker["incarnation"]
    assert confirmed["generation"] > marker["generation"]


@pytest.mark.asyncio
async def test_unknown_default_retirement_keeps_the_old_key_until_reconfirmed():
    store = LostClosureStore()
    manager = SessionManager("s", store)
    epoch = await manager.activate("s")
    store.lose_replies = True
    with pytest.raises(ApprovalUnavailable, match="storage_unconfirmed"):
        await manager.restore_default("restored")
    assert manager.default_id == "s"
    assert manager.incarnation_of("s") == epoch
    assert not manager.has("restored")
    with pytest.raises(
        ApprovalUnavailable, match="session_transition_pending"
    ):
        await manager.approval_event(
            "s", {"op": "revoke", "owner": "old", "holder": "old"}, epoch
        )
    marker = await store.get("s")
    store.lose_replies = False
    await manager.restore_default("restored")
    assert manager.default_id == "restored"
    assert not manager.has("s")
    confirmed = await store.get("s")
    assert confirmed["incarnation"] == marker["incarnation"]
    assert confirmed["generation"] > marker["generation"]


APPROVAL_CHILD = """
import asyncio
import json
import os
from pathlib import Path
import sys
from mirage.workspace.mount.namespace.store import RecordNamespaceStore
from mirage.workspace.record.disk import DiskRecordClient
from mirage.workspace.session.approval import transact_approvals

async def main():
    root, worker, crash = sys.argv[1:]
    packet = json.loads(Path(root, "packet.json").read_text())
    store = RecordNamespaceStore(DiskRecordClient(root, "sessions/"))
    baseline = await store.get("s")
    event = packet["event"]
    event["question"]["id"] = worker
    Path(root, worker).touch()
    async with asyncio.timeout(10):
        while not Path(root, "start").exists():
            await asyncio.sleep(0.005)
    if crash == "yes":
        publish = store.cas_set
        async def lost_reply(*args):
            await publish(*args)
            os._exit(23)
        store.cas_set = lost_reply
    reply = await transact_approvals(store, baseline, event, baseline["incarnation"])
    print(reply.result["kind"])

asyncio.run(main())
"""


async def prepared_disk_answer(root: Path):
    store = RecordNamespaceStore(DiskRecordClient(str(root), "sessions/"))
    pending = await transact_approvals(
        store, SessionState(session_id="s").to_dict(), question(), None
    )
    answered = await transact_approvals(
        store,
        pending.fields,
        {
            "op": "answer",
            "id": "request",
            "outcome": "allow",
            "scope": "once",
            "note": [],
            "claimant": None,
        },
        pending.fields["incarnation"],
    )
    (root / "packet.json").write_text(json.dumps({"event": question()}))
    return store, answered.fields


@pytest.mark.asyncio
async def test_two_real_processes_cannot_consume_one_disk_answer(
    tmp_path: Path,
):
    store, _ = await prepared_disk_answer(tmp_path)
    processes = [
        await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            APPROVAL_CHILD,
            str(tmp_path),
            worker,
            "no",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        for worker in ("process-a", "process-b")
    ]
    try:
        async with asyncio.timeout(10):
            while not all(
                (tmp_path / worker).exists()
                for worker in ("process-a", "process-b")
            ):
                await asyncio.sleep(0.005)
        (tmp_path / "start").touch()
        outputs = await asyncio.wait_for(
            asyncio.gather(*(p.communicate() for p in processes)), 15
        )
        for process, (_, errors) in zip(processes, outputs, strict=True):
            assert process.returncode == 0, errors.decode()
        assert sorted(out.decode().strip() for out, _ in outputs) == [
            "allow",
            "pending",
        ]
        assert "request" in (await store.get("s"))["approval_state"]["retired"]
    finally:
        for process in processes:
            if process.returncode is None:
                process.kill()
                await process.wait()


@pytest.mark.asyncio
async def test_process_death_after_consumption_cannot_reopen_the_answer(
    tmp_path: Path,
):
    store, baseline = await prepared_disk_answer(tmp_path)
    (tmp_path / "start").touch()
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        APPROVAL_CHILD,
        str(tmp_path),
        "crashed",
        "yes",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, errors = await asyncio.wait_for(child.communicate(), 15)
    assert child.returncode == 23, errors.decode()
    resumed = await transact_approvals(
        store, baseline, question("retry"), baseline["incarnation"]
    )
    assert resumed.result["kind"] == "pending"
    assert "request" in resumed.fields["approval_state"]["retired"]


@pytest.mark.asyncio
async def test_reset_of_a_missing_destination_discards_source_storage_metadata():
    store = RAMNamespaceStore()
    source = SessionState(session_id="s", incarnation="source", generation=9)
    source.approval_state = empty_approvals("source")
    plan = plan_reset(source.to_dict(), None, close=False)
    assert plan.fields["generation"] == 0
    assert "incarnation" not in plan.fields
    assert "approval_state" not in plan.fields
    reply = await transact_approvals(
        store,
        plan.fields,
        plan.event,
        plan.expected_epoch,
        plan.expected_closed,
        plan.transition,
    )
    assert reply.fields["generation"] == 1
    assert reply.fields["incarnation"] != "source"
    assert reply.fields["approval_state"]["records"] == []


@pytest.mark.asyncio
async def test_a_new_destination_identity_blocks_an_earlier_reset_plan():
    store = RAMNamespaceStore()
    plan = plan_reset(
        SessionState(session_id="s", generation=9).to_dict(), None, close=False
    )
    other = SessionManager("s", store)
    await other.activate("s")
    before = await store.get("s")
    with pytest.raises(ApprovalUnavailable, match="session_replaced"):
        await transact_approvals(
            store,
            plan.fields,
            plan.event,
            plan.expected_epoch,
            plan.expected_closed,
            plan.transition,
        )
    assert await store.get("s") == before


@pytest.mark.asyncio
async def test_restoring_a_different_default_fences_the_old_key_and_late_cleanup():
    store = RAMNamespaceStore()
    manager = SessionManager("s", store)
    epoch = await manager.activate("s")
    await manager.approval_event("s", question(), epoch)
    stale = SessionManager("s", store)
    await stale.ensure_loaded()
    await manager.restore_default("restored")
    await manager.replace_from_snapshot([manager.get("restored")])
    marker = await store.get("s")
    assert marker["closed"]
    assert marker["approval_state"]["records"] == []
    assert manager.incarnation_of("restored") != epoch
    seed_var(stale.get("s"), "STALE", "refused")
    with pytest.raises(ApprovalUnavailable, match="session_closed"):
        await stale.flush("s")
    with pytest.raises(ApprovalUnavailable, match="session_closed"):
        await stale.approval_event("s", question("late"), epoch)
    with pytest.raises(ApprovalUnavailable, match="session_closed"):
        await manager.refresh_approval("s", epoch)
    assert await manager.approval_event(
        "s",
        {
            "op": "revoke",
            "owner": "old-owner",
            "holder": "old-holder",
        },
        epoch,
    ) == {"kind": "applied"}
    assert manager.approval_state_of("s")["closed"] == marker["closed"]
    assert await store.get("s") == marker
