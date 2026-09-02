export interface RuntimeSessionLike {
  status?: string;
}

export function hasActiveRuntimeSession(
  sessions: readonly RuntimeSessionLike[],
): boolean {
  return sessions.some(
    (session) => session.status === 'thinking' || session.status === 'streaming',
  );
}
