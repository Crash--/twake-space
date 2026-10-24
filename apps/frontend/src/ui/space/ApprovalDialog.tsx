import {
  Alert,
  Autocomplete,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField
} from '@linagora/twake-mui'
import { useMutation } from '@tanstack/react-query'
import { useId, useState, type ReactElement } from 'react'

import { APPROVERS, type FeedItem } from '@/application/feed'
import { NameAvatar } from '@/ds/AppFrame'
import { DialogHeader } from '@/ds/Dialog'
import type { MentionablePerson } from '@/ds/Feed'
import { useI18n } from '@/ui/i18n/useI18n'
import { useServices } from '@/ui/services/Services'

/** A new approval request: what needs approval, and the members who decide. */
export function ApprovalDialog({
  spaceId,
  people,
  onClose,
  onPublished
}: {
  spaceId: string
  people: MentionablePerson[]
  onClose: () => void
  onPublished: (item: FeedItem) => void
}): ReactElement {
  const { t } = useI18n()
  const { feed } = useServices()
  const titleId = useId()
  const [request, setRequest] = useState('')
  const [approvers, setApprovers] = useState<MentionablePerson[]>([])
  const valid = request.trim() !== '' && approvers.length > 0
  const publish = useMutation({
    mutationFn: () =>
      feed.post(spaceId, request.trim(), [], {
        approval: { approvers: approvers.map(person => person.id) }
      }),
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
          title={t('feed.approval.title')}
          close={{ label: t('common.close'), onClick: onClose }}
        />
        <DialogContent>
          <Stack spacing={2}>
            <TextField
              fullWidth
              multiline
              maxRows={6}
              label={t('feed.approval.request')}
              value={request}
              slotProps={{ htmlInput: { maxLength: 4000 } }}
              onChange={event => {
                setRequest(event.target.value)
              }}
            />
            <Autocomplete
              multiple
              options={people}
              value={approvers}
              onChange={(_event, value: MentionablePerson[]) => {
                setApprovers(value.slice(0, APPROVERS.max))
              }}
              filterSelectedOptions
              getOptionLabel={person => person.name}
              getOptionKey={person => person.id}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              noOptionsText={t('feed.approval.noApprovers')}
              slotProps={{ chip: { size: 'small' } }}
              renderOption={({ key, ...props }, person) => (
                <li key={key} {...props}>
                  <ListItemIcon>
                    <NameAvatar
                      name={person.name}
                      size="s"
                      src={person.avatar}
                    />
                  </ListItemIcon>
                  <ListItemText
                    primary={person.name}
                    secondary={person.email}
                    slotProps={{
                      primary: { noWrap: true },
                      secondary: { noWrap: true }
                    }}
                  />
                </li>
              )}
              renderInput={params => (
                <TextField {...params} label={t('feed.approval.approvers')} />
              )}
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
            disabled={!valid || publish.isPending}
          >
            {t('feed.approval.publish')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
