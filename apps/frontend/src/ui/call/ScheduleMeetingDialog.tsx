import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  FormHelperText,
  Stack,
  TextField
} from '@linagora/twake-mui'
import { useMutation } from '@tanstack/react-query'
import { useId, useState, type ReactElement } from 'react'

import {
  fromInputs,
  MEETING_MINUTES,
  MINUTE,
  nextSlot,
  toInputs,
  withOffset
} from '@/application/meetings'
import { isRefusal, type Space } from '@/application/spaces'
import { DialogHeader } from '@/ds/Dialog'
import { DayField, TimeField } from '@/ds/Pickers'
import { useI18n, type TranslationKey } from '@/ui/i18n/useI18n'
import { useServices } from '@/ui/services/Services'
import { useCommonSettings } from '@/ui/settings/useCommonSettings'

const REFUSALS: Record<string, TranslationKey> = {
  cannot_schedule: 'call.refusal.cannotSchedule',
  no_calendar: 'call.refusal.noCalendar',
  unavailable: 'call.refusal.unavailable'
}

export function ScheduleMeetingDialog({
  space,
  onClose,
  onScheduled
}: {
  space: Space
  onClose: () => void
  onScheduled: () => void
}): ReactElement {
  const { t } = useI18n()
  const titleId = useId()
  const { meetings } = useServices()
  // The calendar shows times in the Twake Workplace time zone, not the browser's
  const { settings } = useCommonSettings()
  const zone =
    settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const [opened] = useState(() => new Date())
  const today = toInputs(opened, zone)
  // A slot of the time list, at least half an hour ahead
  const [start] = useState(() =>
    toInputs(nextSlot(new Date(opened.getTime() + 30 * MINUTE), zone, 30), zone)
  )
  const [title, setTitle] = useState(space.name)
  const [date, setDate] = useState(start.date)
  const [time, setTime] = useState(start.time)
  const [description, setDescription] = useState('')
  const [uid] = useState(() => crypto.randomUUID())
  const schedule = useMutation({
    mutationFn: (begin: Date) =>
      meetings.schedule(space.id, {
        title: title.trim(),
        start: withOffset(begin, zone),
        end: withOffset(
          new Date(begin.getTime() + MEETING_MINUTES * MINUTE),
          zone
        ),
        timezone: zone,
        ...(description.trim() && { description: description.trim() }),
        uid
      }),
    onSuccess: onScheduled
  })
  const begin = fromInputs(date, time, zone)
  const past = begin !== null && begin <= opened
  const code = isRefusal(schedule.error) ? schedule.error.code : null
  const refusal = code ? REFUSALS[code] : undefined
  // Reopened, the dialog has a new UID: closing mid-request could schedule twice
  const close = (): void => {
    if (!schedule.isPending) onClose()
  }

  return (
    <Dialog open onClose={close} aria-labelledby={titleId} size="small">
      <form
        noValidate
        onSubmit={event => {
          event.preventDefault()
          if (begin && !past) schedule.mutate(begin)
        }}
      >
        <DialogHeader
          id={titleId}
          title={t('call.schedule')}
          close={{ label: t('common.close'), onClick: close }}
        />
        <DialogContent>
          <Stack spacing={2}>
            <TextField
              fullWidth
              label={t('call.meetingTitle')}
              value={title}
              slotProps={{ htmlInput: { maxLength: 255 } }}
              onChange={event => {
                setTitle(event.target.value)
              }}
            />
            <div>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <DayField
                  label={t('call.date')}
                  value={date}
                  min={today.date}
                  onChange={setDate}
                />
                <TimeField
                  label={t('call.time')}
                  value={time}
                  min={date === today.date ? today.time : undefined}
                  onChange={setTime}
                />
              </Stack>
              <FormHelperText>
                {t('call.duration', { minutes: MEETING_MINUTES })}
              </FormHelperText>
            </div>
            <TextField
              fullWidth
              multiline
              minRows={2}
              label={t('call.description')}
              value={description}
              slotProps={{ htmlInput: { maxLength: 4000 } }}
              onChange={event => {
                setDescription(event.target.value)
              }}
            />
            {schedule.error && (
              <Alert severity="error">
                {t(refusal ?? 'call.refusal.failed')}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            variant="text"
            disabled={schedule.isPending}
            onClick={onClose}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={
              title.trim() === '' || !begin || past || schedule.isPending
            }
          >
            {t('call.scheduleAction')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
