import asyncio

import pytest

pytest.importorskip("openenv")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from openenv.core.env_server.http_server import HTTPEnvServer
from openenv.core.env_server.mcp_types import (
    CallToolAction,
    ListToolsAction,
    ToolErrorType,
)
from openenv.core.env_server.types import Action, Observation
from openenv.core.rubrics import Rubric

from mirage import RAMVFS, CommandContext, Deny, MountMode, Policy, Workspace
from mirage.agents.openenv import (
    EpisodeSpec,
    MirageAction,
    MirageObservation,
    MirageOpenEnv,
    MirageState,
    Refusal,
)
from mirage.workspace.workspace import Session

TOOLS = {"shell", "read", "write", "edit", "ls", "grep", "glob"}


def shell(command: str) -> MirageAction:
    return MirageAction(arguments={"command": command})


def base(**kwargs) -> Workspace:
    return Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE, **kwargs)


async def closed(ws: Workspace) -> bool:
    try:
        await ws.shell("true")
    except RuntimeError as exc:
        return "closed" in str(exc)
    return False


class NoRm(Policy):
    async def pre_command(self, ctx: CommandContext) -> Deny | None:
        return Deny("no rm here") if ctx.command == "rm" else None


class Factory:
    def __init__(self) -> None:
        self.specs: list[EpisodeSpec] = []
        self.built: list[Workspace] = []

    async def __call__(self, spec: EpisodeSpec) -> Workspace:
        self.specs.append(spec)
        ws = base()
        await ws.shell(f"echo {spec.options.get('task', 'none')} > /data/task")
        self.built.append(ws)
        return ws


@pytest.mark.asyncio
async def test_each_episode_starts_from_a_fresh_copy_of_the_base():
    ws = base()
    await ws.shell("echo seed > /data/seed.txt")
    async with MirageOpenEnv(ws) as env:
        await env.reset_async()
        await env.step_async(
            shell("echo dirty > /data/seed.txt; touch /data/new")
        )
        first = env.state.workspace_id
        await env.reset_async()
        after = await env.step_async(shell("cat /data/seed.txt; ls /data"))
        second = env.state.workspace_id
    untouched = await ws.shell("ls /data")
    listing = await untouched.stdout_str()
    await ws.close()

    assert after.stdout == "seed\nseed.txt\n"
    assert first != second
    assert listing == "seed.txt\n"


@pytest.mark.asyncio
async def test_two_environments_over_one_base_never_share_files():
    ws = base()
    one, two = MirageOpenEnv(ws), MirageOpenEnv(ws)
    await asyncio.gather(one.reset_async(), two.reset_async())
    await asyncio.gather(
        one.step_async(shell("echo one > /data/who")),
        two.step_async(shell("echo two > /data/who")),
    )
    seen = await asyncio.gather(
        one.step_async(shell("cat /data/who")),
        two.step_async(shell("cat /data/who")),
    )
    await asyncio.gather(one.aclose(), two.aclose())
    await ws.close()

    assert [o.stdout for o in seen] == ["one\n", "two\n"]


@pytest.mark.asyncio
async def test_a_factory_builds_each_episode_from_the_reset_request():
    factory = Factory()
    env = MirageOpenEnv(factory=factory)
    reset = await env.reset_async(seed=7, episode_id="ep-1", task="sort")
    task = await env.step_async(shell("cat /data/task"))
    await env.reset_async()
    await env.aclose()

    assert isinstance(reset, MirageObservation)
    assert reset.cwd == "/"
    assert task.stdout == "sort\n"
    assert factory.specs[0] == EpisodeSpec("ep-1", 7, {"task": "sort"})
    assert factory.specs[1].seed is None
    assert [await closed(w) for w in factory.built] == [True, True]


@pytest.mark.asyncio
async def test_the_state_names_the_episode():
    env = MirageOpenEnv(base())
    before = env.state
    await env.reset_async(seed=3, episode_id="ep-9")
    await env.step_async(shell("cd /data"))
    state = env.state
    await env.aclose()

    assert before == MirageState()
    assert isinstance(state, MirageState)
    assert state.episode_id == "ep-9"
    assert state.seed == 3
    assert state.step_count == 1
    assert state.cwd == "/data"
    assert state.workspace_id is not None


