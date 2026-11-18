# Spacing

pi-ui has one spacing scale. Every padding, margin, gap and space-between
utility in `src/client` uses one of six named tokens, and a Biome plugin fails
the build on anything else. The scale lives in the `@theme inline` block in
`src/client/index.css`; this page is the reason and the rule.

## The six tokens

| Token | Value      | px  | Used for                             |
| ----- | ---------- | --- | ------------------------------------ |
| `xs`  | `0.125rem` | 2   | tightest inset, pills and mono chips |
| `sm`  | `0.25rem`  | 4   | row rhythm for dense lists           |
| `md`  | `0.375rem` | 6   | icon-to-label, chip internals        |
| `lg`  | `0.5rem`   | 8   | default gap between siblings         |
| `xl`  | `0.75rem`  | 12  | control padding, card gutters        |
| `2xl` | `1rem`     | 16  | section padding, card edges          |

`0` is not a step on the scale: it is the absence of a gap and stays legal
(`p-0`, `mt-0`). `auto` stays legal as layout (`mx-auto`, `ml-auto`). A seventh
step is a design decision, not a local fix, and it belongs on this page first.

## Mapping rule

The sweep snapped each old numeric utility to the nearest token. A tie takes
the larger step.

| Before | After | px  |
| ------ | ----- | --- |
| `0.5`  | `xs`  | 2   |
| `1`    | `sm`  | 4   |
| `1.5`  | `md`  | 6   |
| `2`    | `lg`  | 8   |
| `2.5`  | `xl`  | 12  |
| `3`    | `xl`  | 12  |
| `4`    | `2xl` | 16  |
| `5`    | `2xl` | 16  |
| `6`    | `2xl` | 16  |
| `8`    | `2xl` | 16  |
| `px`   | `xs`  | 2   |

Negative margins use the same table and keep their sign: `-ml-3` became
`-ml-xl`, `-mb-0.5` became `-mb-xs`. Tailwind resolves `p-lg` through
`--spacing-lg`; the numeric steps (`p-2`, `p-3`) still exist in Tailwind's base
theme, but the lint rule below retires them in this app.

## Sites that were a reservation, not rhythm

Six utilities used spacing to clear an absolutely-positioned control. Snapping
the number would have dropped text under the control, so the reservation was
removed instead:

- `src/client/markdown.tsx` code blocks no longer reserve `pr-14` for the copy
  button. The copy button is a real flex sibling of the `<pre>`; the `<pre>`
  keeps `min-w-0` and scrolls its own code.
- `src/client/SectionBar.tsx` no longer reserves `pr-20` when actions exist. The
  bar is a `justify-between` row and the actions are a normal flex child.
- `src/client/components/ui/dropdown-menu.tsx` drops the unused `inset` prop
  instead of keeping a 32px reservation with no icon child to justify it.
- `src/client/ActivityView.tsx` nested disclosure rows use `px-xl py-xl pl-2xl`.
  `pl-*` stays after `px-*` so `tailwind-merge` keeps the indent.
- `src/client/ChatView.tsx` status row uses `pl-2xl` for the plus icon's ink.
- `src/client/BackgroundJobs.tsx` used to move the jobs chip with `-ml-xl` and
  `pl-xl` so its ink lined up with the composer plus button. The counts now sit
  after the status word, so the reservation is gone and the chip is a plain
  flex sibling with `gap-md`.

## Device insets

`env(safe-area-inset-*)` is device geometry, not a design gap, so it never
appears in a component's class list. `src/client/index.css` owns the named
classes:

- `.safe-bottom` applies the bottom home-indicator inset.
- `.safe-bottom` and `pb-xl` together add the jobs sheet's 12px gutter to that
  inset, through `.safe-bottom.pb-xl`.

The safe-area blocker, the composer dock and the activity screen keep their
existing geometry rules in the same stylesheet.

## Enforcement

`biome-plugins/spacing.grit` is registered in `biome.json` under `plugins`, with
`includes: ["src/client/**"]` so test fixtures and identifiers elsewhere cannot
trip it. It matches string literals, template chunks and JSX attribute values
whose text contains a spacing utility with a numeric, `px`, bracketed or
parenthesised value. A diagnostic names the file and the offending literal, for
example:

```text
src/client/Example.tsx:12:20 plugin ━━━━━━━━━━━━━━━━━━
  × Spacing must use one of the six tokens: xs, sm, md, lg, xl, 2xl (0 and auto stay legal).
```

To see it, add a class such as `p-5` to a `className`, `cva` string or
`cn(...)` argument and run `npm run lint`. Remove it and the diagnostic goes
away. The rule deliberately accepts `p-0`, `mx-auto`, `gap-lg`, `px-xl` and
`p-2xl`.

Biome's GritQL regex engine cannot compile a negative lookbehind, so the plugin
matches the character before a class name instead (any non-name character) and
consumes the delimiter after the value. That is what lets it accept `2xl`
without also flagging the `2` as a numeric step. JSX values need the at-start
and later-in-list cases as separate patterns, because a quoted `className`
cannot use the same leading-character fallback as a normal string. A plain
`grep -E '-(...)-[0-9.]+'` will report the `2` in `2xl`; the plugin does not.

## Why not a 4/8/12/16/24/32 scale?

The UI is mostly mono-chrome chrome: 11px labels, chips, the composer status row
and the jobs counter. Those need 2px and 6px steps to stay visually tied to
their 11px text. A 4/8/12/16/24/32 scale loses both, and 24px and 32px are not
used anywhere in the current surfaces. The six steps cover the real rhythm at
the tight end, where the app actually lives.
