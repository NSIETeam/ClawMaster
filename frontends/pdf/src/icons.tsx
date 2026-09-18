/**
 * Sidebar glyph for the PDF tab, drawn inline as SVG like every other product tab.
 * @param props - The size the sidebar asks for.
 */
export function PdfIcon({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14 2.5H7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z" />
      <path d="M14 2.5v5h5" />
      <path d="M8.5 16.5h7" />
      <path d="M8.5 13h7" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}
