/** Register tutorial preferences in the existing DSH settings document. */
import Schema from '@deepseek-ai/schemastery';
import { ONBOARDING_NAMESPACE, type OnboardingSettings } from './onboarding.ts';

/** Host schema accepts newer acknowledgement versions without downgrading them. */
export const OnboardingSettingsSchema: Schema<OnboardingSettings> = Schema.object({
  acknowledgedVersion: Schema.natural().default(0),
});

/** Host registration is owned and disposed by DSH's settings service. */
export interface OnboardingHostServices {
  settings: { register(namespace: typeof ONBOARDING_NAMESPACE, schema: Schema<OnboardingSettings>): unknown };
}
