import type { ReactNode } from "react";
import type { NoticeIconName } from "../shared/queue";

/** Pixel size of one square icon; it inherits the surrounding text colour. */
export interface IconProps {
  size?: number;
  className?: string;
}

function Icon({
  name,
  size = 16,
  className,
  children,
}: IconProps & { name: string; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "shrink-0"}
    >
      {children}
    </svg>
  );
}

const NOTICE_ICON_PATHS: Record<NoticeIconName, ReactNode> = {
  job: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </>
  ),
  delegate: (
    <>
      <path d="M12 3 3 12l9 9 9-9-9-9Z" />
      <path d="m8 12 4-4 4 4-4 4-4-4Z" />
    </>
  ),
  mcp: <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />,
  memory: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  idle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  "decision-approved": <path d="m5 12 4 4L19 6" />,
  "decision-declined": <path d="m6 6 12 12M18 6 6 18" />,
  operator: <path d="M12 3 3 12l9 9 9-9-9-9Z" />,
  warning: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
};

/** A notice's icon, selected by the shared kind-to-icon mapping. */
export function NoticeIcon({ name, ...props }: IconProps & { name: NoticeIconName }) {
  return (
    <Icon name={name} {...props}>
      {NOTICE_ICON_PATHS[name]}
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon name="close" {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <Icon name="chevron" {...props}>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon name="chevron-left" {...props}>
      <path d="m15 18-6-6 6-6" />
    </Icon>
  );
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <Icon name="chevron-up" {...props}>
      <path d="m18 15-6-6-6 6" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon name="chevron-down" {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon name="search" {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </Icon>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Icon name="arrow-down" {...props}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon name="refresh" {...props}>
      <path d="M21 12a9 9 0 1 1-3.5-7.1" />
      <path d="M21 3v6h-6" />
    </Icon>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <Icon name="minus" {...props}>
      <path d="M5 12h14" />
    </Icon>
  );
}

export function GripIcon(props: IconProps) {
  return (
    <Icon name="grip" {...props}>
      <circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <Icon name="more" {...props}>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function TrendUpIcon(props: IconProps) {
  return (
    <Icon name="trend-up" {...props}>
      <path d="m12 5 7 14H5L12 5Z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function TrendDownIcon(props: IconProps) {
  return (
    <Icon name="trend-down" {...props}>
      <path d="m12 19-7-14h14l-7 14Z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function DotIcon(props: IconProps) {
  return (
    <Icon name="dot" {...props}>
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </Icon>
  );
}
