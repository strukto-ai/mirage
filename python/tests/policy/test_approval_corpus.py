import dataclasses
import json
from pathlib import Path
from typing import Any

import pytest

from mirage.policy.decisions import Decisions
from mirage.policy.match import Outcome
from mirage.policy.types import (
    Abandoned,
    Ask,
    Claimant,
    CommandContext,
    CommandRule,
    Decision,
    Deny,
    HandOff,
    Occurrence,
    Pending,
    Scope,
)
from mirage.workspace.mount.namespace.ram import RAMNamespaceStore
from mirage.workspace.record.types import RecordFields
from mirage.workspace.session.manager import SessionManager

CORPUS = Path(__file__).resolve().parents[3] / "integ/policy/approvals.json"


class Sessions:
    def __init__(self) -> None:
        self.records: dict[str, tuple[Decision, ...]] = {}
        self.flushes = 0

    def decision_sessions(self) -> tuple[str, ...]:
        return tuple(self.records)

    def decisions_of(self, session_id: str) -> tuple[Decision, ...]:
        return self.records.get(session_id, ())

    def set_decisions(
        self, session_id: str, records: tuple[Decision, ...]
    ) -> None:
        self.records[session_id] = records

    async def flush(self) -> None:
        self.flushes += 1


def _record(record: Decision) -> dict[str, Any]:
    return {
        "id": record.id,
        "session_id": record.session_id,
        "command": record.command,
        "argv": list(record.argv),
        "cwd": record.cwd,
        "paths": list(record.paths),
        "reason": record.reason,
        "rule": {
            "reason": record.rule.reason,
            "commands": list(record.rule.commands),
            "paths": list(record.rule.paths),
            "mount": record.rule.mount,
        },
        "outcome": None if record.outcome is None else record.outcome.value,
        "scope": record.scope.value,
        "note": record.note,
    }


async def observations(case: dict[str, Any]) -> list[dict[str, Any]]:
    sessions = Sessions()
    prompts = 0
    scripted = iter(case.get("answers", ()))

    async def answer(record: Decision) -> Decision | None:
        nonlocal prompts
        prompts += 1
        value = next(scripted, None)
        if value is None:
            return None
        return dataclasses.replace(
            record,
            outcome=Outcome(value["outcome"]),
            scope=Scope(value.get("scope", "once")),
        )

    ledger = Decisions(sessions, answer if "answers" in case else None)
    rules = tuple(
        CommandRule(reason=reason, commands=("git push",))
        for reason in case.get("rules", ["first"])
    )
    occurrences: dict[str, Occurrence] = {}
    for name, value in case.get("occurrences", {}).items():
        occurrences[name] = Occurrence(
            occurrences.get(value.get("parent")),
            value.get("source", "line"),
            value["start"],
            value["end"],
        )
    holders: dict[str, HandOff] = {}
    result: list[dict[str, Any]] = []
    for step in case["steps"]:
        action: Deny | Pending | Abandoned | None = None
        op = step["op"]
        if op == "holder":
            holders[step["holder"]] = HandOff(
                parent=holders.get(step.get("parent")),
                origin=occurrences.get(step.get("origin")),
            )
        elif op in {"resolve", "held"}:
            selected = tuple(rules[index] for index in step.get("rules", [0]))
            ask = Ask(selected[0].reason, rules=selected)
            argv = tuple(step.get("argv", ["push"]))
            ctx = CommandContext(
                command="git",
                argv=argv,
                paths=(),
                cwd=step.get("cwd", "/repo"),
                session_id="s",
            )
            reader = step.get("reader")
            claimant = (
                Claimant(holders[reader["holder"]], occurrences[reader["at"]])
                if reader is not None
                else None
            )
            action = (
                await ledger.resolve(ctx, ask, claimant=claimant)
                if op == "resolve"
                else ledger.held(ctx, ask, claimant)
            )
        elif op == "answer":
            records = ledger.list("s")
            await ledger.answer(
                records[step.get("record", 0)].id,
                Outcome(step["outcome"]),
                Scope(step.get("scope", "once")),
            )
        elif op == "split":
            holders[step["target"]] = ledger.split(
                "s", holders[step["holder"]], occurrences[step["at"]]
            )
        elif op == "hand_up":
            ledger.hand_up("s", holders[step["holder"]])
        elif op == "release":
            ledger.release("s", holders[step["holder"]])
        elif op == "revoke":
            await ledger.revoke("s", holders[step["holder"]])
        else:
            raise AssertionError(f"unknown approval corpus operation {op}")
        outcome: dict[str, str] = {"kind": "ok"}
        if op in {"resolve", "held"}:
            if isinstance(action, Pending):
                outcome = {
                    "kind": "pending",
                    "id": action.id,
                    "reason": action.reason,
                }
            elif isinstance(action, Deny):
                outcome = {"kind": "deny", "reason": action.reason}
            elif isinstance(action, Abandoned):
                outcome = {"kind": "abandoned"}
            else:
                outcome = {"kind": "allow"}
        result.append(
            {
                "result": outcome,
                "records": [_record(record) for record in ledger.list("s")],
                "flushes": sessions.flushes,
                "prompts": prompts,
            }
        )
    return result


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    json.loads(CORPUS.read_text())["cases"],
    ids=lambda case: case["name"],
)
async def test_approval_contract(case: dict[str, Any]) -> None:
    assert await observations(case) == case["expected"]


class CountingStore(RAMNamespaceStore):
    def __init__(self) -> None:
        super().__init__()
        self.reads = 0
        self.writes = 0

    async def load(self) -> dict[str, RecordFields]:
        self.reads += 1
        return await super().load()

    async def set(self, key: str, fields: RecordFields) -> None:
        self.writes += 1
        await super().set(key, fields)

    async def cas_set(
        self, key: str, fields: RecordFields, expected_generation: int
    ) -> bool:
        self.writes += 1
        return await super().cas_set(key, fields, expected_generation)


@pytest.mark.asyncio
async def test_main_saved_grant_hydrates_and_checks_without_store_io() -> None:
    saved = json.loads(CORPUS.read_text())["stored_session"]
    store = CountingStore()
    await store.set("s", saved)
    sessions = SessionManager("s", store)
    await sessions.ensure_loaded()
    assert (store.reads, store.writes) == (1, 1)
    baseline = (store.reads, store.writes)
    ledger = Decisions(sessions)
    ctx = CommandContext(
        command="git", argv=("push",), paths=(), cwd="/repo", session_id="s"
    )
    ask = Ask(
        "first", rule=CommandRule(reason="first", commands=("git push",))
    )
    for _ in range(3):
        assert await ledger.resolve(ctx, ask) is None
        assert ledger.held(ctx, ask) is None
    await sessions.flush()
    assert (store.reads, store.writes) == baseline
    assert sessions.get("s").to_dict()["decisions"] == saved["decisions"]
