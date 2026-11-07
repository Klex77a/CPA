import type { CSSProperties, ReactNode } from 'react';
export type IconName =
  | 'dashboard'
  | 'message'
  | 'appeal'
  | 'checklist'
  | 'arrowLeft'
  | 'arrowRight'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronDown'
  | 'search'
  | 'download'
  | 'upload'
  | 'refresh'
  | 'play'
  | 'pause'
  | 'phone'
  | 'chat'
  | 'close'
  | 'plus'
  | 'check'
  | 'warning'
  | 'shield'
  | 'clock'
  | 'settings'
  | 'sparkles'
  | 'filter'
  | 'external'
  | 'more'
  | 'menu'
  | 'copy'
  | 'trash'
  | 'arrowUp'
  | 'arrowDown'
  | 'help'
  | 'file'
  | 'volume';
const paths: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="11" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="18" width="7" height="3" rx="1" />
    </>
  ),
  message: <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-3 2V11.5a9.5 9.5 0 0 1 19 0Z" />,
  chat: (
    <>
      <path d="M21 15a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z" />
      <path d="M8 8h8M8 12h5" />
    </>
  ),
  appeal: (
    <>
      <path d="m12 3 10 18H2Z" />
      <path d="M12 9v5m0 3h.01" />
    </>
  ),
  checklist: (
    <>
      <rect x="4" y="4" width="16" height="17" rx="2" />
      <path d="m8 11 2 2 5-5M8 17h8M9 4V2h6v2" />
    </>
  ),
  arrowLeft: <path d="m11 5-7 7 7 7M4 12h16" />,
  arrowRight: <path d="m13 5 7 7-7 7M20 12H4" />,
  chevronLeft: <path d="m15 5-7 7 7 7" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronDown: <path d="m5 9 7 7 7-7" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7a8.5 8.5 0 1 0 1 9M20 3v5h-5" />
    </>
  ),
  play: <path d="m8 4 12 8-12 8Z" />,
  pause: (
    <>
      <path d="M7 4v16M17 4v16" />
    </>
  ),
  phone: <path d="m8 3 3 5-3 3a16 16 0 0 0 5 5l3-3 5 3-1 4c-1 3-9 0-13-4S0 4 3 3Z" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  plus: <path d="M12 4v16M4 12h16" />,
  check: <path d="m4 12 5 5L20 6" />,
  warning: (
    <>
      <path d="m12 3 10 18H2Z" />
      <path d="M12 9v5m0 3h.01" />
    </>
  ),
  shield: (
    <>
      <path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  settings: (
    <>
      <path d="m10 3-1 3-3 1-3-1-1 4 3 2v3l-2 3 3 3 3-2 3 1 2 2 4-2v-3l2-3 2-1-1-4-3-1-2-3Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" />
    </>
  ),
  filter: (
    <>
      <path d="M3 6h18M6 12h12M10 18h4" />
    </>
  ),
  external: (
    <>
      <path d="M14 3h7v7m-1-6L10 14M10 4H4v16h16v-6" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M16 8V3H3v13h5" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
    </>
  ),
  arrowUp: <path d="m5 11 7-7 7 7M12 4v16" />,
  arrowDown: <path d="m5 13 7 7 7-7M12 20V4" />,
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 4h.01" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H4v20h16V8Zm0 0v6h6M8 13h8m-8 4h6" />
    </>
  ),
  volume: (
    <>
      <path d="M4 9v6h4l5 5V4L8 9Zm13-2c4 3 4 7 0 10" />
    </>
  ),
};
export default function Icon({
  name,
  size = 18,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ flexShrink: 0, ...style }}
    >
      {paths[name]}
    </svg>
  );
}
