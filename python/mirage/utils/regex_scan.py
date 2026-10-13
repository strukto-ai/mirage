import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Match:
    re: re.Pattern[str]
    string: str
    spans: tuple[tuple[int, int], ...]

    def _index(self, group: int | str) -> int:
        if isinstance(group, str):
            try:
                return self.re.groupindex[group]
            except KeyError as exc:
                raise IndexError(group) from exc
        return group

    def start(self, group: int | str = 0) -> int:
        return self.spans[self._index(group)][0]

    def end(self, group: int | str = 0) -> int:
        return self.spans[self._index(group)][1]

    def group(self, group: int | str = 0) -> Any:
        start, end = self.spans[self._index(group)]
        return None if start < 0 else self.string[start:end]


def scan(
    pattern: re.Pattern[str],
    text: str,
    all_matches: bool = True,
    restart: bool = False,
) -> list[tuple[tuple[int, int], ...]]:
    """Each match's group spans: in place for a subject within the
    pattern's ``loop_limit``, in a worker for any other.

    Args:
        pattern (re.Pattern[str]): the compiled host pattern.
        text (str): one search subject.
        all_matches (bool): retain every match only when rendering needs them.
        restart (bool): restart after empty matches as ripgrep does.
    """
    if restart:
        matches = []
        pos = 0
        while pos <= len(text):
            match = pattern.search(text, pos)
            if match is None:
                break
            matches.append(match)
            if not all_matches:
                break
            pos = (
                match.end() if match.end() > match.start() else match.end() + 1
            )
    else:
        matches = list(pattern.finditer(text)) if all_matches else []
        if not all_matches and (match := pattern.search(text)) is not None:
            matches.append(match)
    return [
        tuple(m.span(i) for i in range(pattern.groups + 1)) for m in matches
    ]
