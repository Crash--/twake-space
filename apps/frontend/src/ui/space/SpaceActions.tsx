import { Assistant, Icon } from '@linagora/twake-icons'
import { useState, type ReactElement } from 'react'

import type { Space } from '@/application/spaces'
import { IconButton } from '@/ds/IconButton'
import { GroupAddIcon } from '@/ds/icons'
import { useAssistant } from '@/ui/assistant/AssistantPanel'
import { MeetingMenu } from '@/ui/call/MeetingMenu'
import { useI18n } from '@/ui/i18n/useI18n'
import { PeopleDialog } from '@/ui/space/PeopleDialog'
import { ShareLinkButton, SpaceMenu } from '@/ui/space/SpaceMenu'

// The header's actions, in the mockup's order: the assistant, video meetings,
// invite (admins), share the link, and the rest in the menu. The mockup's
// call waits for its app.
export function SpaceActions({ space }: { space: Space }): ReactElement {
  const { t } = useI18n()
  const [inviting, setInviting] = useState(false)
  const assistant = useAssistant()
  return (
    <>
      <IconButton
        size="small"
        label={t('assistant.open')}
        aria-pressed={assistant.open}
        onClick={() => {
          assistant.setOpen(!assistant.open)
        }}
      >
        <Icon icon={Assistant} />
      </IconButton>
      <MeetingMenu space={space} />
      {space.role === 'admin' && (
        <IconButton
          size="small"
          label={t('spaceMenu.invite')}
          onClick={() => {
            setInviting(true)
          }}
        >
          <Icon icon={GroupAddIcon} />
        </IconButton>
      )}
      <ShareLinkButton id={space.id} />
      <SpaceMenu space={space} />
      {inviting && (
        <PeopleDialog
          space={space}
          onClose={() => {
            setInviting(false)
          }}
        />
      )}
    </>
  )
}
