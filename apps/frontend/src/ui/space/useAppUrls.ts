import { driveUrl } from '@/application/drive'
import type { EmbeddedApp } from '@/application/embeddedApps'
import { useServices } from '@/ui/services/Services'
import { useSession } from '@/ui/session/SessionGate'

// Where each embedded app is, null when not set up: one address per
// deployment, except Twake Drive, on each person's own Twake Workplace, and
// Chat, on the space's organization when it has its own.
export function useAppUrls(
  spaceChatUrl: string | null
): Record<EmbeddedApp, string | null> {
  const { tasksUrl, mailUrl, chatUrl, calendarUrl, driveUrlTemplate } =
    useServices()
  const { user } = useSession()
  return {
    chat: spaceChatUrl ?? chatUrl,
    tasks: tasksUrl,
    drive: driveUrl(driveUrlTemplate, user.workplaceFqdn),
    mail: mailUrl,
    calendar: calendarUrl
  }
}
