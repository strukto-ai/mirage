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
import ipaddress
import json
import logging
import os
import time
from collections.abc import Coroutine, Iterable
from typing import Any, TypeVar, cast
from urllib.parse import urlparse

from openai import AsyncOpenAI

from examples.rl.constants import VERIFIER_SCRIPT_PATH
from examples.rl.dataset import load_mirage_tasks
from examples.rl.openenv.config import OpenEnvRunConfig
from examples.rl.openenv.environment import OpenEnvHarness
from examples.rl.openenv.schemas import EpisodeMetrics
from examples.rl.openenv.utils import SHELL_TOOL_SCHEMA, format_observation
from examples.rl.schemas import BenchCase, BenchFixtures, MirageTask
from examples.rl.server import ServerPool

logger = logging.getLogger(__name__)

_T = TypeVar("_T")


def _is_loopback_host(hostname: str | None) -> bool:
    if not hostname:
        return False
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError as exc:
        logger.debug("Host %s is not an IP literal: %s", hostname, exc)
        return False


def _validate_eval_base_url(base_url: str | None, api_key: str | None) -> None:
    """Reject cleartext HTTP to non-loopback hosts when an API key is set.

    Args:
        base_url (str | None): Configured OpenAI-compatible base URL.
        api_key (str | None): Configured API key, if any.
    """
    if not base_url or not api_key:
        return
    parsed = urlparse(base_url)
    scheme = parsed.scheme.lower()
    if scheme == "https":
        return
    if scheme == "http" and _is_loopback_host(parsed.hostname):
        return
    raise SystemExit(
        f"Refusing to send OPENAI_API_KEY over non-HTTPS base URL "
        f"{base_url!r}. Use https:// for remote endpoints, a loopback "
        "host for local servers, or unset OPENAI_API_KEY."
    )


async def _gather_cancelling(
    coros: Iterable[Coroutine[Any, Any, _T]],
) -> list[_T]:
    """Await ``coros`` concurrently, cancelling unfinished siblings on error.

    Args:
        coros (Iterable[Coroutine[Any, Any, _T]]): Episode coroutines to run.

    Returns:
        list[_T]: Ordered results when every coroutine succeeds.
    """
    tasks = [asyncio.create_task(coro) for coro in coros]
    try:
        return list(await asyncio.gather(*tasks))
    except BaseException:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


async def run_synthetic_rollout(
    task: MirageTask,
    servers: ServerPool,
    case: BenchCase,
    seed: int,
) -> tuple[bool, bool]:
    """Run one synthetic ``MirageOpenEnv`` episode against ``ServerPool``.

    Args:
        task (MirageTask): Harbor-compatible Mirage task to execute.
        servers (ServerPool): Shared pool of ``integ/server`` backends.
        case (BenchCase): Commands to execute and expected verifier reward.
        seed (int): Episode reset seed.

    Returns:
        tuple[bool, bool]: Whether reward matched ``case.expected_reward`` and
            whether ``/tests`` remained hidden under the default profile.
    """
    harness = OpenEnvHarness(
        task=task,
        servers=servers,
        max_steps=len(case.commands) + 2,
    )
    try:
        await harness.reset(seed=seed)
        peek = await harness.step_shell(f"cat {VERIFIER_SCRIPT_PATH}")
        tests_hidden = peek.exit_code != 0

        for cmd in case.commands:
            await harness.step_shell(cmd)

        reward = await harness.grade()
        return reward == case.expected_reward, tests_hidden
    finally:
        await harness.close()


async def run_bench(config: OpenEnvRunConfig) -> None:
    """Benchmark concurrent ``MirageOpenEnv`` + ``ServerPool`` rollouts.

    Args:
        config (OpenEnvRunConfig): Validated runtime configuration.
    """
    tasks = load_mirage_tasks(config.data_dir)
    if not tasks:
        raise RuntimeError(f"No tasks found in {config.data_dir / 'tasks'}")

    print(f"Loaded {len(tasks)} task(s): {[t.task_name for t in tasks]}")
    task = tasks[0]
    fixtures_path = task.task_dir / "tests" / "fixtures.json"
    fixtures = BenchFixtures.model_validate_json(fixtures_path.read_text())

    servers = ServerPool(
        fixture_root=config.data_dir / "fixtures",
        endpoints=config.endpoints,
    )
    try:
        t0 = time.perf_counter()
        outcomes = await _gather_cancelling(
            run_synthetic_rollout(
                task,
                servers,
                fixtures.passing if i % 2 == 0 else fixtures.failing,
                seed=i,
            )
            for i in range(config.rollouts)
        )
        elapsed = time.perf_counter() - t0
    finally:
        await servers.close()

    matched_count = sum(1 for matched, _ in outcomes if matched)
    all_hidden = all(hidden for _, hidden in outcomes)
    ms_per_rollout = (elapsed / config.rollouts) * 1000
    print(
        f"Completed {config.rollouts} concurrent OpenEnv rollouts in "
        f"{elapsed:.2f}s ({ms_per_rollout:.2f} ms/rollout) | "
        f"tests_hidden={all_hidden} | "
        f"matched={matched_count}/{config.rollouts}"
    )
    assert all_hidden
    assert matched_count == config.rollouts


