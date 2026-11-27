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

import argparse
import asyncio
import os
from pathlib import Path

from config import OpenEnvRunConfig
from constants import (
    DEFAULT_BENCH_ROLLOUTS,
    DEFAULT_CONCURRENCY,
    DEFAULT_DATA_DIR,
    DEFAULT_EVAL_MODEL,
    DEFAULT_MAX_STEPS,
    DEFAULT_TEMPERATURE,
    DEFAULT_TRIALS,
    HERE,
)
from dotenv import load_dotenv
from runners import run_bench, run_eval


def _parse_endpoints(entries: list[str]) -> dict[str, str]:
    endpoints: dict[str, str] = {}
    for entry in entries:
        if "=" not in entry:
            raise ValueError(
                f"Invalid --endpoint {entry!r}; expected service=http://..."
            )
        service, url = entry.split("=", 1)
        endpoints[service.strip()] = url.strip()
    return endpoints


def parse_config() -> OpenEnvRunConfig:
    """Parse CLI arguments into a validated OpenEnvRunConfig.

    Returns:
        OpenEnvRunConfig: Validated configuration for the selected mode.
    """
    load_dotenv(HERE / ".env.development")

    parser = argparse.ArgumentParser(
        description="MirageOpenEnv benchmark and evaluation harness."
    )
    parser.add_argument(
        "--mode",
        choices=["bench", "eval"],
        default="bench",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=DEFAULT_DATA_DIR,
    )
    parser.add_argument(
        "--endpoint",
        action="append",
        default=[],
        help="Optional pre-running backend origin as service=http://host:port",
    )
    parser.add_argument("--rollouts", type=int, default=DEFAULT_BENCH_ROLLOUTS)
    parser.add_argument(
        "--model", default=os.getenv("OPENAI_MODEL") or DEFAULT_EVAL_MODEL
    )
    parser.add_argument(
        "--base-url", default=os.getenv("OPENAI_BASE_URL") or None
    )
    parser.add_argument("--trials", type=int, default=DEFAULT_TRIALS)
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY)
    parser.add_argument("--max-steps", type=int, default=DEFAULT_MAX_STEPS)
    parser.add_argument(
        "--temperature", type=float, default=DEFAULT_TEMPERATURE
    )
    args = parser.parse_args()
    return OpenEnvRunConfig(
        mode=args.mode,
        data_dir=args.data_dir,
        endpoints=_parse_endpoints(args.endpoint),
        rollouts=args.rollouts,
        model=args.model,
        base_url=args.base_url,
        api_key=os.getenv("OPENAI_API_KEY") or None,
        trials=args.trials,
        concurrency=args.concurrency,
        max_steps=args.max_steps,
        temperature=args.temperature,
    )


async def run(config: OpenEnvRunConfig) -> None:
    """Dispatch the selected execution mode.

    Args:
        config (OpenEnvRunConfig): Validated runtime configuration.
    """
    if config.mode == "bench":
        await run_bench(config)
    elif config.mode == "eval":
        await run_eval(config)


if __name__ == "__main__":
    asyncio.run(run(parse_config()))