def test_exactly_one_source_is_required():
    with pytest.raises(ValueError):
        MirageOpenEnv()
    with pytest.raises(ValueError):
        MirageOpenEnv(base(), factory=Factory())


@pytest.mark.asyncio
async def test_setup_prepares_each_episode():
    async def setup(session: Session, spec: EpisodeSpec) -> None:
        await session.vfs.write("/data/task.txt", f"{spec.seed}\n".encode())

    env = MirageOpenEnv(base(), setup=setup)
    await env.reset_async(seed=42)
    task = await env.step_async(shell("cat /data/task.txt"))
    await env.aclose()

    assert task.stdout == "42\n"


@pytest.mark.asyncio
async def test_a_failing_setup_raises_and_closes_its_workspace():
    factory = Factory()

    async def setup(session: Session, spec: EpisodeSpec) -> None:
        raise LookupError("no such task")

    env = MirageOpenEnv(factory=factory, setup=setup)
    with pytest.raises(LookupError, match="no such task"):
        await env.reset_async()
    await env.aclose()

    assert await closed(factory.built[0])


@pytest.mark.asyncio
async def test_a_failing_factory_raises():
    async def factory(spec: EpisodeSpec) -> Workspace:
        raise ConnectionError("bucket unreachable")

    env = MirageOpenEnv(factory=factory)
    with pytest.raises(ConnectionError, match="bucket unreachable"):
        await env.reset_async()
    with pytest.raises(ConnectionError):
        await env.step_async(shell("true"))
    await env.aclose()


@pytest.mark.asyncio
async def test_a_shell_step_reports_stdout_stderr_and_exit_code():
    env = MirageOpenEnv(base())
    await env.reset_async()
    ran = await env.step_async(shell("echo out; echo err >&2; exit 3"))
    await env.aclose()

    assert isinstance(ran, MirageObservation)
    assert (ran.tool, ran.stdout, ran.stderr, ran.exit_code) == (
        "shell",
        "out\n",
        "err\n",
        3,
    )
    assert ran.refusal is None
    assert ran.timed_out is False


@pytest.mark.asyncio
async def test_the_working_directory_carries_across_steps():
    env = MirageOpenEnv(base())
    await env.reset_async()
    moved = await env.step_async(shell("cd /data && echo hi > here"))
    read = await env.step_async(shell("cat here"))
    await env.aclose()

    assert moved.cwd == "/data"
    assert read.stdout == "hi\n"


@pytest.mark.asyncio
async def test_a_refused_line_carries_the_policys_record():
    ws = base(profiles={"default": {"commands": {"rm": "deny"}}})
    await ws.shell("touch /data/keep")
    env = MirageOpenEnv(ws)
    await env.reset_async()
    refused = await env.step_async(shell("rm /data/keep"))
    kept = await env.step_async(shell("ls /data"))
    await env.aclose()
    await ws.close()

    assert refused.exit_code != 0
    assert "Permission denied" in refused.stderr
    assert refused.refusal == Refusal(
        kind="deny", reason="rm is not allowed", policy="PermissionsPolicy"
    )
    assert kept.stdout == "keep\n"


@pytest.mark.asyncio
async def test_a_tool_the_profile_does_not_offer_answers_126():
    ws = base(profiles={"locked": {"commands": {"*": "deny"}}})
    env = MirageOpenEnv(ws, profile="locked")
    await env.reset_async(episode_id="agent")
    refused = await env.step_async(shell("ls"))
    read = await env.step_async(
        MirageAction(tool="glob", arguments={"pattern": "*"})
    )
    session = env.state.session_id
    await env.aclose()
    await ws.close()

    assert session == "agent"
    assert refused.exit_code == 126
    assert refused.stderr == "shell: not offered to this session\n"
    assert read.exit_code == 0


@pytest.mark.asyncio
async def test_file_tools_answer_in_stdout_or_stderr():
    env = MirageOpenEnv(base())
    await env.reset_async()
    wrote = await env.step_async(
        MirageAction(
            tool="write", arguments={"path": "/data/a.txt", "content": "hi\n"}
        )
    )
    read = await env.step_async(
        MirageAction(tool="read", arguments={"path": "/data/a.txt"})
    )
    missing = await env.step_async(
        MirageAction(tool="read", arguments={"path": "/data/none"})
    )
    await env.aclose()

    assert (wrote.exit_code, wrote.stdout) == (0, "Written: /data/a.txt")
    assert read.stdout == "     1\thi\n"
    assert missing.exit_code == 1
    assert missing.stdout == ""
    assert "not found" in missing.stderr


