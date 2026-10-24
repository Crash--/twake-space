import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  Stack,
  TextField
} from '@linagora/twake-mui'
import { useMutation } from '@tanstack/react-query'
import { useId, useState, type ReactElement } from 'react'

import type { FeedItem } from '@/application/feed'
import { DialogHeader } from '@/ds/Dialog'
import { useI18n } from '@/ui/i18n/useI18n'
import { useServices } from '@/ui/services/Services'

/** A new announcement, pinned once published, or a feedback request. */
export function TextPostDialog({
  spaceId,
  kind,
  onClose,
  onPublished
}: {
  spaceId: string
  kind: 'announcement' | 'feedback'
  onClose: () => void
  onPublished: (item: FeedItem) => void
}): ReactElement {
  const { t } = useI18n()
  const { feed } = useServices()
  const titleId = useId()
  const [text, setText] = useState('')
  const publish = useMutation({
    mutationFn: () =>
      feed.post(
        spaceId,
        text.trim(),
        [],
        kind === 'announcement' ? { announcement: true } : { feedback: true }
      ),
    onSuccess: onPublished
  })

  return (
    <Dialog open onClose={onClose} aria-labelledby={titleId} size="small">
      <form
        noValidate
        onSubmit={event => {
          event.preventDefault()
          if (text.trim()) publish.mutate()
        }}
      >
        <DialogHeader
          id={titleId}
          title={t(`feed.${kind}.title`)}
          close={{ label: t('common.close'), onClick: onClose }}
        />
        <DialogContent>
          <Stack spacing={2}>
            <TextField
              fullWidth
              multiline
              minRows={kind === 'announcement' ? 4 : 1}
              maxRows={12}
              label={t(`feed.${kind}.text`)}
              helperText={t(`feed.${kind}.hint`)}
              value={text}
              slotProps={{ htmlInput: { maxLength: 4000 } }}
              onChange={event => {
                setText(event.target.value)
              }}
            />
            {publish.isError && (
              <Alert severity="error">{t('feed.postFailed')}</Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="text" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!text.trim() || publish.isPending}
          >
            {t(`feed.${kind}.publish`)}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
