from collections.abc import Sequence
from typing import Any, TypeVar

from mirage.policy.types import (
    Claim,
    Decision,
    HandOff,
    Occurrence,
    Outcome,
    Scope,
)
from mirage.rs.document import units
from mirage.rs.policy import admission_matcher

T = TypeVar("T")


def _key(value: T, values: list[T], keys: dict[int, int]) -> int:
    found = keys.get(id(value))
    if found is not None:
        return found
    found = len(values)
    keys[id(value)] = found
    values.append(value)
    return found


def same_line(
    record: Decision, command: str | None, argv: tuple[str, ...], cwd: str
) -> bool:
    return (
        command is not None
        and record.command == command
        and record.argv == argv
        and record.cwd == cwd
    )


def record_wire(
    record: Decision,
    key: int,
    rule_key: int | None,
    argv: tuple[str, ...],
    cwd: str,
) -> dict[str, Any]:
    """Encode value-equality facts with the original record identity.

    Args:
        record (Decision): the original host record.
        key (int): its identity in this invocation.
        rule_key (int | None): the equal requested rule, if any.
        argv (tuple[str, ...]): the requested command and arguments.
        cwd (str): the requested working directory.
    """
    return {
        "keys": [key],
        "rule": rule_key,
        "same_line": same_line(
            record, argv[0] if argv else None, argv[1:], cwd
        ),
        "outcome": None if record.outcome is None else record.outcome.value,
        "scope": record.scope.value,
    }


def approval_query(kind: str, **args: Any) -> Any:
    """Ask the shared approval reducer without retaining host state.

    Args:
        kind (str): the approval query variant.
        **args (Any): its typed wire fields.
    """
    return admission_matcher(None).ask(
        "approvals", query={"kind": kind, **args}
    )


class ApprovalSnapshot:
    """Original host objects and their keys for one synchronous query.

    Args:
        records (Sequence[Decision]): current records, in session order.
        live (Sequence[HandOff]): the session's live hand-offs.
        handed (HandOff | None): an additional hand-off and its parents.
    """

    def __init__(
        self,
        records: Sequence[Decision] = (),
        live: Sequence[HandOff] = (),
        handed: HandOff | None = None,
    ) -> None:
        self.records = records
        self.record_objects = list(records)
        self.holder_objects: list[HandOff] = []
        self.claim_objects: list[Claim] = []
        self.occurrence_objects: list[Occurrence] = []
        self._record_keys = {
            id(record): key for key, record in enumerate(records)
        }
        self._holder_keys: dict[int, int] = {}
        self._claim_keys: dict[int, int] = {}
        self._occurrence_keys: dict[int, int] = {}
        self._source_keys: dict[str, int] = {}
        self.wire: dict[str, Any] = {
            "records": [],
            "holders": [],
            "claims": [],
            "live": [self.holder_key(holder) for holder in live],
            "occurrences": [],
            "sources": [],
        }
        if handed is not None:
            self.holder_key(handed)
        index = 0
        while index < len(self.holder_objects):
            holder = self.holder_objects[index]
            parent = (
                None
                if holder.parent is None
                else self.holder_key(holder.parent)
            )
            claims = []
            for claim in holder.claimed:
                claim_key = _key(claim, self.claim_objects, self._claim_keys)
                if claim_key == len(self.wire["claims"]):
                    self.wire["claims"].append(
                        {
                            "key": claim_key,
                            "record": self.record_key(claim.decision),
                            "occurrence": self.occurrence_key(
                                claim.occurrence
                            ),
                        }
                    )
                claims.append(claim_key)
            self.wire["holders"].append(
                {"key": index, "parent": parent, "claims": claims}
            )
            index += 1

    def records_wire(
        self, rules: Sequence[int], argv: tuple[str, ...], cwd: str
    ) -> list[dict[str, Any]]:
        batches: list[dict[str, Any]] = []
        previous: tuple[int, bool, Outcome | None, Scope] | None = None
        command, args = (argv[0] if argv else None), argv[1:]
        for record, rule in zip(self.records, rules, strict=True):
            fields = (
                rule,
                same_line(record, command, args, cwd),
                record.outcome,
                record.scope,
            )
            key = self._record_keys.get(id(record))
            if key is None:
                key = self.record_key(record)
            if fields == previous:
                batches[-1]["keys"].append(key)
            else:
                batches.append(
                    {
                        "keys": [key],
                        "rule": rule,
                        "same_line": fields[1],
                        "outcome": None
                        if record.outcome is None
                        else record.outcome.value,
                        "scope": record.scope.value,
                    }
                )
                previous = fields
        return batches

    def record_key(self, record: Decision) -> int:
        return _key(record, self.record_objects, self._record_keys)

    def holder_key(self, holder: HandOff) -> int:
        return _key(holder, self.holder_objects, self._holder_keys)

    def occurrence_key(self, occurrence: Occurrence) -> int:
        first = _key(
            occurrence, self.occurrence_objects, self._occurrence_keys
        )
        index = len(self.wire["occurrences"])
        while index < len(self.occurrence_objects):
            current = self.occurrence_objects[index]
            parent = (
                None
                if current.parent is None
                else _key(
                    current.parent,
                    self.occurrence_objects,
                    self._occurrence_keys,
                )
            )
            self.wire["occurrences"].append(
                {
                    "key": index,
                    "parent": parent,
                    "source": self._source_key(current.source),
                    "start": current.start,
                    "end": current.end,
                }
            )
            index += 1
        return first

    def _source_key(self, source: str) -> int:
        found = self._source_keys.get(source)
        if found is None:
            found = len(self.wire["sources"])
            self._source_keys[source] = found
            self.wire["sources"].append(units(source))
        return found

    def query(self, kind: str, **args: Any) -> Any:
        return approval_query(kind, state=self.wire, **args)