@pytest.mark.asyncio
async def test_a_step_past_its_timeout_answers_124_and_the_session_goes_on():
    env = MirageOpenEnv(base(), timeout_s=5)
    await env.reset_async()
    slow = await env.step_async(shell("sleep 3; echo late"), timeout_s=0.1)
    fast = await env.step_async(shell("echo next"))
    await env.aclose()

    assert slow.exit_code == 124
    assert slow.timed_out is True
    assert slow.stdout == ""
    assert slow.stderr == "shell: timed out after 0.1s\n"
    assert fast.stdout == "next\n"


@pytest.mark.asyncio
async def test_the_reward_and_done_hooks_judge_each_step():
    seen: list[tuple[str, str]] = []

    async def reward(
        session: Session, action: Action, observation: Observation
    ) -> float:
        assert isinstance(observation, MirageObservation)
        seen.append((session.session_id, observation.stdout))
        return 1.0 if await session.vfs.exists("/data/answer") else 0.0

    async def done(
        session: Session, action: Action, observation: Observation
    ) -> bool:
        return await session.vfs.exists("/data/answer")

    env = MirageOpenEnv(base(), reward=reward, done=done)
    await env.reset_async()
    first = await env.step_async(shell("echo working"))
    second = await env.step_async(shell("echo 42 > /data/answer"))
    session = env.state.session_id
    await env.aclose()

    assert (first.reward, first.done) == (0.0, False)
    assert (second.reward, second.done) == (1.0, True)
    assert seen == [(session, "working\n"), (session, "")]


@pytest.mark.asyncio
async def test_a_failing_reward_hook_raises():
    async def reward(
        session: Session, action: Action, observation: Observation
    ) -> float:
        raise ZeroDivisionError("bad grader")

    env = MirageOpenEnv(base(), reward=reward)
    await env.reset_async()
    with pytest.raises(ZeroDivisionError, match="bad grader"):
        await env.step_async(shell("true"))
    await env.aclose()


@pytest.mark.asyncio
async def test_max_steps_ends_the_episode():
    env = MirageOpenEnv(base(), max_steps=2)
    await env.reset_async()
    first = await env.step_async(shell("true"))
    second = await env.step_async(shell("true"))
    await env.reset_async()
    again = await env.step_async(shell("true"))
    await env.aclose()

    assert [first.done, second.done, again.done] == [False, True, False]


@pytest.mark.asyncio
async def test_a_reset_waits_for_the_step_it_replaces():
    factory = Factory()
    judging = asyncio.Event()
    release = asyncio.Event()
    open_while_judged: list[bool] = []

    async def reward(
        session: Session, action: Action, observation: Observation
    ) -> float:
        judging.set()
        await release.wait()
        open_while_judged.append(not await closed(factory.built[0]))
        return 1.0

    env = MirageOpenEnv(factory=factory, reward=reward, max_steps=1)
    await env.reset_async()
    step = asyncio.create_task(env.step_async(shell("true")))
    await judging.wait()
    reset = asyncio.create_task(env.reset_async())
    await asyncio.sleep(0.05)
    reset_waited = not reset.done()
    release.set()
    observation = await step
    await reset
    first_closed = await closed(factory.built[0])
    await env.aclose()

    assert reset_waited
    assert open_while_judged == [True]
    assert observation.done is True
    assert first_closed
    assert env.state.step_count == 0


class ExitCodeRubric(Rubric):
    def __init__(self) -> None:
        super().__init__()
        self.resets = 0

    def forward(self, action: Action, observation: Observation) -> float:
        assert isinstance(observation, MirageObservation)
        return 1.0 if observation.exit_code == 0 else -1.0

    def reset(self) -> None:
        self.resets += 1


@pytest.mark.asyncio
async def test_the_rubric_scores_when_no_hook_does():
    rubric = ExitCodeRubric()
    env = MirageOpenEnv(base(), rubric=rubric)
    await env.reset_async()
    ok = await env.step_async(shell("true"))
    failed = await env.step_async(shell("false"))
    await env.reset_async()
    await env.aclose()

    assert (ok.reward, failed.reward) == (1.0, -1.0)
    assert rubric.resets == 2
    assert env.rubric is rubric


