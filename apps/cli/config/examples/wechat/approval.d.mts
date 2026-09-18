import type { Context } from '@deepseek-ai/cordis'
import type Schema from '@deepseek-ai/schemastery'

/** Dedicated namespaces governed by the opt-in WeChat overlays. */
export interface Config {
  serverName: 'wechat_personal' | 'wechat_official'
}
export const name: string
export const inject: string[]
export const Config: Schema<Config>
/** Install scoped policy effects for one WeChat server. */
export function apply(ctx: Context, config: Config): void
