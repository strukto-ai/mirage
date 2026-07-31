# Command Spec Exports

One JSON file per builtin command per implementation, dumped from the live
registries. `python/general` is the Python surface; `typescript/node` and
`typescript/browser` are the two TypeScript package pairings (`core` + `node`,
`core` + `browser`).

Each file carries the parsed spec (description, epilog, options, positional
operands, rest operand, ignored tokens) plus a `_meta` block recording which
resources register the command and whether any registration carries a
provision, an aggregate, or the write flag.

```bash
# Regenerate
./python/.venv/bin/python scripts/gen_specs.py
node --experimental-strip-types typescript/scripts/gen-specs.ts

# Compare the two implementations
./python/.venv/bin/python scripts/check_spec_parity.py
```

## The two CI gates

`Spec drift` regenerates both trees and fails if the committed JSON moved,
so the checked-in surface always matches the code.

`Spec parity` runs `scripts/check_spec_parity.py`, which diffs Python against
TypeScript command by command: every option (including its help text, value
kind, repeatability and shorthand form), every operand, the `_meta` flags, and
the resource set each command registers under. Resources are compared against
the union of the `node` and `browser` variants, since Python has no
runtime split.

Divergences that are structural rather than bugs live in
`parity_exceptions.json`:

- `resource_expansions` — one implementation registers a command once for a
  name that stands for several resource kinds. Python's HF commands declare
  `hf_buckets` and the datasets/models/spaces resources rebind them at
  construction, where TypeScript names all four up front.
- `language_only_resources` — a backend that exists in only one runtime, such
  as the browser's OPFS.
- `commands` — per-command field exemptions.

The checker also fails on a *stale* exception, so an entry cannot outlive the
divergence it documents.

## Keeping the dump complete

`gen-specs.ts` can only see command groups the package index re-exports, so it
asserts that every `*_COMMANDS` declared by a builtin command module is
reachable. A backend that defines commands but forgets the re-export used to
drop out of the dump silently; now generation fails.
