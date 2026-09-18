/**
 * Sidebar glyph for the voice tab.
 * Drawn inline as SVG like every other product tab, so the module ships no raster asset and follows
 * the host's text colour in both themes.
 * @param props - The size the sidebar asks for.
 */
export function VoiceIcon({ size = 16 }: { size?: number }): React.ReactElement {
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
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v3.5" />
      <path d="M8.5 21.5h7" />
    </svg>
  );
}

/** A dot that fills as the level rises, so the meter needs no layout shift. */
export function LevelDot({ level, speaking }: { level: number; speaking: boolean }): React.ReactElement {
  const scale = Math.min(1, Math.max(0.15, level * 4));
  return (
    <span
      className={speaking ? 'cm-voice-meter cm-voice-meter-speaking' : 'cm-voice-meter'}
      style={{ transform: `scale(${scale.toFixed(3)})` }}
      aria-hidden="true"
    />
  );
}
