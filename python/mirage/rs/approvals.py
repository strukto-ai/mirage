from collections.abc import Sequence
from typing import Any, TypeVar

from mirage.policy.types import Claim, Decision, HandOff, Occurrence
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
        "key": key,
        "rule": rule_key,
        "same_line": bool(argv)
        and record.command == argv[0]
        and record.argv == argv[1:]
        and record.cwd == cwd,
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
        self.record_objects: list[Decision] = []
        self.holder_objects: list[HandOff] = []
        self.claim_objects: list[Claim] = []
        self.occurrence_objects: list[Occurrence] = []
        self._record_keys: dict[int, int] = {}
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
        for record in records:
            self.record_key(record)
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
