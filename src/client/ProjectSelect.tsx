import { useState } from "react";
import { normalizeProject, PROJECT_MAX_LENGTH, sameProject } from "../shared/project";
import { Input } from "./components/ui/input";
import { NativeSelect } from "./components/ui/native-select";

const NONE = "";
const NEW = "__new__";

/** A project picker: "No project", every known project, and "New project…" to type one. */
export function ProjectSelect({
  value,
  projects,
  onChange,
  label,
  testId,
  className,
}: {
  value: string | null;
  projects: readonly string[];
  onChange: (project: string | null) => void;
  label: string;
  testId?: string;
  className?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const options =
    value !== null && !projects.some((name) => sameProject(name, value))
      ? [...projects, value].sort((a, b) => a.localeCompare(b))
      : projects;

  if (creating) {
    const valid = normalizeProject(draft);
    const finish = (save: boolean) => {
      setCreating(false);
      setDraft("");
      if (save && valid !== null) onChange(valid);
    };
    return (
      <Input
        autoFocus
        aria-label={`${label}: new project name`}
        data-testid={testId === undefined ? undefined : `${testId}-new`}
        placeholder="Project name"
        maxLength={PROJECT_MAX_LENGTH}
        value={draft}
        aria-invalid={draft.length > 0 && valid === null ? true : undefined}
        className={className ?? "w-40"}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }}
      />
    );
  }

  return (
    <NativeSelect
      aria-label={label}
      data-testid={testId}
      className={className}
      value={value ?? NONE}
      onChange={(event) => {
        const next = event.target.value;
        if (next === NEW) {
          setCreating(true);
          return;
        }
        onChange(next === NONE ? null : next);
      }}
    >
      <option value={NONE}>No project</option>
      {options.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
      <option value={NEW}>New project…</option>
    </NativeSelect>
  );
}
