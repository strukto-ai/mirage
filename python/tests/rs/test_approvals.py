import dataclasses
import json

from mirage.policy.types import (
    Claim,
    CommandRule,
    Decision,
    HandOff,
    Occurrence,
    Outcome,
    Scope,
)
from mirage.rs.approvals import ApprovalSnapshot


def decision() -> Decision:
    return Decision(
        id="shared-id",
        session_id="s",
        command="cat",
        argv=("x",),
        cwd="/",
        paths=(),
        reason="read",
        rule=CommandRule(reason="read", commands=("cat x",)),
        outcome=Outcome.ALLOW,
        scope=Scope.ONCE,
    )


def test_long_script_claims_keep_their_identity_without_repeated_source() -> (
    None
):
    source = "cat x; " * 1024
    handed = HandOff()
    for index in range(32):
        handed.claimed.append(
            Claim(
                Occurrence(None, source, index, index + 1),
                dataclasses.replace(decision(), id=str(index)),
            )
        )
    snapshot = ApprovalSnapshot((), (handed,), handed)
    scope = snapshot.occurrence_key(Occurrence(None, source, 0, len(source)))
    keys = snapshot.query(
        "split", holder=snapshot.holder_key(handed), scope=scope
    )
    assert [snapshot.claim_objects[key] for key in keys] == handed.claimed
    assert all(
        snapshot.claim_objects[key] is claim
        for key, claim in zip(keys, handed.claimed, strict=True)
    )
    assert len(json.dumps(snapshot.wire)) < 8 * len(source) + 500 * len(keys)


def test_equal_records_keep_separate_identity_and_duplicate_positions() -> (
    None
):
    first = decision()
    second = dataclasses.replace(first)
    handed = HandOff(claimed=[Claim(Occurrence(None, "cat x", 0, 5), first)])
    records = (first, second, first)
    snapshot = ApprovalSnapshot(records, (handed,))
    snapshot.wire["records"] = snapshot.records_wire(
        [0, 0, 0], ("cat", "x"), "/"
    )
    plan = snapshot.query("plan", rules=[0, 0], claimant=None)
    assert plan["answers"] == [1, 1]
    assert plan["once"] == [1, 1]
    assert snapshot.record_objects[1] is second
