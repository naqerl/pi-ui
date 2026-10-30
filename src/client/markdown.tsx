// biome-ignore-all lint/suspicious/noArrayIndexKey: Markdown tokens have no ids; their order is the identity.
import { Lexer, lexer, type Token, type Tokens } from "marked";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";

const headingClasses: Record<number, string> = {
  1: "mt-4 mb-1 text-base font-semibold tracking-tight first:mt-0",
  2: "mt-3 mb-1 text-sm font-semibold tracking-tight first:mt-0",
  3: "mt-3 mb-1 text-sm font-medium first:mt-0",
  4: "mt-2 mb-1 text-sm font-medium first:mt-0",
  5: "mt-2 mb-1 text-xs font-semibold first:mt-0",
  6: "mt-2 mb-1 text-xs font-medium first:mt-0",
};

const alignClasses: Record<NonNullable<Tokens.Table["align"][number]>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

/** Inside a button (a task card) links cannot be interactive, so they render as styled text. */
type InlineMode = "interactive" | "static";

function inline(
  tokens: readonly Token[] | undefined,
  keyPrefix: string,
  mode: InlineMode = "interactive",
): ReactNode[] {
  const list = tokens ?? [];
  return list.map((token, index) =>
    inlineToken(token, `${keyPrefix}-${index}`, index === 0 || index === list.length - 1, mode),
  );
}

function inlineToken(token: Token, key: string, edge: boolean, mode: InlineMode): ReactNode {
  switch (token.type) {
    case "text":
      if (token.tokens !== undefined) {
        return <Fragment key={key}>{inline(token.tokens, key, mode)}</Fragment>;
      }
      return token.text;
    case "strong":
      return (
        <strong key={key} className="font-semibold">
          {inline(token.tokens, key, mode)}
        </strong>
      );
    case "em":
      return (
        <em key={key} className="italic">
          {inline(token.tokens, key, mode)}
        </em>
      );
    case "del":
      return (
        <del key={key} className="line-through">
          {inline(token.tokens, key, mode)}
        </del>
      );
    case "codespan":
      return (
        <code
          key={key}
          className="bg-foreground/[0.06] px-1 py-px font-mono text-[0.85em] [overflow-wrap:anywhere] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]"
        >
          {token.text}
        </code>
      );
    case "link": {
      const href = safeHref(token.href);
      if (href === undefined)
        return <Fragment key={key}>{inline(token.tokens, key, mode)}</Fragment>;
      if (mode === "static") {
        return (
          <span
            key={key}
            className="underline decoration-foreground/40 underline-offset-2 [overflow-wrap:anywhere]"
          >
            {inline(token.tokens, key, mode)}
          </span>
        );
      }
      return (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="underline decoration-foreground/40 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-foreground"
        >
          {inline(token.tokens, key, mode)}
        </a>
      );
    }
    case "image": {
      const href = safeHref(token.href);
      const label = token.text.length > 0 ? token.text : "image";
      if (href === undefined || mode === "static") return <Fragment key={key}>{label}</Fragment>;
      return (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="underline decoration-foreground/40 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-foreground"
        >
          {label}
        </a>
      );
    }
    case "br":
      return edge ? null : <br key={key} />;
    case "escape":
    case "html":
      return <Fragment key={key}>{token.text}</Fragment>;
    default:
      if ("tokens" in token && Array.isArray(token.tokens)) {
        return <Fragment key={key}>{inline(token.tokens, key, mode)}</Fragment>;
      }
      if ("text" in token && typeof token.text === "string") {
        return <Fragment key={key}>{token.text}</Fragment>;
      }
      return null;
  }
}

function blocks(tokens: readonly Token[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, index) => blockToken(token, `${keyPrefix}-${index}`));
}

