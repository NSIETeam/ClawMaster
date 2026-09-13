/** Root-scoped controller for the right Sidebar's Session content. */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'

/**
 * Keep the current Session's Sidebar mounted across global panel navigation.
 * @param props - frame geometry, panel selection, and the authorized Session renderer.
 * @returns the current Session's right Sidebar with its presentation visibility.
 */
export function RightbarRoot({
  usePanelInfo, SessionProvider, renderSlot, width, viewportWidth, canShow,
}: PropsRuntime<'rightbar'> & PropsRenderSlots<'rightbar.session'>) {
  const visible = usePanelInfo(info => info.activePanelId === null)
  return (
    <SessionProvider>
      {renderSlot('rightbar.session', { width, viewportWidth, canShow, visible })}
    </SessionProvider>
  )
}
