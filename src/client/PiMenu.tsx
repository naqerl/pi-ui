import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ModelList,
  ModelOption,
  OmarchyTheme,
  OmarchyThemes,
  StreamTheme,
} from "../shared/types";
import { applyTheme } from "./theme";

/** Earlier builds kept the choice here. One load copies it to the server, then drops it. */
const LEGACY_THEME_KEY = "pi-ui:theme";

function legacySlug(): string | null {
  try {
    const value = localStorage.getItem(LEGACY_THEME_KEY);
    return value !== null && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function clearLegacy(): void {
  try {
    localStorage.removeItem(LEGACY_THEME_KEY);
  } catch {
    // The server copy is what the next document paints.
  }
}

function persistTheme(slug: string): void {
  void fetch("/api/theme", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  }).catch(() => {
    // This page already shows the choice. The next load uses the last slug that saved.
  });
}

export function PiMenu() {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<"menu" | "theme" | "model">("menu");
  const [themes, setThemes] = useState<OmarchyTheme[]>([]);
  const [systemSlug, setSystemSlug] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [model, setModel] = useState<ModelOption | null>(null);
  const [anchor, setAnchor] = useState<{
    top: number;
    left: number;
    above: boolean;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    let cancelled = false;
    const legacy = legacySlug();
    clearLegacy();
    void fetch("/api/themes", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as OmarchyThemes;
      })
      .then((data) => {
        if (cancelled || data === null) return;
        setThemes(data.themes);
        setSystemSlug(data.current);
        let slug = data.selected ?? null;
        if (slug === null && legacy !== null && data.themes.some((item) => item.slug === legacy)) {
          slug = legacy;
          persistTheme(legacy);
        }
        setSelected(slug);
        const theme =
          data.themes.find((item) => item.slug === slug) ??
          data.themes.find((item) => item.slug === data.current);
        if (theme !== undefined) applyTheme(theme.colors);
      })
      .catch(() => {
        // The document already carries the server theme, or the built-in colors.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/models", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as ModelList;
      })
      .then((data) => {
        if (cancelled || data === null) return;
        setModels(data.models);
        setModel(data.current);
        setModelsLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setModelsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onTheme = (event: Event) => {
      const detail = (event as CustomEvent<StreamTheme>).detail;
      if (detail?.colors === undefined || detail.slug.length === 0) return;
      setSelected(detail.slug);
      applyTheme(detail.colors);
    };
    const onModel = (event: Event) => {
      const detail = (event as CustomEvent<ModelOption>).detail;
      if (detail?.provider === undefined || detail.id.length === 0) return;
      setModel(detail);
    };
    window.addEventListener("pi-theme", onTheme);
    window.addEventListener("pi-model", onModel);
    return () => {
      window.removeEventListener("pi-theme", onTheme);
      window.removeEventListener("pi-model", onModel);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      // The gear lives in the bottom dock, so the menu opens upward when there is no room below.
      const gap = 4;
      const above = rect.top > window.innerHeight - rect.bottom;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - 296));
      setAnchor({ top: above ? rect.top - gap : rect.bottom + gap, left, above });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const menu = document.getElementById(menuId);
      const button = document.querySelector("[data-pi-menu]");
      if (menu?.contains(target) || button?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [menuId, open]);

  const choose = (theme: OmarchyTheme) => {
    setSelected(theme.slug);
    applyTheme(theme.colors);
    persistTheme(theme.slug);
  };

  const chooseModel = (option: ModelOption) => {
    const previous = model;
    setModel(option);
    void fetch("/api/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: option.provider, id: option.id }),
    })
      .then(async (response) => {
        if (!response.ok) {
          setModel(previous);
          return;
        }
        setModel((await response.json()) as ModelOption);
      })
      .catch(() => {
        setModel(previous);
      });
  };

  const active = selected ?? systemSlug;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-pi-menu=""
        aria-label="Settings"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className="grid size-7 shrink-0 place-items-center border border-foreground/30 bg-surface text-foreground theme-radius hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        onClick={() => {
          setSection("menu");
          setOpen((current) => !current);
        }}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      {open &&
        anchor !== null &&
        createPortal(
          <div
            id={menuId}
            role="menu"
            className={
              section === "model"
                ? "ink-line theme-radius fixed z-40 w-72 border bg-surface text-foreground"
                : "ink-line theme-radius fixed z-40 w-56 border bg-surface text-foreground"
            }
            style={{
              top: anchor.top,
              left: anchor.left,
              transform: anchor.above ? "translateY(-100%)" : undefined,
            }}
          >
            {section === "menu" ? (
              <div>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => setSection("theme")}
                >
                  <span>Theme</span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {themes.find((theme) => theme.slug === active)?.name ?? "Default"}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => setSection("model")}
                >
                  <span>Model</span>
                  <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                    {model?.id ?? "None"}
                  </span>
                </button>
              </div>
            ) : section === "theme" ? (
              <div>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setSection("menu")}
                >
                  <span aria-hidden="true">◂</span>
                  Theme
                </button>
                <div className="max-h-64 overflow-y-auto">
                  {themes.length === 0 && (
                    <p className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                      No Omarchy themes found.
                    </p>
                  )}
                  {themes.map((theme) => {
                    const current = theme.slug === active;
                    return (
                      <button
                        key={theme.slug}
                        type="button"
                        role="menuitemradio"
                        aria-checked={current}
                        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-muted"
                        onClick={() => choose(theme)}
                      >
                        <span>{theme.name}</span>
                        {current && (
                          <span aria-hidden="true" className="font-mono text-[11px]">
                            ●
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setSection("menu")}
                >
                  <span aria-hidden="true">◂</span>
                  Model
                </button>
                <div className="max-h-64 overflow-y-auto">
                  {modelsLoaded && models.length === 0 && (
                    <p className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                      No models available.
                    </p>
                  )}
                  {models.map((option, index) => {
                    const current = option.provider === model?.provider && option.id === model.id;
                    const showProvider =
                      index === 0 || models[index - 1]?.provider !== option.provider;
                    return (
                      <div key={`${option.provider}/${option.id}`}>
                        {showProvider && (
                          <p className="px-3 pt-2 pb-0.5 font-mono text-[11px] text-muted-foreground">
                            {option.provider}
                          </p>
                        )}
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={current}
                          className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm hover:bg-muted"
                          onClick={() => chooseModel(option)}
                        >
                          <span className="min-w-0">
                            <span className="block truncate">{option.name}</span>
                            {option.name !== option.id && (
                              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                {option.id}
                              </span>
                            )}
                          </span>
                          {current && (
                            <span aria-hidden="true" className="font-mono text-[11px]">
                              ●
                            </span>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
