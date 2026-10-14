import { Calendar, Icon, Link } from '@linagora/twake-icons'
import { Menu, Snackbar } from '@linagora/twake-mui'
import { useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router'

import { tabPath } from '@/application/embeddedApps'
import type { Space } from '@/application/spaces'
import { isTabReady } from '@/application/spaceTabs'
import { IconButton } from '@/ds/IconButton'
import { Videocam, VideocamSymbolIcon } from '@/ds/icons'
import { MenuEntry } from '@/ds/Menu'
import { useCall } from '@/ui/call/CallContext'
import { JoinMeetingDialog } from '@/ui/call/JoinMeetingDialog'
import { ScheduleMeetingDialog } from '@/ui/call/ScheduleMeetingDialog'
import { useI18n } from '@/ui/i18n/useI18n'
import { useServices } from '@/ui/services/Services'
import { useAppUrls } from '@/ui/space/useAppUrls'

// The space header's video button.
export function MeetingMenu({ space }: { space: Space }): ReactElement | null {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { meetUrl } = useServices()
  const appUrls = useAppUrls()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [joining, setJoining] = useState(false)
  const { leave } = useCall()
  const [scheduling, setScheduling] = useState(false)
  const [scheduled, setScheduled] = useState(false)
  const chatCall = appUrls.chat !== null && isTabReady(space, 'chat')
  const canSchedule = space.role !== 'viewer' && isTabReady(space, 'calendar')
  if (!meetUrl && !chatCall && !canSchedule) return null
  const close = (): void => {
    setAnchor(null)
  }
  return (
    <>
      <IconButton
        size="small"
        label={t('call.menu')}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={event => {
          setAnchor(event.currentTarget)
        }}
      >
        <Icon icon={VideocamSymbolIcon} />
      </IconButton>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={close}>
        {chatCall && (
          <MenuEntry
            icon={<Icon icon={Videocam} />}
            onClick={() => {
              close()
              // One call at a time: the Meet room is left for Chat's call
              leave()
              void navigate(`${tabPath(space.id, 'chat')}?call=start`)
            }}
          >
            {t('call.start')}
          </MenuEntry>
        )}
        {canSchedule && (
          <MenuEntry
            icon={<Icon icon={Calendar} />}
            onClick={() => {
              close()
              setScheduling(true)
            }}
          >
            {t('call.schedule')}
          </MenuEntry>
        )}
        {meetUrl && (
          <MenuEntry
            icon={<Icon icon={Link} />}
            onClick={() => {
              close()
              setJoining(true)
            }}
          >
            {t('call.join')}
          </MenuEntry>
        )}
      </Menu>
      {joining && meetUrl && (
        <JoinMeetingDialog
          meetUrl={meetUrl}
          onClose={() => {
            setJoining(false)
          }}
        />
      )}
      {scheduling && (
        <ScheduleMeetingDialog
          space={space}
          onClose={() => {
            setScheduling(false)
          }}
          onScheduled={() => {
            setScheduling(false)
            setScheduled(true)
          }}
        />
      )}
      <Snackbar
        open={scheduled}
        autoHideDuration={6000}
        onClose={() => {
          setScheduled(false)
        }}
        message={t('call.scheduled')}
      />
    </>
  )
}
