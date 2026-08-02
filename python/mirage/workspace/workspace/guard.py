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


def reject_config_script(kind: str, value: object) -> None:
    """Guard the code API: script source strings belong to config.

    In code, scripts and policies are callables; a plain string is
    almost always a script that should live next to the workspace
    yaml and be referenced there (``script:`` on an entry, ``policy:``
    on the workspace), where the loader wraps it as ScriptSource.

    Args:
        kind (str): what carried the string, for the error message.
        value (object): the suspect script value.

    Raises:
        TypeError: the value is a plain string.
    """
    if isinstance(value, str):
        raise TypeError(
            f"{kind} must be a callable taking the PolicyContext; config "
            f"scripts reference a .py file (script:/policy: in the "
            f"workspace yaml)")
