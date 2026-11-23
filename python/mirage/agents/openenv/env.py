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

import asyncio
import logging
import math
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from functools import partial
from types import TracebackType
from typing import Any, Self

from mcp.server import Server, ServerRequestContext
from mcp.types import (
    CallToolRequestParams,
    CallToolResult,
    ListToolsResult,
    PaginatedRequestParams,
)
from pydantic import JsonValue

try:
    from openenv.core.env_server.interfaces import Transform
    from openenv.core.env_server.mcp_environment import MCPEnvironment
    from openenv.core.env_server.mcp_types import (
        CallToolAction,
        ListToolsAction,
    )
    from openenv.core.env_server.types import (
        Action,
        EnvironmentMetadata,
        Observation,
    )
    from openenv.core.rubrics import Rubric
except ImportError as exc:
    raise ImportError(
        "`openenv` not installed. Install with: "
        "pip install 'openenv @ git+https://github.com/openenv/OpenEnv'"
    ) from exc

from mirage import __version__
from mirage.agents.openenv.constants import (
    NOT_OFFERED_EXIT,
    SERVER_NAME,
    TIMEOUT_EXIT,
)
from mirage.agents.openenv.convert import (
    io_to_observation,
    tool_to_observation,
)
from mirage.agents.openenv.mcp import MirageMCPTransport, MirageToolClient
from mirage.agents.openenv.types import (
    DoneHook,
    EpisodeSpec,
    MirageAction,
    MirageObservation,
    MirageState,
    RewardHook,
    SetupHook,
    WorkspaceFactory,
)
from mirage.bridge.sync import SyncBridge, on_owner_loop
from mirage.server.mcp import MirageMcpServer
from mirage.workspace.workspace import Session, Workspace

logger = logging.getLogger(__name__)


def check_timeout(timeout_s: float | None) -> None:
    """Refuse a time limit that cannot bound an action.

    Args:
        timeout_s (float | None): Seconds, or None for no limit.

    Raises:
        ValueError: Zero, negative, NaN or infinite.
    """
    if timeout_s is not None and not (
        math.isfinite(timeout_s) and timeout_s > 0
    ):
        raise ValueError(
            f"timeout_s must be a positive number of seconds, not {timeout_s}"
        )


def idle_event() -> asyncio.Event:
    """An event that starts set: a new episode runs no step."""
    event = asyncio.Event()
    event.set()
    return event


@dataclass(slots=True)
class Episode:
    """The workspace one episode runs in and the session its agent
    acts as.

    Args:
        workspace (Workspace): The episode's own workspace.
        session (Session): The agent's session in it.
        server (MirageMcpServer): The session's MCP tools.
        state (MirageState): The episode's step count and ids.
        steps (int): Steps of this episode still running.
        idle (asyncio.Event): Set while no step of this episode runs.
    """

    workspace: Workspace
    session: Session
    server: MirageMcpServer
    state: MirageState
    steps: int = 0
    idle: asyncio.Event = field(default_factory=idle_event)


@dataclass(slots=True)
class StepScope:
    """One running step, seen by the hooks it calls and the tasks they
    start.

    Args:
        episode (Episode): The episode the step runs in.
        active (bool): True until the step returns.
    """

    episode: Episode
    active: bool = True


STEPPING: ContextVar[StepScope | None] = ContextVar(
    "mirage_openenv_stepping", default=None
)


