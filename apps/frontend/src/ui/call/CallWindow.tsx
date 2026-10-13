import type { ReactElement } from 'react'

import { FloatingWindow, WindowFrame } from '@/ds/FloatingWindow'
import { useCall } from '@/ui/call/CallContext'
import { useI18n } from '@/ui/i18n/useI18n'
import { SANDBOX } from '@/ui/space/EmbeddedAppFrame'

const MEET_PERMISSIONS =
  'camera; microphone; display-capture; autoplay; fullscreen; clipboard-write'

export function CallWindow(): ReactElement | null {
  const { t } = useI18n()
  const { call, leave } = useCall()
  if (!call) return null
  return (
    <FloatingWindow
      title={t('call.window')}
      storageKey="twake-space:call-window"
      labels={{
        minimize: t('call.minimize'),
        maximize: t('call.maximize'),
        restore: t('call.restore'),
        close: t('call.leave')
      }}
      onClose={leave}
      // Meet's join screen needs a wide room, and does not scroll
      maximized
    >
      {moving => (
        <WindowFrame
          key={call.url}
          moving={moving}
          src={call.url}
          title={t('call.window')}
          sandbox={SANDBOX}
          allow={MEET_PERMISSIONS}
        />
      )}
    </FloatingWindow>
  )
}
