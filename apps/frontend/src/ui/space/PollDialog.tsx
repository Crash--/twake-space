import { Icon, Plus } from '@linagora/twake-icons'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  Stack,
  TextField
} from '@linagora/twake-mui'
import { useMutation } from '@tanstack/react-query'
import { useId, useRef, useState, type ReactElement } from 'react'

import { POLL_OPTIONS, type FeedItem, type Poll } from '@/application/feed'
import { DialogHeader } from '@/ds/Dialog'
import { FeedPollOption } from '@/ds/Feed'
import { useI18n } from '@/ui/i18n/useI18n'
import { useServices } from '@/ui/services/Services'
import { FeedFailure } from '@/ui/space/FeedFailure'

// `key` keeps a field in place when one above it is removed.
interface OptionField {
  key: number
  text: string
}

/** A new poll: a question and different options, one to pick, or a yes/no question. */
export function PollDialog({
  spaceId,
  kind,
  onClose,
  onPublished
}: {
  spaceId: string
  kind: Poll['kind']
  onClose: () => void
  onPublished: (item: FeedItem) => void
}): ReactElement {
  const { t } = useI18n()
  const { feed } = useServices()
  const titleId = useId()
  const nextKey = useRef(POLL_OPTIONS.min)
  const [question, setQuestion] = useState('')
  const [fields, setFields] = useState<OptionField[]>(() =>
    Array.from({ length: POLL_OPTIONS.min }, (_, key) => ({ key, text: '' }))
  )
  const options = fields.map(field => field.text.trim()).filter(Boolean)
  const valid =
    question.trim() !== '' &&
    (kind === 'yes_no' ||
      (options.length >= POLL_OPTIONS.min &&
        new Set(options.map(o => o.toLowerCase())).size === options.length))
  const publish = useMutation({
    mutationFn: () =>
      feed.post(
        spaceId,
        question.trim(),
        [],
        kind === 'yes_no' ? { poll: { kind } } : { poll: { options } }
      ),
    onSuccess: onPublished
  })

  return (
    <Dialog open onClose={onClose} aria-labelledby={titleId} size="small">
      <form
        noValidate
        onSubmit={event => {
          event.preventDefault()
          if (valid) publish.mutate()
        }}
      >
        <DialogHeader
          id={titleId}
          title={t(kind === 'yes_no' ? 'feed.yesNo.title' : 'feed.poll.title')}
          close={{ label: t('common.close'), onClick: onClose }}
        />
        <DialogContent>
          <Stack spacing={2}>
            <TextField
              fullWidth
              label={t('feed.poll.question')}
              value={question}
              slotProps={{ htmlInput: { maxLength: 4000 } }}
              onChange={event => {
                setQuestion(event.target.value)
              }}
            />
            {kind === 'choice' &&
              fields.map((field, index) => (
                <FeedPollOption
                  key={field.key}
                  removeLabel={t('feed.poll.removeOption', { n: index + 1 })}
                  onRemove={
                    fields.length > POLL_OPTIONS.min
                      ? () => {
                          setFields(current =>
                            current.filter(f => f.key !== field.key)
                          )
                        }
                      : null
                  }
                >
                  <TextField
                    fullWidth
                    size="small"
                    label={t('feed.poll.option', { n: index + 1 })}
                    value={field.text}
                    slotProps={{ htmlInput: { maxLength: 200 } }}
                    onChange={event => {
                      const text = event.target.value
                      setFields(current =>
                        current.map(f =>
                          f.key === field.key ? { ...f, text } : f
                        )
                      )
                    }}
                  />
                </FeedPollOption>
              ))}
            {kind === 'choice' && fields.length < POLL_OPTIONS.max && (
              <div>
                <Button
                  variant="text"
                  size="small"
                  startIcon={<Icon icon={Plus} size={16} />}
                  onClick={() => {
                    const key = nextKey.current
                    nextKey.current += 1
                    setFields(current => [...current, { key, text: '' }])
                  }}
                >
                  {t('feed.poll.addOption')}
                </Button>
              </div>
            )}
            <FeedFailure error={publish.error} message={t('feed.postFailed')} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="text" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!valid || publish.isPending}
          >
            {t('feed.poll.publish')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
