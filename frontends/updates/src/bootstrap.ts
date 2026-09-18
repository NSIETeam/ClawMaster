/** First-install bootstrap for the verified updater component on an existing live web profile. */
import { mountFirstUpdaterComponent, type ComponentActivation } from './components.ts';

/**
 * Add the official updater only when no updater row or profile dependency already exists.
 * Existing installations require the staged update path; caller claims about Host shutdown never bypass this guard.
 * @param options - installed updater version, selected Host home and explicit approval bound to a patch revision.
 * @returns pending activation, which must be followed by an independent Loader observation.
 */
export async function bootstrapUpdater(options: {
  dshHome: string;
  version: string;
  expectedPatchRevision: string;
  confirmed: boolean;
}): Promise<ComponentActivation> {
  return mountFirstUpdaterComponent(options);
}