@pytest.mark.asyncio
async def test_an_action_before_reset_starts_an_episode():
    env = MirageOpenEnv(base())
    ran = await env.step_async(shell("echo hi"))
    state = env.state
    await env.aclose()

    assert ran.stdout == "hi\n"
    assert state.episode_id is not None
    assert state.step_count == 1


@pytest.mark.asyncio
async def test_an_unknown_action_type_raises():
    env = MirageOpenEnv(base())
    with pytest.raises(TypeError, match="MirageAction"):
        await env.step_async(Action())
    await env.aclose()


@pytest.mark.asyncio
async def test_mcp_actions_reach_the_tools_and_the_vfs_calls():
    ws = base(profiles={"default": {"commands": {"rm": "deny"}}})
    env = MirageOpenEnv(ws)
    await env.reset_async()
    listed = await env.step_async(ListToolsAction())
    wrote = await env.step_async(
        CallToolAction(
            tool_name="write",
            arguments={"path": "/data/a.txt", "content": "hi\n"},
        )
    )
    exists = await env.step_async(
        CallToolAction(
            tool_name="vfs_exists", arguments={"path": "/data/a.txt"}
        )
    )
    refused = await env.step_async(
        CallToolAction(
            tool_name="shell", arguments={"command": "rm /data/a.txt"}
        )
    )
    steps = env.state.step_count
    await env.aclose()
    await ws.close()

    names = {tool.name for tool in listed.tools}
    assert TOOLS <= names
    assert {"vfs_read", "vfs_stat", "vfs_exists"} <= names
    assert wrote.error is None and wrote.result.is_error is False
    assert exists.result.content[0].text == '{"exists":true}'
    assert exists.result.data == '{"exists":true}'
    assert refused.result is None
    assert refused.error.error_type == ToolErrorType.EXECUTION_ERROR
    assert "policy denied: rm is not allowed" in refused.error.message
    assert steps == 3


@pytest.mark.asyncio
async def test_a_held_mcp_session_follows_the_episode_across_resets():
    env = MirageOpenEnv(base())
    async with env.mcp_session() as client:
        await env.reset_async()
        await client.call_tool("shell", {"command": "touch /data/first"})
        await env.reset_async()
        result = await client.call_tool("shell", {"command": "ls /data"})
    await env.aclose()

    assert result.content[0].text == ""


@pytest.mark.asyncio
async def test_aclose_closes_the_episode_and_leaves_the_base_open():
    factory = Factory()
    env = MirageOpenEnv(factory=factory)
    await env.reset_async()
    await env.aclose()
    ws = base()
    env = MirageOpenEnv(ws)
    await env.reset_async()
    await env.aclose()

    assert await closed(factory.built[0])
    assert not await closed(ws)
    await ws.close()


@pytest.mark.asyncio
async def test_a_closed_environment_refuses_to_start_an_episode():
    ws = base()
    env = MirageOpenEnv(ws)
    await env.reset_async()
    await env.aclose()

    with pytest.raises(RuntimeError, match="closed"):
        await env.step_async(shell("echo x"))
    with pytest.raises(RuntimeError, match="closed"):
        await env.reset_async()
    await ws.close()


@pytest.mark.parametrize("limit", [0, -1, float("nan"), float("inf")])
def test_a_time_limit_that_bounds_nothing_is_refused(limit):
    ws = base()
    with pytest.raises(ValueError, match="timeout_s"):
        MirageOpenEnv(ws, timeout_s=limit)
    env = MirageOpenEnv(ws)
    with pytest.raises(ValueError, match="timeout_s"):
        env.step(shell("echo x"), timeout_s=limit)
    env.close()


@pytest.mark.asyncio
async def test_close_on_the_owner_loop_closes_the_episode_once_free():
    factory = Factory()
    env = MirageOpenEnv(factory=factory)
    await env.reset_async()
    env.close()
    await env.aclose()

    assert await closed(factory.built[0])


@pytest.mark.asyncio
async def test_close_from_a_worker_thread_closes_on_the_owner_loop():
    factory = Factory()
    env = MirageOpenEnv(factory=factory)
    await env.reset_async()
    await asyncio.get_running_loop().run_in_executor(None, env.close)

    assert await closed(factory.built[0])
    assert env.mcp_client is None


