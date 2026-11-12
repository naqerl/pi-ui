# AGENTS.md

## UI surfaces

The main background of pi-ui is dynamic and changing, so plain text placed
directly on it is not reliably readable. Every UI element must carry its own
card with a solid or blurred background until a task explicitly says otherwise.

## Interaction

Every interactive control gets the global press feedback from `index.css`: it
compresses on pointer-down and eases back on release. Do not disable it in a
component unless the control owns its own pointer gesture; in that case add
`data-no-press` and a comment explaining why. Reduced motion must always be
honoured.

## Tool schemas

Tool parameter schemas must serialise to the provider-safe subset: `Type.Tuple`, `Type.Intersect`
and `Type.Record` with a pattern key are known offenders; `Type.Array(…, {minItems, maxItems})`
and `Type.Object` are safe.

## Scroll

A page switch is a navigation, not a content change — restore the reader's position before paint.
