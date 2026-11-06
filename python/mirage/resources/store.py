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
from dataclasses import asdict

from mirage.resources.base import ResourceStore
from mirage.resources.constants import (
    DELETED_TEMPLATES,
    ENTRY_KINDS,
    NAME,
    NOUN,
)
from mirage.resources.errors import ResourceError
from mirage.resources.types import (
    Entry,
    EntryInput,
    EntryKind,
    Fields,
    Policy,
    ResourceKind,
    ResourceRecords,
    RevealedEntry,
    Sealer,
    Template,
    TemplateInput,
)

POLICY: ResourceKind = "policy"
TEMPLATE: ResourceKind = "template"


def check_name(kind: ResourceKind, name: str) -> None:
    if NAME.fullmatch(name) is None:
        raise ResourceError(
            "invalid",
            f"{NOUN[kind]} name must be 1-63 of a-z 0-9 . _ -, "
            "starting with a letter or digit",
        )


def not_found(kind: ResourceKind, name: str) -> ResourceError:
    return ResourceError("not_found", f"no {NOUN[kind]} named {name}")


def malformed(kind: ResourceKind, name: str, field: str) -> ResourceError:
    return ResourceError("invalid", f"{NOUN[kind]} {name} has no {field}")


def string_of(
    kind: ResourceKind, name: str, record: Fields, field: str
) -> str:
    value = record.get(field)
    if not isinstance(value, str):
        raise malformed(kind, name, field)
    return value


def fields_of(
    kind: ResourceKind, name: str, record: Fields, field: str
) -> Fields:
    value = record.get(field)
    if not isinstance(value, dict):
        raise malformed(kind, name, field)
    return value


def template_of(name: str, record: Fields) -> Template:
    description = record.get("description")
    return Template(
        name=name,
        description=description
        if isinstance(description, str) and description
        else None,
        config=fields_of(TEMPLATE, name, record, "config"),
    )