async def run_eval_episode(
    client: AsyncOpenAI,
    sem: asyncio.Semaphore,
    config: OpenEnvRunConfig,
    task: MirageTask,
    servers: ServerPool,
    trial: int,
) -> EpisodeMetrics:
    """Evaluate one LLM episode inside ``MirageOpenEnv``.

    Args:
        client (AsyncOpenAI): OpenAI-compatible chat client.
        sem (asyncio.Semaphore): Concurrency gate bounding active episodes.
        config (OpenEnvRunConfig): Validated runtime configuration.
        task (MirageTask): Task to evaluate.
        servers (ServerPool): Shared pool of ``integ/server`` backends.
        trial (int): Zero-based trial index.

    Returns:
        EpisodeMetrics: Recorded reward, step count, refusals, and duration.
    """
    async with sem:
        harness = OpenEnvHarness(
            task=task,
            servers=servers,
            max_steps=config.max_steps,
            timeout_s=config.action_timeout_s,
        )
        t0 = time.perf_counter()
        steps = 0
        refusals = 0
        try:
            await harness.reset(seed=trial)
            system_prompt = await harness.build_system_prompt()
            messages: list[dict[str, Any]] = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": task.instruction},
            ]

            done = False
            while not done and steps < config.max_steps:
                resp = await client.chat.completions.create(
                    model=config.model,
                    messages=cast(Any, messages),
                    tools=cast(Any, [SHELL_TOOL_SCHEMA]),
                )

                choice = resp.choices[0].message
                messages.append(choice.model_dump(exclude_none=True))

                tool_calls = choice.tool_calls or []
                if not tool_calls:
                    break

                for tc in tool_calls:
                    fn = getattr(tc, "function", None)
                    if fn is None:
                        continue
                    try:
                        parsed = json.loads(fn.arguments or "{}")
                    except json.JSONDecodeError as exc:
                        logger.debug("Invalid tool arguments JSON: %s", exc)
                        parsed = {}
                    cmd = (
                        str(parsed.get("command", ""))
                        if isinstance(parsed, dict)
                        else ""
                    )
                    obs = await harness.step_shell(cmd)
                    steps += 1
                    if obs.refusal is not None:
                        refusals += 1
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": format_observation(obs),
                        }
                    )
                    if obs.done or steps >= config.max_steps:
                        done = True
                        break

            reward = await harness.grade()
            elapsed = time.perf_counter() - t0
            return EpisodeMetrics(
                task_name=task.task_name,
                trial=trial,
                reward=reward,
                steps=steps,
                refusals=refusals,
                elapsed_s=elapsed,
            )
        finally:
            await harness.close()


async def run_eval(config: OpenEnvRunConfig) -> None:
    """Evaluate an OpenAI-compatible model across MirageOpenEnv tasks.

    Args:
        config (OpenEnvRunConfig): Validated runtime configuration.
    """
    api_key = config.api_key or os.environ.get("OPENAI_API_KEY")
    if not api_key and not config.base_url:
        raise SystemExit(
            "OPENAI_API_KEY is not set. Set OPENAI_API_KEY (or "
            "--base-url for a local server) in .env.development."
        )
    _validate_eval_base_url(config.base_url, api_key)

    tasks = load_mirage_tasks(config.data_dir)
    if not tasks:
        raise RuntimeError(f"No tasks found in {config.data_dir / 'tasks'}")

    client = AsyncOpenAI(
        api_key=api_key or "local",
        base_url=config.base_url,
    )
    sem = asyncio.Semaphore(config.concurrency)
    servers = ServerPool(
        fixture_root=config.data_dir / "fixtures",
        endpoints=config.endpoints,
    )
    try:
        results = await _gather_cancelling(
            run_eval_episode(client, sem, config, task, servers, trial)
            for task in tasks
            for trial in range(config.trials)
        )
    finally:
        await servers.close()
        await client.close()

    for item in results:
        print(
            f"[{item.task_name} #{item.trial}] reward={item.reward:.1f} "
            f"steps={item.steps} refusals={item.refusals} "
            f"time={item.elapsed_s:.2f}s"
        )

    mean_reward = sum(r.reward for r in results) / len(results)
    mean_steps = sum(r.steps for r in results) / len(results)
    by_task: dict[str, list[EpisodeMetrics]] = {}
    for item in results:
        by_task.setdefault(item.task_name, []).append(item)
    pass_any = sum(
        1 for group in by_task.values() if any(r.reward > 0.0 for r in group)
    )
    print(
        f"Summary ({config.model}): "
        f"pass@{config.trials}={pass_any}/{len(by_task)} | "
        f"mean_reward={mean_reward:.3f} | mean_steps={mean_steps:.1f}"
    )
