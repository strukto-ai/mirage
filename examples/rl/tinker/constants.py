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

from pathlib import Path

HERE = Path(__file__).resolve().parent

DEFAULT_TINKER_MODEL = "thinkingmachines/Inkling-2-Mini:peft:65536:free"

DEFAULT_MAX_TURNS = 8
DEFAULT_MAX_TRAJECTORY_TOKENS = 32 * 1024
DEFAULT_MAX_GENERATION_TOKENS = 4096
DEFAULT_LORA_RANK = 32
DEFAULT_LEARNING_RATE = 1e-5
DEFAULT_TEMPERATURE = 1.0
DEFAULT_GROUP_SIZE = 4
DEFAULT_MAX_STEPS = 2

RECIPE_NAME = "mirage_rl"
