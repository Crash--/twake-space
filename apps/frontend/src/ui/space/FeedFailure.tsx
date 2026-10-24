import { Alert } from '@linagora/twake-mui'
import type { ReactElement } from 'react'

import { isRefusal } from '@/application/spaces'
import { useI18n } from '@/ui/i18n/useI18n'

export function FeedFailure({
  error,
  message
}: {
  error: Error | null
  message: string
}): ReactElement | null {
  const { t } = useI18n()
  if (!error) return null
  const limited = isRefusal(error) && error.status === 429
  return <Alert severity="error">{limited ? t('feed.tooFast') : message}</Alert>
}
