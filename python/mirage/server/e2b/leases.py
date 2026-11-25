import asyncio
import logging
import secrets
from dataclasses import dataclass, field

from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class Sandbox:
    entry: WorkspaceEntry
    session_id: str
    access_token: str = field(repr=False)
    env_vars: dict[str, str] = field(repr=False)
    expires_at: float
    expiry: asyncio.TimerHandle = field(init=False, repr=False)


class Sandboxes:
    """Daemon-local leases and their workspace lifetimes."""

    def __init__(self, registry: WorkspaceRegistry) -> None:
        self._registry = registry
        self._leases: dict[str, Sandbox] = {}
        self._retiring: set[asyncio.Task[bool]] = set()

    def add(
        self, entry: WorkspaceEntry, env_vars: dict[str, str], timeout: int
    ) -> Sandbox:
        loop = asyncio.get_running_loop()
        lease = Sandbox(
            entry=entry,
            session_id=entry.runner.ws.default_session_id,
            access_token=secrets.token_urlsafe(32),
            env_vars=env_vars.copy(),
            expires_at=loop.time() + timeout,
        )
        lease.expiry = loop.call_at(lease.expires_at, self._expire, lease)
        self._leases[entry.id] = lease
        return lease

    def live(self, sandbox_id: str) -> Sandbox | None:
        lease = self._leases.get(sandbox_id)
        if lease is None:
            return None
        if (
            lease.expires_at <= asyncio.get_running_loop().time()
            or not lease.entry.accepting_jobs
            or not self._registered(lease)
        ):
            self._retire(lease)
            return None
        return lease

    def reconnect(
        self, sandbox_id: str, account: str | None, timeout: int
    ) -> Sandbox | None:
        lease = self.live(sandbox_id)
        if lease is None or lease.entry.owner != account:
            return None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        if deadline > lease.expires_at:
            lease.expiry.cancel()
            lease.expires_at = deadline
            lease.expiry = loop.call_at(deadline, self._expire, lease)
        return lease

    async def kill(self, sandbox_id: str, account: str | None) -> bool | None:
        lease = self.live(sandbox_id)
        if lease is None or lease.entry.owner != account:
            return None
        return await asyncio.shield(self._retire(lease))

    async def close(self) -> None:
        for lease in list(self._leases.values()):
            self._retire(lease)
        if self._retiring:
            await asyncio.gather(*self._retiring, return_exceptions=True)

    def _expire(self, lease: Sandbox) -> None:
        if self._leases.get(lease.entry.id) is not lease:
            return
        loop = asyncio.get_running_loop()
        if lease.expires_at > loop.time():
            lease.expiry = loop.call_at(lease.expires_at, self._expire, lease)
            return
        self._retire(lease)

    def _registered(self, lease: Sandbox) -> bool:
        entry = lease.entry
        return self._registry.visible(entry.id, entry.owner) is entry

    def _retire(self, lease: Sandbox) -> asyncio.Task[bool]:
        del self._leases[lease.entry.id]
        lease.expiry.cancel()
        if self._registered(lease):
            lease.entry.accepting_jobs = False
        task = asyncio.create_task(self._remove(lease))
        self._retiring.add(task)
        task.add_done_callback(self._retiring.discard)
        return task

    async def _remove(self, lease: Sandbox) -> bool:
        try:
            if self._registered(lease):
                await self._registry.remove(lease.entry.id)
        except Exception:
            logger.exception("could not remove sandbox %s", lease.entry.id)
            return False
        return True
