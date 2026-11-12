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


from abc import ABC, abstractmethod

from mirage.resources.types import (
    Entry,
    EntryInput,
    EntryKind,
    Policy,
    RevealedEntry,
    Template,
    TemplateInput,
)


class ResourceStore(ABC):
    """One scope's saved configs: vfs, cli, runtime and store entries,
    policies and templates. Every backend answers the same way: lists
    sort by name, an entry's sealed values leave only through
    ``reveal_entry`` and deleting an entry wipes them. A missing name
    raises ``ResourceError("not_found")``.
    """

    scope: str

    @abstractmethod
    async def list_entries(self, kind: EntryKind) -> list[Entry]: ...

    @abstractmethod
    async def get_entry(self, kind: EntryKind, name: str) -> Entry: ...

    @abstractmethod
    async def create_entry(self, kind: EntryKind, input: EntryInput) -> Entry:
        """Save a new entry. Its name is unique across the entry kinds.

        Args:
            kind (EntryKind): the entry's kind.
            input (EntryInput): the entry to save.

        Raises:
            ResourceError: ``conflict`` when any entry has the name.
        """

    @abstractmethod
    async def update_entry(self, kind: EntryKind, input: EntryInput) -> Entry:
        """Replace an entry, keeping a sealed value the input leaves out
        and removing one it gives as None.

        Args:
            kind (EntryKind): the entry's kind.
            input (EntryInput): the entry's new fields.

        Raises:
            ResourceError: ``not_found`` when it does not exist.
        """

    @abstractmethod
    async def delete_entry(self, kind: EntryKind, name: str) -> None:
        """Delete an entry and wipe its sealed values.

        Args:
            kind (EntryKind): the entry's kind.
            name (str): its name.

        Raises:
            ResourceError: ``conflict`` while a saved template names it.
        """

    @abstractmethod
    async def reveal_entry(
        self, kind: EntryKind, name: str
    ) -> RevealedEntry: ...

    @abstractmethod
    async def list_policies(self) -> list[Policy]: ...

    @abstractmethod
    async def get_policy(self, name: str) -> Policy: ...

    @abstractmethod
    async def create_policy(self, policy: Policy) -> Policy:
        """Save a new policy.

        Args:
            policy (Policy): the policy to save.

        Raises:
            ResourceError: ``conflict`` when one has the name.
        """

    @abstractmethod
    async def update_policy(self, policy: Policy) -> Policy:
        """Replace a policy's source.

        Args:
            policy (Policy): the policy's name and new source.

        Raises:
            ResourceError: ``not_found`` when it does not exist.
        """

    @abstractmethod
    async def delete_policy(self, name: str) -> None: ...

    @abstractmethod
    async def list_templates(self) -> list[Template]: ...

    @abstractmethod
    async def get_template(self, name: str) -> Template: ...

    @abstractmethod
    async def create_template(self, template: TemplateInput) -> Template:
        """Save a new template.

        Args:
            template (TemplateInput): the template to save.

        Raises:
            ResourceError: ``conflict`` when a live one has the name.
        """

    @abstractmethod
    async def put_template(self, template: TemplateInput) -> Template: ...

    @abstractmethod
    async def delete_template(self, name: str) -> None: ...
