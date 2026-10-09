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


class ReadonlyVariableError(Exception):
    """A write to a name ``readonly`` has marked.

    Raised by the session view so every writer refuses the same way;
    each builtin catches it and renders its own bash wording. Its
    message is bash's plain refusal, which a line that does not catch it
    reports as it ends (``declare -i n; n='R=3'``).
    """

    def __init__(self, name: str) -> None:
        super().__init__(f"bash: {name}: readonly variable")
        self.name = name
