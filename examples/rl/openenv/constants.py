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

import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
INTEG_DIR = REPO_ROOT / "integ"
DEFAULT_DATA_DIR = HERE / "data"
DEFAULT_FIXTURE = "v1"

DEFAULT_EVAL_MODEL = "gpt-5-mini"

DEFAULT_PROFILE = "default"
VERIFIER_PROFILE = "_verifier"
VERIFIER_SESSION_ID = "_verifier"
ANNOUNCE_RE = re.compile(r"^([A-Z0-9_]+_URL)=(.+)$")
HEALTH_PATH = "/_kit/health"
RESET_PATH = "/reset"
RUN_PATH_PREFIX = "_run"
VERIFIER_SCRIPT_PATH = "/tests/test.sh"
VERIFIER_REWARD_PATH = "/logs/verifier/reward.txt"

DEFAULT_SERVER_START_TIMEOUT = 30.0
DEFAULT_HEALTH_POLL_INTERVAL = 0.2
DEFAULT_ACTION_TIMEOUT = 60.0
DEFAULT_MAX_STEPS = 8
DEFAULT_TEMPERATURE = 0.0
DEFAULT_TRIALS = 1
DEFAULT_CONCURRENCY = 4
DEFAULT_BENCH_ROLLOUTS = 50

SYSTEM_PROMPT = (
    "You are a software and operations engineer working inside a Mirage "
    "virtual terminal. Use the `shell` tool to inspect mounted services "
    "and files, run pipelines, and verify your output."
)
