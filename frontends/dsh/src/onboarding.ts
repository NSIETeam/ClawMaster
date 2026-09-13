/** Versioned tutorial acknowledgement follows DSH's existing settings scope. */
import type { Observable } from './services.ts';

/** Host namespace; it stores tutorial reading progress, never connection status. */
export const ONBOARDING_NAMESPACE = 'clawmaster-watchdog-onboarding';
/** Acknowledgement versions are monotonic; newer values remain acknowledged. */
export const ONBOARDING_VERSION = 1;
/** Durable settings fields owned by the WatchDog tutorial. */
export interface OnboardingSettings { acknowledgedVersion: number; }
/** Public subset of the DSH namespace scope consumed by this tutorial. */
export interface OnboardingScope extends Observable<{
  status: 'loading' | 'ready' | 'unavailable'; mode: 'host' | 'memory';
  value: OnboardingSettings | undefined;
}> { set(field: string, value: unknown): Promise<void>; }

/**
 * Validate a settings section received over the settings transport.
 * @param value - Settings namespace value.
 * @returns The acknowledgement or undefined for an unrecognized value.
 */
export function decodeOnboarding(value: unknown): OnboardingSettings | undefined {
  if (typeof value !== 'object' || value === null || !('acknowledgedVersion' in value)) return undefined;
  const version = value.acknowledgedVersion;
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0
    ? { acknowledgedVersion: version } : undefined;
}

/**
 * Acknowledge an explicit skip or finish without changing model or IM configuration.
 * @param scope - DSH owns write ordering, revision checks and recovery reads.
 * @returns Whether the durable settings confirm this tutorial version; remote memory mode is process-local.
 */
export async function acknowledgeOnboarding(scope: OnboardingScope): Promise<boolean> {
  if (scope.getSnapshot().mode === 'memory') return true;
  if ((scope.getSnapshot().value?.acknowledgedVersion ?? 0) >= ONBOARDING_VERSION) return true;
  await scope.set('acknowledgedVersion', ONBOARDING_VERSION);
  return (scope.getSnapshot().value?.acknowledgedVersion ?? 0) >= ONBOARDING_VERSION;
}