@pytest.mark.asyncio
async def test_policy_instances_stay_with_the_base_and_profiles_travel():
    ws = base(
        profiles={"default": {"commands": {"mv": "deny"}}},
        policies=[NoRm()],
    )
    await ws.shell("touch /data/a /data/b")
    env = MirageOpenEnv(ws)
    await env.reset_async()
    removed = await env.step_async(shell("rm /data/a"))
    moved = await env.step_async(shell("mv /data/b /data/c"))
    await env.aclose()
    on_base = await ws.shell("rm /data/a")
    await ws.close()

    assert removed.exit_code == 0
    assert moved.refusal is not None
    assert on_base.exit_code == 126


@pytest.mark.asyncio
async def test_the_sync_api_refuses_its_owner_loop():
    env = MirageOpenEnv(base())
    await env.reset_async()
    with pytest.raises(RuntimeError, match="await step_async"):
        env.step(shell("true"))
    await env.aclose()


def test_the_sync_api_runs_on_a_loop_of_its_own():
    factory = Factory()
    env = MirageOpenEnv(factory=factory)
    reset = env.reset(task="sync")
    ran = env.step(shell("cat /data/task"))
    listed = env.step(ListToolsAction())
    env.close()

    assert reset.done is False
    assert ran.stdout == "sync\n"
    assert TOOLS <= {tool.name for tool in listed.tools}
    assert env._sync_bridge.loop is not None
    assert env._sync_bridge.loop.is_closed()


def test_a_never_reset_environment_closes_cleanly():
    env = MirageOpenEnv(base())
    env.close()

    assert env.mcp_client is None


def serve(factory) -> TestClient:
    server = HTTPEnvServer(
        factory,
        MirageAction,
        MirageObservation,
        max_concurrent_envs=2,
        state_cls=MirageState,
    )
    app = FastAPI()
    server.register_routes(app)
    return TestClient(app)


def test_http_env_server_serves_an_episode_over_websocket():
    factory = Factory()
    with serve(lambda: MirageOpenEnv(factory=factory)) as client:
        with client.websocket_connect("/ws") as ws:
            ws.send_json({"type": "reset", "data": {"seed": 1, "task": "ws"}})
            reset = ws.receive_json()
            ws.send_json(
                {
                    "type": "step",
                    "data": {
                        "tool": "shell",
                        "arguments": {"command": "cat /data/task; ls /no"},
                    },
                }
            )
            step = ws.receive_json()
            ws.send_json({"type": "state"})
            state = ws.receive_json()
            ws.send_json(
                {
                    "type": "mcp",
                    "data": {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {
                            "name": "read",
                            "arguments": {"path": "/data/task"},
                        },
                    },
                }
            )
            mcp = ws.receive_json()
            ws.send_json(
                {"type": "step", "data": {"tool": "read", "arguments": {}}}
            )
            invalid = ws.receive_json()
            ws.send_json({"type": "close"})

    assert reset["data"]["observation"]["cwd"] == "/"
    observation = step["data"]["observation"]
    assert observation["stdout"] == "ws\n"
    assert "/no" in observation["stderr"]
    assert observation["exit_code"] == 2
    assert state["data"]["seed"] == 1
    assert state["data"]["step_count"] == 1
    assert mcp["data"]["result"]["content"][0]["text"] == "     1\tws\n"
    assert invalid["data"]["code"] == "VALIDATION_ERROR"
    assert "'path' is a required" in invalid["data"]["errors"][0]["msg"]


def test_http_env_server_answers_the_stateless_routes():
    factory = Factory()
    with serve(lambda: MirageOpenEnv(factory=factory)) as client:
        reset = client.post("/reset", json={"seed": 2})
        step = client.post(
            "/step", json={"action": {"arguments": {"command": "pwd"}}}
        )
        listed = client.post(
            "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        )
        called = client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "shell", "arguments": {"command": "pwd"}},
            },
        )

    assert reset.status_code == 200
    assert step.json()["observation"]["stdout"] == "/\n"
    assert TOOLS <= {t["name"] for t in listed.json()["result"]["tools"]}
    assert called.json()["result"]["data"] == "/\n"
    assert all(asyncio.run(closed(w)) for w in factory.built)