class RecordResourceStore(ResourceStore):
    """The store's rules over two small backend parts: plain records and
    a sealer. Calls run one at a time, so an edit's read and write see no
    other call between them."""

    def __init__(
        self, scope: str, records: ResourceRecords, sealer: Sealer
    ) -> None:
        self.scope = scope
        self._records = records
        self._sealer = sealer
        self._lock = asyncio.Lock()

    async def _entry_record(self, kind: EntryKind, name: str) -> Fields:
        check_name(kind, name)
        record = await self._records.read(kind, name)
        if record is None:
            raise not_found(kind, name)
        return record

    async def _entry_of(self, kind: EntryKind, name: str) -> Entry:
        record = await self._entry_record(kind, name)
        return Entry(
            name=name,
            type=string_of(kind, name, record, "type"),
            fields=fields_of(kind, name, record, "fields"),
            sealed=sorted(await self._sealer.read(kind, name)),
        )

    async def _sorted_names(self, folder: str) -> list[str]:
        names = await self._records.names(folder)
        return sorted(n for n in names if NAME.fullmatch(n) is not None)

    async def list_entries(self, kind: EntryKind) -> list[Entry]:
        async with self._lock:
            return [
                await self._entry_of(kind, name)
                for name in await self._sorted_names(kind)
            ]

    async def get_entry(self, kind: EntryKind, name: str) -> Entry:
        async with self._lock:
            return await self._entry_of(kind, name)

    async def put_entry(self, kind: EntryKind, input: EntryInput) -> Entry:
        async with self._lock:
            check_name(kind, input.name)
            both = [
                key
                for key, value in input.sealed.items()
                if value is not None and key in input.fields
            ]
            if both:
                raise ResourceError(
                    "invalid", f"{both[0]} is given both plain and sealed"
                )
            for other in ENTRY_KINDS:
                if (
                    other != kind
                    and await self._records.read(other, input.name) is not None
                ):
                    raise ResourceError(
                        "conflict",
                        f"{input.name} is already a {NOUN[other]}",
                    )
            kept: Fields = {}
            if await self._records.read(kind, input.name) is not None:
                kept = await self._sealer.read(kind, input.name)
            sealed = {k: v for k, v in kept.items() if k not in input.fields}
            for key, value in input.sealed.items():
                if value is None:
                    sealed.pop(key, None)
                else:
                    sealed[key] = value
            await self._sealer.write(kind, input.name, sealed)
            record: Fields = {
                "name": input.name,
                "type": input.type,
                "fields": input.fields,
            }
            try:
                await self._records.write(kind, input.name, record)
            except BaseException:
                await self._sealer.write(kind, input.name, kept)
                raise
            return Entry(
                name=input.name,
                type=input.type,
                fields=input.fields,
                sealed=sorted(sealed),
            )

    async def delete_entry(self, kind: EntryKind, name: str) -> None:
        async with self._lock:
            await self._entry_record(kind, name)
            await self._sealer.wipe(kind, name)
            await self._records.remove(kind, name)

    async def reveal_entry(self, kind: EntryKind, name: str) -> RevealedEntry:
        async with self._lock:
            entry = await self._entry_of(kind, name)
            return RevealedEntry(
                name=entry.name,
                type=entry.type,
                fields=entry.fields,
                sealed=await self._sealer.read(kind, name),
            )

    async def _policy_of(self, name: str) -> Policy:
        check_name(POLICY, name)
        record = await self._records.read(POLICY, name)
        if record is None:
            raise not_found(POLICY, name)
        return Policy(
            name=name, source=string_of(POLICY, name, record, "source")
        )

    async def list_policies(self) -> list[Policy]:
        async with self._lock:
            return [
                await self._policy_of(name)
                for name in await self._sorted_names(POLICY)
            ]

    async def get_policy(self, name: str) -> Policy:
        async with self._lock:
            return await self._policy_of(name)

    async def put_policy(self, policy: Policy) -> Policy:
        async with self._lock:
            check_name(POLICY, policy.name)
            await self._records.write(
                POLICY,
                policy.name,
                {"name": policy.name, "source": policy.source},
            )
            return Policy(name=policy.name, source=policy.source)

    async def delete_policy(self, name: str) -> None:
        async with self._lock:
            check_name(POLICY, name)
            if not await self._records.remove(POLICY, name):
                raise not_found(POLICY, name)

    async def _template_in(self, folder: str, name: str) -> Template | None:
        check_name(TEMPLATE, name)
        record = await self._records.read(folder, name)
        return None if record is None else template_of(name, record)

    async def _live_template(self, name: str) -> Template:
        template = await self._template_in(TEMPLATE, name)
        if template is None:
            raise not_found(TEMPLATE, name)
        return template

    async def list_templates(self) -> list[Template]:
        async with self._lock:
            return [
                await self._live_template(name)
                for name in await self._sorted_names(TEMPLATE)
            ]

    async def get_template(self, name: str) -> Template:
        async with self._lock:
            return await self._live_template(name)

    async def put_template(self, template: TemplateInput) -> Template:
        async with self._lock:
            check_name(TEMPLATE, template.name)
            saved = Template(
                name=template.name,
                description=template.description or None,
                config=template.config,
            )
            await self._records.write(TEMPLATE, saved.name, asdict(saved))
            return saved

    async def delete_template(self, name: str) -> None:
        async with self._lock:
            template = await self._live_template(name)
            await self._records.write(
                DELETED_TEMPLATES, name, asdict(template)
            )
            await self._records.remove(TEMPLATE, name)

    async def restore_template(self, name: str) -> Template:
        async with self._lock:
            template = await self._template_in(DELETED_TEMPLATES, name)
            if template is None:
                raise ResourceError(
                    "not_found", f"no deleted template named {name}"
                )
            if await self._records.read(TEMPLATE, name) is not None:
                raise ResourceError(
                    "conflict", f"a template named {name} exists again"
                )
            await self._records.write(TEMPLATE, name, asdict(template))
            await self._records.remove(DELETED_TEMPLATES, name)
            return template