function blockToken(token: Token, key: string): ReactNode {
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "heading": {
      const depth = Math.min(6, Math.max(1, token.depth));
      const Tag = `h${depth}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag key={key} className={headingClasses[depth]}>
          {inline(token.tokens, key)}
        </Tag>
      );
    }
    case "paragraph":
      if (token.text.trim().length === 0) return null;
      return (
        <p key={key} className="whitespace-pre-wrap break-words">
          {inline(token.tokens, key)}
        </p>
      );
    case "code":
      return <CodeBlock key={key} text={token.text} />;
    case "blockquote": {
      const node = token as Tokens.Blockquote;
      return (
        <blockquote
          key={key}
          className="border-l-2 border-foreground/30 pl-3 text-muted-foreground"
        >
          {blocks(node.tokens, key)}
        </blockquote>
      );
    }
    case "list": {
      const node = token as Tokens.List;
      const Tag = node.ordered ? "ol" : "ul";
      return (
        <Tag
          key={key}
          className={
            node.ordered
              ? "my-1 list-decimal space-y-1 pl-5 marker:text-muted-foreground"
              : "my-1 list-disc space-y-1 pl-5 marker:text-muted-foreground"
          }
        >
          {node.items.map((item, index) => (
            <li key={`${key}-item-${index}`} className="min-w-0 pl-1">
              {listItem(item, `${key}-item-${index}`)}
            </li>
          ))}
        </Tag>
      );
    }
    case "table": {
      const node = token as Tokens.Table;
      return (
        <div key={key} className="max-w-full overflow-x-auto">
          <table className="w-max min-w-full border-collapse text-left text-xs [overflow-wrap:normal]">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                {node.header.map((cell, index) => (
                  <th
                    key={`${key}-h-${index}`}
                    className={`max-w-[24rem] border border-border px-2 py-1 font-semibold break-words ${alignClass(cell.align)}`}
                  >
                    {inline(cell.tokens, `${key}-h-${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, rowIndex) => (
                <tr key={`${key}-r-${rowIndex}`} className="border-b border-border">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${key}-r-${rowIndex}-c-${cellIndex}`}
                      className={`max-w-[24rem] border border-border px-2 py-1 align-top break-words ${alignClass(cell.align)}`}
                    >
                      {inline(cell.tokens, `${key}-r-${rowIndex}-c-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "hr":
      return <hr key={key} className="my-3 border-border" />;
    case "html":
      if (token.text.trim().length === 0) return null;
      return (
        <p key={key} className="whitespace-pre-wrap break-words font-mono text-xs">
          {token.text}
        </p>
      );
    default:
      if ("tokens" in token && Array.isArray(token.tokens)) {
        return <Fragment key={key}>{blocks(token.tokens, key)}</Fragment>;
      }
      if ("text" in token && typeof token.text === "string") {
        if (token.text.trim().length === 0) return null;
        return (
          <p key={key} className="whitespace-pre-wrap break-words">
            {token.text}
          </p>
        );
      }
      return null;
  }
}

function listItem(item: Tokens.ListItem, key: string): ReactNode {
  return (
    <>
      {item.task && (
        <input
          type="checkbox"
          checked={item.checked === true}
          readOnly
          aria-label={item.checked === true ? "completed task" : "incomplete task"}
          className="mr-2 align-middle accent-foreground"
        />
      )}
      {item.tokens.map((token, index) =>
        token.type === "text" ? (
          <Fragment key={`${key}-${index}`}>
            {token.tokens === undefined ? token.text : inline(token.tokens, `${key}-${index}`)}
          </Fragment>
        ) : (
          blockToken(token, `${key}-${index}`)
        ),
      )}
    </>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to a selection copy below; plain-http hosts have no clipboard API.
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  field.remove();
  return copied;
}

const hoverCapableQuery = "(hover: hover) and (pointer: fine)";

function useHoverCapablePointer() {
  const [hoverCapable, setHoverCapable] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(hoverCapableQuery).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(hoverCapableQuery);
    const update = () => setHoverCapable(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return hoverCapable;
}

function CodeBlock({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const hoverCapable = useHoverCapablePointer();
  const feedback = state !== "idle";

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <div className="group relative min-w-0 max-w-full">
      <pre className="max-w-full overflow-x-auto whitespace-pre border border-border bg-muted px-3 py-2.5 pr-14 font-mono text-xs leading-relaxed [overflow-wrap:normal]">
        <code className="font-mono">{text}</code>
      </pre>
      <button
        type="button"
        aria-label={state === "copied" ? "Copied" : "Copy code"}
        onClick={() => {
          void copyText(text).then((ok) => setState(ok ? "copied" : "failed"));
        }}
        className={`theme-radius absolute top-1 right-1 border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-opacity hover:text-foreground ${
          feedback || !hoverCapable
            ? "opacity-90"
            : "opacity-0 group-hover:opacity-90 focus-visible:opacity-100"
        }`}
      >
        {state === "copied" ? "copied" : state === "failed" ? "failed" : "copy"}
      </button>
    </div>
  );
}

function alignClass(align: "center" | "left" | "right" | null): string {
  return align === null ? "text-left" : alignClasses[align];
}

function safeHref(value: string): string | undefined {
  try {
    const url = new URL(value, "https://markdown.invalid");
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return value;
    }
  } catch {
    // Fall through and render the link label without an anchor.
  }
  return undefined;
}

function normalize(text: string): string {
  return text
    .replace(/[ \t\u00a0\u200b]+$/gm, "")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

export function Markdown({ text }: { text: string }) {
  const tokens = useMemo(() => lexer(normalize(text)), [text]);
  // overflow-wrap:anywhere lets long hashes, URLs and inline code break inside a bubble;
  // code blocks and tables opt back out and scroll sideways instead.
  return (
    <div className="min-w-0 max-w-full space-y-2 [overflow-wrap:anywhere]">
      {blocks(tokens, "md")}
    </div>
  );
}

/**
 * One-line Markdown for task titles: bold, italic, strikethrough, inline code and links.
 * Block syntax stays literal, line breaks are kept, and links are plain styled text because
 * the title sits inside the task card's button.
 */
export function InlineMarkdown({ text }: { text: string }) {
  const tokens = useMemo(() => Lexer.lexInline(text), [text]);
  return <>{inline(tokens, "imd", "static")}</>;
}

/** The text a reader sees in {@link InlineMarkdown}, for labels and titles. */
export function plainInline(text: string): string {
  const flatten = (tokens: readonly Token[] | undefined): string =>
    (tokens ?? [])
      .map((token) => {
        if ("tokens" in token && Array.isArray(token.tokens) && token.type !== "codespan") {
          return flatten(token.tokens);
        }
        if (token.type === "br") return "\n";
        return "text" in token && typeof token.text === "string" ? token.text : "";
      })
      .join("");
  return flatten(Lexer.lexInline(text));
}
