/** Per-call WeChat approval with a final, non-overridable dispatch check. */
import z from '@deepseek-ai/schemastery'

export const name = 'wechat-mcp-approval'
export const inject = ['tools']
export const Config = z.object({
  serverName: z.union(['wechat_personal', 'wechat_official']).required(),
})

const supported = {
  wechat_personal: new Set([
    'fetch_messages_by_chat', 'reply_to_messages_by_chat',
    'add_contact_by_wechat_id', 'publish_moment_without_media',
  ]),
  wechat_official: new Set([
    'publish_article', 'list_themes', 'register_theme', 'remove_theme',
  ]),
}

/**
 * Install approval for this server namespace; unknown tools fail closed.
 * @param ctx - Cordis context owning the policy effects.
 * @param config - Dedicated personal or official-account namespace.
 * @returns Nothing; disposing the plugin removes both policy effects.
 */
export function apply(ctx, config) {
  const prefix = `mcp__${config.serverName}__`
  const grants = new WeakMap()
  const matches = exec => exec.name.startsWith(prefix)
  ctx.effect(() => ctx.tools.guard(exec => {
    if (!matches(exec)) return undefined
    const approved = grants.get(exec)
    grants.delete(exec)
    return approved !== undefined && approved === JSON.stringify(exec.arguments)
      ? undefined
      : 'WeChat call requires a matching one-time approval.'
  }))
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!matches(exec)) return next()
    if (!supported[config.serverName].has(exec.name.slice(prefix.length))) {
      return { kind: 'deny', reason: 'Unsupported WeChat tool; review the integration before enabling it.' }
    }
    const decision = await next()
    if (decision.kind === 'deny') return decision
    const approval = ctx.get('approval')
    if (approval === undefined || exec.agent === undefined) {
      return { kind: 'deny', reason: 'WeChat requires an agent with an available approval channel.' }
    }
    const args = JSON.stringify(exec.arguments)
    const reason = config.serverName === 'wechat_personal'
      ? 'WeChat may read private chats or operate the desktop, send messages, add contacts or post Moments. Review the exact tool arguments.'
      : 'WeChat Official Account may read local files, fetch URLs, upload media and save an article to drafts (not public publication), or change themes. Review the exact tool arguments.'
    const outcome = await approval.request({
      agent: exec.agent, callId: exec.callId, toolName: exec.name,
      reason: decision.kind === 'ask' && decision.reason ? `${reason} ${decision.reason}` : reason,
      signal: exec.signal,
    })
    if (outcome !== 'allowed-once' || exec.signal.aborted) {
      return { kind: 'deny', reason: `WeChat approval: ${outcome}.` }
    }
    grants.set(exec, args)
    return { kind: 'allow' }
  })
}
