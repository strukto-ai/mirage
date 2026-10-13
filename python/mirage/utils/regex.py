import re
from bisect import bisect_left
from collections import OrderedDict, deque
from collections.abc import Callable, Iterable, Iterator

from mirage.concurrency.worker import Worker
from mirage.utils.regex_cost import loop_limit
from mirage.utils.regex_scan import Match, scan


class AsyncRegex:
    """Match each subject where its worst case allows, render locally.

    A subject within the pattern's ``loop_limit`` is scanned in place: its
    search cannot run past ``LOOP_BUDGET`` steps. Any other subject is its
    own request to the worker, which only that starts, so a slow subject
    sent ahead never holds back the answer for one before it, and a
    runaway search stays killable (strukto-ai/mirage#1590).
    """

    def __init__(
        self,
        pattern: re.Pattern[str],
        all_matches: bool = True,
        restart: bool = False,
        worker: Worker | None = None,
    ) -> None:
        self.original = pattern
        self._all_matches = all_matches
        self._restart = restart
        self.pattern = pattern.pattern
        self.flags = pattern.flags
        self.groups = pattern.groups
        self.groupindex = pattern.groupindex
        self._limit = loop_limit(pattern)
        self._owns_worker = worker is None
        self._worker = worker if worker is not None else Worker()
        self._cache: OrderedDict[str, tuple[list[Match], list[int]]] = (
            OrderedDict()
        )
        self._sent: deque[str] = deque()

    async def prepare(
        self, text: str, following: Callable[[], Iterable[str]] | None = None
    ) -> None:
        """Fetch the matches of ``text`` for ``search`` and ``finditer``.

        Args:
            text (str): the subject about to be searched.
            following (Callable | None): the subjects already buffered
                behind it; those past the limit are sent along without
                waiting for their answers.
        """
        if text in self._cache:
            self._cache.move_to_end(text)
            return
        if len(text) <= self._limit:
            self._remember(
                text,
                scan(self.original, text, self._all_matches, self._restart),
            )
        else:
            await self._fetch(text, following)
        while len(self._cache) > 32:
            self._cache.popitem(last=False)

    async def _fetch(
        self, text: str, following: Callable[[], Iterable[str]] | None
    ) -> None:
        if text not in self._sent:
            ahead = following() if following is not None else ()
            for subject in (text, *ahead):
                if (
                    len(subject) > self._limit
                    and subject not in self._cache
                    and subject not in self._sent
                ):
                    await self._worker.send(
                        scan,
                        self.original,
                        subject,
                        self._all_matches,
                        self._restart,
                    )
                    self._sent.append(subject)
        try:
            while text not in self._cache:
                subject = self._sent.popleft()
                self._remember(subject, await self._worker.receive())
        except BaseException:
            self._sent.clear()
            raise

    def _remember(
        self, subject: str, found: list[tuple[tuple[int, int], ...]]
    ) -> None:
        matches = [Match(self.original, subject, spans) for spans in found]
        self._cache[subject] = (matches, [m.start() for m in matches])

    def search(self, text: str, pos: int = 0) -> Match | None:
        matches, starts = self._cache[text]
        index = bisect_left(starts, pos)
        return matches[index] if index < len(matches) else None

    def finditer(self, text: str) -> Iterator[Match]:
        return iter(self._cache[text][0])

    async def close(self) -> None:
        """Release an owned worker; a shared one drops the answers still owed."""
        if self._owns_worker:
            await self._worker.close()
        else:
            self._worker.forget(len(self._sent))
        self._sent.clear()
        self._cache.clear()


Pattern = re.Pattern[str] | AsyncRegex
RegexMatch = re.Match[str] | Match


async def prepare(pattern: Pattern, text: str) -> None:
    if isinstance(pattern, AsyncRegex):
        await pattern.prepare(text)