class MirageOpenEnv(MCPEnvironment):
    """A Mirage workspace as an OpenEnv environment.

    Each episode runs in a workspace of its own: a copy of ``workspace``
    (local mounts rebuilt from its state, remote mounts shared) or one
    ``factory`` builds, so a reset costs a snapshot rather than a
    container. A copy keeps the base's profiles but not its
    ``policies=[...]`` instances, which hold state; build episodes with
    ``factory`` to give each its own. The agent acts as one session,
    whose profile judges every call: a refusal comes back in the
    observation, never as an exception.

    ``step`` takes a ``MirageAction`` (a shell line or a file tool),
    or MCP's ``ListToolsAction`` and ``CallToolAction``, which reach
    Mirage's seven tools and every ``vfs_<call>`` in process. An action
    before the first reset starts an episode as ``reset()`` would.
    A reset or close waits for the episode's running steps, so a step
    runs and is judged in the episode it started in; from inside one of
    those steps' hooks it raises ``RuntimeError``.

    The async methods are the implementation; the sync ones run them on
    one owner loop and refuse to run on it. Close the environment with
    ``aclose`` (or ``close`` from sync code); the base workspace stays
    open for its owner.

    Args:
        workspace (Workspace | None): The base workspace each episode
            copies; it is never written.
        factory (WorkspaceFactory | None): Builds each episode's
            workspace from the reset request, instead of a copy.
        profile (str | None): The profile the agent's session is created
            under; None acts as the workspace's default session.
        setup (SetupHook | None): Prepares each episode's session after
            reset builds it, such as writing the task's files.
        reward (RewardHook | None): Scores each step; the ``rubric``
            scores it when None.
        done (DoneHook | None): Says whether a step ended the episode.
        max_steps (int | None): Ends the episode after this many steps.
        timeout_s (float | None): The default time limit of one action.
        transform (Transform[Observation] | None): Applied to every
            observation.
        rubric (Rubric | None): OpenEnv's reward, used when ``reward``
            is None.

    Raises:
        ValueError: Neither or both of ``workspace`` and ``factory``.
    """

    SUPPORTS_CONCURRENT_SESSIONS = True

    _sync_bridge: SyncBridge

    def __init__(
        self,
        workspace: Workspace | None = None,
        *,
        factory: WorkspaceFactory | None = None,
        profile: str | None = None,
        setup: SetupHook | None = None,
        reward: RewardHook | None = None,
        done: DoneHook | None = None,
        max_steps: int | None = None,
        timeout_s: float | None = None,
        transform: Transform[Observation] | None = None,
        rubric: Rubric | None = None,
    ) -> None:
        if (workspace is None) == (factory is None):
            raise ValueError("pass either a base workspace or a factory")
        check_timeout(timeout_s)
        self._base = workspace
        self._factory = factory
        self._profile = profile
        self._setup = setup
        self._reward = reward
        self._done = done
        self._max_steps = max_steps
        self._timeout_s = timeout_s
        self._sync_bridge = SyncBridge()
        self._lock = asyncio.Lock()
        self._episode: Episode | None = None
        self._shut = False
        self._closing: set[asyncio.Task[None]] = set()
        self._state = MirageState()
        tools: Server[dict[str, Any]] = Server(
            SERVER_NAME,
            version=__version__,
            on_list_tools=self._list_tools,
            on_call_tool=self._call_tool,
        )
        super().__init__(MirageMCPTransport(tools), transform=transform)
        self.mcp_client = MirageToolClient(self.mcp_server, mode="legacy")
        self.rubric = rubric

    @property
    def state(self) -> MirageState:
        return self._state

    @property
    def supports_code_mode(self) -> bool:
        return False

    def get_metadata(self) -> EnvironmentMetadata:
        return EnvironmentMetadata(
            name="mirage",
            description=(
                "A Mirage workspace: a bash-compatible shell and file "
                "tools over its mounts."
            ),
            version=__version__,
        )

    @on_owner_loop
    async def reset_async(
        self,
        seed: int | None = None,
        episode_id: str | None = None,
        **kwargs: JsonValue,
    ) -> Observation:
        self._refuse_from_own_step("reset")
        spec = EpisodeSpec(episode_id or str(uuid.uuid4()), seed, dict(kwargs))
        async with self._quiet():
            await self._end()
            episode = await self._begin(spec)
        return self._apply_transform(
            MirageObservation(cwd=episode.session.state.cwd)
        )

    def reset(
        self,
        seed: int | None = None,
        episode_id: str | None = None,
        **kwargs: JsonValue,
    ) -> Observation:
        return self._sync_bridge.run(
            partial(self.reset_async, seed, episode_id, **kwargs),
            "reset_async",
        )

    @on_owner_loop
    async def step_async(
        self,
        action: Action,
        timeout_s: float | None = None,
        **kwargs: JsonValue,
    ) -> Observation:
        check_timeout(timeout_s)
        episode = await self._current()
        episode.steps += 1
        episode.idle.clear()
        scope = StepScope(episode)
        token = STEPPING.set(scope)
        try:
            return await self._step(episode, action, timeout_s)
        finally:
            scope.active = False
            STEPPING.reset(token)
            episode.steps -= 1
            if episode.steps == 0:
                episode.idle.set()

    async def _step(
        self, episode: Episode, action: Action, timeout_s: float | None
    ) -> Observation:
        timeout = timeout_s if timeout_s is not None else self._timeout_s
        if isinstance(action, ListToolsAction):
            return await super().step_async(action, timeout_s=timeout)
        observation: Observation
        if isinstance(action, CallToolAction):
            observation = await super().step_async(action, timeout_s=timeout)
        elif isinstance(action, MirageAction):
            observation = await self._act(episode.session, action, timeout)
        else:
            raise TypeError(
                "MirageOpenEnv takes MirageAction, ListToolsAction or "
                f"CallToolAction, not {type(action).__name__}"
            )
        return await self._judge(episode, action, observation)

    def step(
        self,
        action: Action,
        timeout_s: float | None = None,
        **kwargs: JsonValue,
    ) -> Observation:
        return self._sync_bridge.run(
            partial(self.step_async, action, timeout_s, **kwargs),
            "step_async",
        )

    def _step_impl(
        self,
        action: Action,
        timeout_s: float | None = None,
        **kwargs: JsonValue,
    ) -> Observation:
        return self.step(action, timeout_s, **kwargs)

    async def aclose(self) -> None:
        """Close the episode's workspace and the owner loop this
        environment started; the base workspace stays open."""
        self._refuse_from_own_step("close")
        self._shut = True
        await self._finish()
        await self._sync_bridge.ashutdown()
        super().close()

    def close(self) -> None:
        """Close from sync code. On the owner loop itself, where it may
        not block, the episode's workspace closes as soon as the loop is
        free; ``aclose`` waits for that."""
        self._shut = True
        if self._episode is not None:
            try:
                running = asyncio.get_running_loop()
            except RuntimeError:
                running = None
            if running is not None and running is self._sync_bridge.loop:
                closing = running.create_task(self._finish())
                self._closing.add(closing)
                closing.add_done_callback(self._closed)
            else:
                self._sync_bridge.run(self._finish, "aclose")
        self._sync_bridge.shutdown()
        super().close()

    def _closed(self, task: asyncio.Task[None]) -> None:
        self._closing.discard(task)
        if not task.cancelled() and (exc := task.exception()) is not None:
            logger.debug("closing the episode failed", exc_info=exc)

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def _begin(self, spec: EpisodeSpec) -> Episode:
        if self._shut:
            raise RuntimeError("the environment is closed")
        await self._reset_rubric_async()
        workspace = (
            await self._base.copy()
            if self._base is not None
            else await self._build(spec)
        )
        try:
            await workspace.ensure_sessions_loaded()
            session_id = spec.episode_id if self._profile else None
            session = (
                await workspace.session(spec.episode_id, profile=self._profile)
                if self._profile
                else Session(workspace, None)
            )
            if self._setup is not None:
                await self._setup(session, spec)
        except BaseException:
            await workspace.close()
            raise
        episode = Episode(
            workspace,
            session,
            MirageMcpServer(workspace, session_id=session_id, all_calls=True),
            MirageState(
                episode_id=spec.episode_id,
                workspace_id=workspace.workspace_id,
                session_id=session.session_id,
                cwd=session.state.cwd,
                seed=spec.seed,
            ),
        )
        self._episode = episode
        self._state = episode.state
        return episode

    async def _build(self, spec: EpisodeSpec) -> Workspace:
        assert self._factory is not None
        return await self._factory(spec)

    @asynccontextmanager
    async def _quiet(self) -> AsyncIterator[None]:
        while True:
            if self._episode is not None:
                await self._episode.idle.wait()
            await self._lock.acquire()
            if self._episode is None or self._episode.steps == 0:
                break
            self._lock.release()
        try:
            yield
        finally:
            self._lock.release()

    async def _end(self) -> None:
        episode, self._episode = self._episode, None
        if episode is not None:
            await episode.workspace.close()

    def _refuse_from_own_step(self, verb: str) -> None:
        scope = STEPPING.get()
        if (
            scope is not None
            and scope.active
            and scope.episode is self._episode
        ):
            raise RuntimeError(
                f"cannot {verb} the environment from inside one of its "
                "steps; the step would wait for itself"
            )

    @on_owner_loop
    async def _finish(self) -> None:
        async with self._quiet():
            await self._end()

    async def _current(self) -> Episode:
        async with self._lock:
            if self._shut:
                raise RuntimeError("the environment is closed")
            if self._episode is None:
                return await self._begin(EpisodeSpec(str(uuid.uuid4())))
            return self._episode

    async def _act(
        self, session: Session, action: MirageAction, timeout: float | None
    ) -> MirageObservation:
        if action.tool not in await session.tools.offered():
            return MirageObservation(
                tool=action.tool,
                stderr=f"{action.tool}: not offered to this session\n",
                exit_code=NOT_OFFERED_EXIT,
                cwd=session.state.cwd,
            )
        limit = asyncio.timeout(timeout)
        try:
            async with limit:
                return await self._run(session, action)
        except TimeoutError:
            if not limit.expired():
                raise
            logger.debug("%s timed out after %ss", action.tool, timeout)
            return MirageObservation(
                tool=action.tool,
                stderr=f"{action.tool}: timed out after {timeout}s\n",
                exit_code=TIMEOUT_EXIT,
                timed_out=True,
                cwd=session.state.cwd,
            )

    async def _run(
        self, session: Session, action: MirageAction
    ) -> MirageObservation:
        if action.tool == "shell":
            io = await session.shell(str(action.arguments["command"]))
            return await io_to_observation(io, session.state.cwd)
        result = await session.tools.call(action.tool, action.arguments)
        return tool_to_observation(action.tool, result, session.state.cwd)

    async def _judge(
        self, episode: Episode, action: Action, observation: Observation
    ) -> Observation:
        session = episode.session
        episode.state.step_count += 1
        episode.state.cwd = session.state.cwd
        if self._reward is not None:
            observation.reward = await self._reward(
                session, action, observation
            )
        elif self.rubric is not None:
            observation.reward = await self._apply_rubric_async(
                action, observation
            )
        observation.done = (
            self._max_steps is not None
            and episode.state.step_count >= self._max_steps
        ) or (
            self._done is not None
            and await self._done(session, action, observation)
        )
        return self._apply_transform(observation)

    @on_owner_loop
    async def _list_tools(
        self,
        ctx: ServerRequestContext[dict[str, Any]],
        params: PaginatedRequestParams | None,
    ) -> ListToolsResult:
        episode = await self._current()
        return await episode.server.list_tools(ctx, params)

    @on_owner_loop
    async def _call_tool(
        self,
        ctx: ServerRequestContext[dict[str, Any]],
        params: CallToolRequestParams,
    ) -> CallToolResult:
        episode = await self._current()
        return await episode.server.call_tool(ctx, params)
