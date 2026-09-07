export function assertMacBundleIdentity(info, expected) {
  const fields = {
    CFBundleIdentifier: expected.identifier,
    CFBundleShortVersionString: expected.version,
    CFBundleVersion: expected.version,
    CFBundleExecutable: 'clawmaster-desktop',
  };
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || !value || info[field] !== value) {
      throw new Error(`Tauri bundle identity mismatch: ${field}; expected ${value}, found ${info[field]}`);
    }
  }
}
