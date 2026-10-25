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


from mirage.policy.types import AdmissionRules, CommandContext
from mirage.rs.policy import admission_matcher, units


def head_allowed(name: str, rules: AdmissionRules | None) -> bool:
    return admission_matcher(rules).head_allowed(units(name))


def line_tokens(ctx: CommandContext) -> tuple[str, ...]:
    return ctx.tokens or (ctx.command, *ctx.argv)


def line_allowed(ctx: CommandContext, rules: AdmissionRules | None) -> bool:
    return admission_matcher(rules).line_allowed(
        tuple(units(v) for v in line_tokens(ctx)), ctx.tool
    )
