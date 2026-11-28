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
import os
import time
from datetime import datetime

from backend import create_mirage_rollout
from config import TinkerRunConfig
from constants import RECIPE_NAME, VERIFIER_SCRIPT_PATH
from dataset import MirageDatasetBuilder, load_mirage_tasks
from schemas import BenchCase, BenchFixtures, MirageTask
from server import ServerPool
from tinker_cookbook import cli_utils, model_info
from tinker_cookbook.tool_use import AgentToolMessageEnv
from utils import MirageShellTool, shell_turn
from verifier import MirageVerifier


async def run_synthetic_rollout(
    task: MirageTask,
    servers: ServerPool,
    case: BenchCase,
) -> tuple[bool, bool]:
    """Run one synthetic rollout across Mirage VFS, backend servers, and tests.

    Args:
        task (MirageTask): Harbor-compatible Mirage task to execute.
        servers (ServerPool): Shared pool of ``integ/server`` backends.
        case (BenchCase): Commands to execute and expected verifier reward.

    Returns:
        tuple[bool, bool]: Whether reward matched ``case.expected_reward`` and
            whether ``/tests`` remained hidden under the default profile.
    """
    rollout = await create_mirage_rollout(task, servers)
    shell_tool = MirageShellTool(rollout.workspace)

    peek = await rollout.workspace.tools.shell(f"cat {VERIFIER_SCRIPT_PATH}")
    tests_hidden = peek.is_error

    env = AgentToolMessageEnv(
        tools=[shell_tool.shell],
        initial_messages=[{"role": "user", "content": task.instruction}],
        max_turns=len(case.commands) + 2,
        reward_fn=MirageVerifier(rollout),
    )
    await env.initial_observation()

    for idx, cmd in enumerate(case.commands, start=1):
        step = await env.step(shell_turn(f"tc_{idx}", cmd))
        assert not step.episode_done

    final_step = await env.step({"role": "assistant", "content": "Completed."})
    assert final_step.episode_done
    await rollout.close()
    return final_step.reward == case.expected_reward, tests_hidden


async def run_bench(config: TinkerRunConfig) -> None:
    """Benchmark concurrent Mirage + multi-backend ServerPool rollouts.

    Args:
        config (TinkerRunConfig): Validated runtime configuration.
    """
    tasks = load_mirage_tasks(config.data_dir)
    if not tasks:
        raise RuntimeError(f"No tasks found in {config.data_dir / 'tasks'}")

    attrs = model_info.get_model_attributes(config.model)
    print(
        f"Loaded {len(tasks)} task(s): {[t.task_name for t in tasks]} | "
        f"model={config.model} ({attrs.size_str})"
    )

    task = tasks[0]
    fixtures_path = task.task_dir / "tests" / "fixtures.json"
    fixtures = BenchFixtures.model_validate_json(fixtures_path.read_text())

    servers = ServerPool(
        fixture_root=config.data_dir / "fixtures",
        endpoints=config.endpoints,
    )
    try:
        t0 = time.perf_counter()
        outcomes = await asyncio.gather(
            *(
                run_synthetic_rollout(
                    task,
                    servers,
                    fixtures.passing if i % 2 == 0 else fixtures.failing,
                )
                for i in range(config.rollouts)
            )
        )
        elapsed = time.perf_counter() - t0
    finally:
        await servers.close()

    matched_count = sum(1 for matched, _ in outcomes if matched)
    all_hidden = all(hidden for _, hidden in outcomes)
    ms_per_rollout = (elapsed / config.rollouts) * 1000
    print(
        f"Completed {config.rollouts} concurrent rollouts in {elapsed:.2f}s "
        f"({ms_per_rollout:.2f} ms/rollout) | "
        f"tests_hidden={all_hidden} | "
        f"matched={matched_count}/{config.rollouts}"
    )
    assert all_hidden
    assert matched_count == config.rollouts


async def run_tinker_train(config: TinkerRunConfig) -> None:
    """Launch GRPO RL training on Tinker over the Mirage-Harbor data folder.

    Args:
        config (TinkerRunConfig): Validated runtime configuration.
    """
    if not os.environ.get("TINKER_API_KEY"):
        raise SystemExit(
            "TINKER_API_KEY is not set. Add it to .env.development or export "
            "TINKER_API_KEY from https://thinkingmachines.ai/tinker."
        )
    from tinker_cookbook.rl.train import Config
    from tinker_cookbook.rl.train import main as rl_train_main

    tasks = load_mirage_tasks(config.data_dir)
    if not tasks:
        raise RuntimeError(f"No tasks found in {config.data_dir / 'tasks'}")

    servers = ServerPool(
        fixture_root=config.data_dir / "fixtures",
        endpoints=config.endpoints,
    )
    try:
        renderer_name = model_info.get_recommended_renderer_name(config.model)
        stamp = datetime.now().strftime("%Y-%m-%d-%H-%M")
        model_tag = config.model.replace("/", "-").replace(":", "-")
        run_name = f"mirage-rl-{model_tag}-{stamp}"
        log_path = cli_utils.runs_path(RECIPE_NAME, run_name)

        dataset_builder = MirageDatasetBuilder(
            tasks=tasks,
            servers=servers,
            batch_size=len(tasks),
            group_size=config.group_size,
            model_name=config.model,
            renderer_name=renderer_name,
            max_turns=config.max_turns,
            max_trajectory_tokens=config.max_trajectory_tokens,
            max_generation_tokens=config.max_generation_tokens,
        )
        rl_config = Config(
            learning_rate=config.learning_rate,
            dataset_builder=dataset_builder,
            model_name=config.model,
            recipe_name=RECIPE_NAME,
            lora_rank=config.lora_rank,
            max_tokens=config.max_generation_tokens,
            temperature=config.temperature,
            log_path=log_path,
            eval_every=config.max_steps,
            save_every=config.max_steps,
            max_steps=config.max_steps,
        )
        cli_utils.check_log_dir(log_path, behavior_if_exists="overwrite")
        await rl_train_main(rl_config)
    finally:
        await servers.close()
