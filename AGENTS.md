# AGENTS.md

## UI surfaces

The main background of pi-ui is dynamic and changing, so plain text placed
directly on it is not reliably readable. Every UI element must carry its own
card with a solid or blurred background until a task explicitly says otherwise.

## Interaction

Every interactive control gets the global press feedback from `index.css`: it
compresses on pointer-down and eases back on release. Disable it with
`data-no-press` only when the control owns its own pointer gesture. Reduced
motion must always be honoured.

## Comments

The repository contains no comments in code or configuration. When intent is
not clear from the code, rename or restructure until it is. `npm run comments`
runs in lint and build and rejects every comment that comes back.

## Spacing

Every padding/margin/gap uses one of six tokens: `xs`, `sm`, `md`, `lg`, `xl`,
`2xl`; `0` and `auto` stay legal. The scale and its rationale are in
`docs/spacing.md`. `biome-plugins/spacing.grit` fails the build on anything
else, so a seventh step is a design decision that has to start in that doc.

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

## Credentials are masked by the gateway

Every credential that leaves a tool result is replaced at the gateway with a placeholder of the form
`{{KIND_xxxxxxxx}}` before it reaches the agent, and restored to its real value before any tool runs.
This is why the workspace is safe to work in: printing a token from `.env`, `sops -d`, or `kubectl get
secret` returns the placeholder, not the secret, and an agent that needs to _use_ the secret can still
write the placeholder in a command and have it resolved.

Two consequences for anything written down here:

- **Share credentials through placeholders.** When a key is needed in a prompt, a task body, a doc or
  a commit message, write `{{KIND_xxxxxxxx}}` as it appears in context — never retype a value that was
  resolved, and never ask the operator to paste a secret into the chat when a placeholder already
  exists.
- **A placeholder is not a redaction you can plan around.** It is per-consumer and per-run; it will
  not work in another session, in a file read by CI, or in a commit that leaves this machine. If a
  secret genuinely has to live in a repo, it goes through SOPS.
