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

AMBIGUOUS_NAMES = {"l": "args_l", "O": "args_O", "I": "args_I", "1": "args_1"}

# Numeric shorthand token like `-5` (head/tail count), never a flag
# cluster or a path.
NUMERIC_SHORT = re.compile(r"^-\d+$")


def flag_kwarg_name(flag: str) -> str:
    """Map a flag name to its dispatcher kwarg name.

    Args:
        flag (str): flag name with or without leading dashes.
    """
    clean = flag.lstrip("-").replace("-", "_")
    return AMBIGUOUS_NAMES.get(clean, clean)
