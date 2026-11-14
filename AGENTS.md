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

## One chat core

A conversation is one core, not one component per surface. Transcript rows, scroll restore, the
optimistic/queued/steer reconciliation and the run-status line (including `WorkingIndicator`, the
braille spinner) come from `src/client/use-chat.ts` and `ChatView`. A second state machine for the
same domain — a new `use-something-chat` hook, a fresh scroller with its own scroll rule, a status
line built again — is a review blocker, not a shortcut: the plan chat grew that way in `f620ca6`
and lost scroll restore, the steer/queue revision guard and the working indicator one release at a
time. Plan or product surfaces differ by tool set and system prompt, never by renderer.

## Browser e2e

E2E is for journeys a unit test structurally cannot reach. Geometry, frame-budget and screenshot
assertions belong in the unit gate or in manual review, not in the browser suite. A new spec must
displace one of the core files — the 420 s guard is the ceiling, not a target.
