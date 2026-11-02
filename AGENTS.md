# AGENTS.md

## UI surfaces

The main background of pi-ui is dynamic and changing, so plain text placed
directly on it is not reliably readable. Every UI element must carry its own
card with a solid or blurred background until a task explicitly says otherwise.

## Tool schemas

Tool parameter schemas must serialise to the provider-safe subset: `Type.Tuple`, `Type.Intersect`
and `Type.Record` with a pattern key are known offenders; `Type.Array(…, {minItems, maxItems})`
and `Type.Object` are safe.
