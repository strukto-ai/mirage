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


from mirage.policy.types import AdmissionRules
from mirage.rs.policy import admission, units


def has_rules(rules: AdmissionRules | None) -> bool:
    return admission(rules).has_rules()


def reads_args(rules: AdmissionRules | None, name: str) -> bool:
    return admission(rules).reads_args(units(name))


def scopes_paths(rules: AdmissionRules | None, name: str) -> bool:
    return admission(rules).scopes_paths(units(name))
