# Biome overrides

`biome.json` turns off six rules for named files. The repository bans comments, so a file-wide
override is the narrowest suppression left: `biome-ignore` comments are rejected by
`npm run check:comments`. Every override is load-bearing; removing any one of them makes
`biome check .` fail on the current tree.

`docs/biome-overrides-baseline.json` records every diagnostic that removing the overrides exposes,
and `npm run check:overrides` (part of `npm run lint`) reruns Biome with `overrides` set to an empty
list and compares the result with that baseline. The tradeoff is bounded rather than hidden:

- A new violation in a listed file adds a diagnostic the baseline does not record, so the gate
  fails even though the rule is off for that file.
- A fixed violation removes a recorded diagnostic, so the gate fails until the entry is deleted
  and the now-redundant override is removed with it.
- The baseline is the review surface. Never widen an override or record a diagnostic without
  explaining it on this page.

The baseline currently holds 29 distinct diagnostics reported 36 times, all inside the files below.
Audit with `npm run check:overrides`; a copy of `biome.json` outside the checkout is not a valid
probe, because `files.includes`, `overrides` and the plugin path all resolve relative to the config
file, so the copy scans no repository source. Keep every override scoped to the files below and
revisit it when they change.

## `a11y/useKeyWithClickEvents`

Files: `ChatView.tsx`, `DiagramViewer.tsx`, `MediaViewer.tsx`, `NoticeView.tsx`, `PageSheet.tsx`,
`ProjectSuggestions.tsx`, `RunErrorHeader.tsx`.

Each site is either a `<dialog>` opened by a click and dismissed by the dialog's own `cancel` event,
or the project suggestion row whose focus stays in the composer and is addressed through
`aria-activedescendant`. A keyboard handler on those elements would either duplicate the
`<dialog>` behaviour or move focus out of the composer, so fixing the rule changes interaction.

## `a11y/useFocusableInteractive`

File: `ProjectSuggestions.tsx`.

The suggestion row is focused indirectly from the composer through `aria-activedescendant`, not by a
separate tab stop. Making the row focusable adds a second tab stop and changes the keyboard model.

## `a11y/useSemanticElements`

Files: `TaskDetailVariants.tsx`, `TasksView.tsx`.

The task body keeps markdown descendants instead of becoming a fieldset, and the card is a row of
block content whose title may hold inline markdown links. Both replacements replace the rendered
tree, so the rule cannot be satisfied without changing what the reader sees.

## `security/noDangerouslySetInnerHtml`

Files: `DiagramViewer.tsx`, `lazy-diagram.tsx`.

Pele renders the diagram markup, escapes its text, and filters links and styles before that HTML
reaches the DOM. Injecting it through a ref effect instead renders one frame later, which changes
how the viewer settles after a revision.

## `suspicious/noArrayIndexKey`

Files: `NoticeView.tsx`, `StatsView.tsx`, `markdown.tsx`.

Recorded notices never change, Markdown tokens have no ids and their order is their identity, stats
rows have no identity, and stats cells follow their columns. Each list is append-only or static, so
the index is the identity; inventing another key changes reconciliation for no gain.

## `correctness/useExhaustiveDependencies`

Files: `ChatView.tsx`, `DiagramViewer.tsx`, `StatsView.tsx`, `TasksView.tsx`,
`use-stick-to-bottom.ts`.

Each site deliberately keeps a different dependency list than the rule infers:

- `ChatView.tsx`: the composer value drives the autosize and caret reset, and the page changes the
  scroll reset.
- `DiagramViewer.tsx`: the stage and drawing change the reset.
- `StatsView.tsx`: relabel the grid-layout handles after every layout render while the grid node
  itself stays stable.
- `TasksView.tsx`: the open task changes the detail reset; the draft changes the height being
  measured; `bodyDraft`, `wide` and `bodyError` change the editor height.
- `use-stick-to-bottom.ts`: the dependency is only the trigger for a post-commit sync.

Adding or removing a dependency here re-runs or skips a reset, so the rule's fix is a behaviour
change rather than a lint cleanup.
