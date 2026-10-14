import {
  Archive,
  Dots,
  Icon,
  Link,
  People,
  Pin,
  Settings,
  Trash
} from '@linagora/twake-icons'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  Divider,
  Menu,
  Snackbar,
  Stack,
  TextField,
  Typography
} from '@linagora/twake-mui'
import { useEffect, useId, useState, type ReactElement } from 'react'
import { useMatch, useNavigate } from 'react-router'

import type {
  ShelfState,
  Space,
  SpaceApp,
  SpaceChange,
  SpaceSummary
} from '@/application/spaces'
import { DialogHeader } from '@/ds/Dialog'
import { IconButton } from '@/ds/IconButton'
import { MenuEntry } from '@/ds/Menu'
import { useI18n } from '@/ui/i18n/useI18n'
import { PeopleDialog } from '@/ui/space/PeopleDialog'
import { WriteError } from '@/ui/space/WriteError'
import { AppPicker } from '@/ui/spaces/AppPicker'
import {
  useDeleteSpace,
  useEditSpace,
  useSetPinned,
  useSetState,
  useSpace,
  useSpaceApps
} from '@/ui/spaces/queries'

type Named = Pick<SpaceSummary, 'id' | 'name'>

const spaceUrl = (id: string): string =>
  `${window.location.origin}/spaces/${encodeURIComponent(id)}`

// Copies the space's link and says so for a moment.
export function useShareLink(id: string): {
  share: () => void
  notice: ReactElement
} {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  return {
    share: () => {
      void navigator.clipboard.writeText(spaceUrl(id)).then(() => {
        setCopied(true)
      })
    },
    notice: (
      <Snackbar
        open={copied}
        autoHideDuration={3000}
        onClose={() => {
          setCopied(false)
        }}
        message={t('spaceMenu.linkCopied')}
      />
    )
  }
}

export function ShareLinkButton({ id }: { id: string }): ReactElement {
  const { t } = useI18n()
  const { share, notice } = useShareLink(id)
  return (
    <>
      <IconButton size="small" label={t('spaceMenu.shareLink')} onClick={share}>
        <Icon icon={Link} />
      </IconButton>
      {notice}
    </>
  )
}

// The "more" menu of a space, on its card and in its header. Every entry
// does something today: the mockup's notification waits for its backend.
export function SpaceMenu({
  space
}: {
  space: Pick<SpaceSummary, 'id' | 'name' | 'role' | 'pinnedAt' | 'manages'>
}): ReactElement {
  const { t } = useI18n()
  const navigate = useNavigate()
  const setPinned = useSetPinned(space.id)
  const { ask, notice: shelveNotice } = useConfirmedShelve(space)
  const pinned = space.pinnedAt !== null
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [people, setPeople] = useState(false)
  const { share, notice } = useShareLink(space.id)
  const isAdmin = space.role === 'admin'
  const close = (): void => {
    setAnchor(null)
  }
  const closePeople = (): void => {
    setPeople(false)
  }
  const item = (
    key: string,
    icon: typeof Dots,
    label: string,
    onClick: () => void,
    danger = false
  ) => (
    <MenuEntry
      key={key}
      icon={<Icon icon={icon} />}
      onClick={onClick}
      danger={danger}
    >
      {label}
    </MenuEntry>
  )

  return (
    <>
      <IconButton
        size="small"
        label={t('spaceMenu.open', { name: space.name })}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={event => {
          setAnchor(event.currentTarget)
        }}
      >
        <Icon icon={Dots} />
      </IconButton>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={close}>
        {item('share', Link, t('spaceMenu.shareLink'), () => {
          close()
          share()
        })}
        {item(
          'pin',
          Pin,
          t(pinned ? 'spaceMenu.unpin' : 'spaceMenu.pin'),
          () => {
            close()
            setPinned.mutate(!pinned)
          }
        )}
        <Divider />
        {item(
          'people',
          People,
          t(isAdmin ? 'spaceMenu.managePeople' : 'spaceMenu.members'),
          () => {
            close()
            setPeople(true)
          }
        )}
        {isAdmin &&
          item('manage', Settings, t('spaceMenu.manage'), () => {
            close()
            void navigate(`/spaces/${encodeURIComponent(space.id)}/settings`)
          })}
        {space.manages &&
          item('archive', Archive, t('spaceMenu.archive'), () => {
            close()
            ask('archived')
          })}
        {space.manages && <Divider />}
        {space.manages &&
          item(
            'delete',
            Trash,
            t('spaceActions.delete'),
            () => {
              close()
              ask('trashed')
            },
            true
          )}
      </Menu>
      {notice}
      {shelveNotice}
      {people && (
        <WithSpace spaceId={space.id} onClose={closePeople}>
          {full => <PeopleDialog space={full} onClose={closePeople} />}
        </WithSpace>
      )}
    </>
  )
}

// Archives a space, moves it to the Bin or restores it. Out of reach, it
// leaves its pages; a failure says so for a moment.
export function useShelve(id: string): {
  shelve: (state: ShelfState | 'active', settled?: () => void) => void
  pending: boolean
  notice: ReactElement
} {
  const { t } = useI18n()
  const setState = useSetState(id)
  const navigate = useNavigate()
  const inside = useMatch('/spaces/:spaceId/*')?.params.spaceId === id
  const [failed, setFailed] = useState(false)
  return {
    // Not mutate's own callbacks: they are dropped once the page unmounts.
    shelve: (state, settled) => {
      void setState.mutateAsync(state).then(
        () => {
          settled?.()
          if (inside && state !== 'active')
            void navigate('/', { replace: true })
        },
        () => {
          settled?.()
          setFailed(true)
        }
      )
    },
    pending: setState.isPending,
    notice: (
      <Snackbar
        open={failed}
        autoHideDuration={5000}
        onClose={() => {
          setFailed(false)
        }}
        message={t('shelves.moveFailed')}
      />
    )
  }
}

export function useConfirmedShelve(space: Named): {
  ask: (state: ShelfState) => void
  notice: ReactElement
} {
  const { t } = useI18n()
  const titleId = useId()
  const { shelve, pending, notice } = useShelve(space.id)
  // The state outlives the dialog's open flag, so its exit fade keeps its text.
  const [asked, setAsked] = useState<ShelfState>('archived')
  const [open, setOpen] = useState(false)
  const close = (): void => {
    setOpen(false)
  }
  const archiving = asked === 'archived'
  return {
    ask: state => {
      setAsked(state)
      setOpen(true)
    },
    notice: (
      <>
        {notice}
        <Dialog
          open={open}
          onClose={close}
          aria-labelledby={titleId}
          size="small"
        >
          <DialogHeader
            id={titleId}
            title={t(
              archiving
                ? 'spaceActions.archiveTitle'
                : 'spaceActions.trashTitle',
              { name: space.name }
            )}
            close={{ label: t('common.close'), onClick: close }}
          />
          <DialogContent>
            <Typography>
              {t(archiving ? 'settings.archiveHint' : 'settings.deleteHint')}
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button variant="text" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="contained"
              color={archiving ? 'primary' : 'error'}
              disabled={pending}
              onClick={() => {
                shelve(asked, close)
              }}
            >
              {t(archiving ? 'settings.archive' : 'shelves.moveToBin')}
            </Button>
          </DialogActions>
        </Dialog>
      </>
    )
  }
}

// The people picker needs who is already in: read the space first.
function WithSpace({
  spaceId,
  onClose,
  children
}: {
  spaceId: string
  onClose: () => void
  children: (space: Space) => ReactElement
}): ReactElement | null {
  const space = useSpace(spaceId)
  useEffect(() => {
    if (space.isError) onClose()
  }, [space.isError, onClose])
  if (!space.data) return null
  return children(space.data)
}

export function EditDialog({
  space,
  onClose
}: {
  space: Space
  onClose: () => void
}): ReactElement {
  const { t } = useI18n()
  const titleId = useId()
  const appsId = useId()
  const edit = useEditSpace(space.id)
  const offered = useSpaceApps()
  // A live update refetches the space while the dialog is open: compare with
  // what the form opened on, so another admin's change is not reverted.
  const [initial] = useState(space)
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  // Apps this deployment no longer provides stay picked, out of sight.
  const [apps, setApps] = useState<ReadonlySet<SpaceApp>>(
    () => new Set(initial.apps)
  )
  const trimmed = name.trim()
  const described = description.trim()
  const appsChanged =
    apps.size !== initial.apps.length ||
    initial.apps.some(app => !apps.has(app))
  const change: SpaceChange = {
    ...(trimmed !== initial.name && { name: trimmed }),
    ...(described !== initial.description && { description: described }),
    ...(appsChanged && { apps: [...apps] })
  }
  return (
    <Dialog open onClose={onClose} aria-labelledby={titleId} size="medium">
      <form
        onSubmit={event => {
          event.preventDefault()
          if (Object.keys(change).length === 0) onClose()
          else edit.mutate(change, { onSuccess: onClose })
        }}
      >
        <DialogHeader
          id={titleId}
          title={t('spaceActions.edit')}
          close={{ label: t('common.close'), onClick: onClose }}
        />
        <DialogContent>
          <Stack spacing={2}>
            <WriteError error={edit.error} />
            <TextField
              label={t('createSpace.name')}
              value={name}
              onChange={event => {
                setName(event.target.value)
              }}
              slotProps={{ htmlInput: { maxLength: 255 } }}
            />
            <TextField
              multiline
              minRows={3}
              label={t('settings.description')}
              placeholder={t('settings.descriptionHint')}
              value={description}
              onChange={event => {
                setDescription(event.target.value)
              }}
              slotProps={{ htmlInput: { maxLength: 1000 } }}
            />
            <Typography id={appsId} variant="subtitle1">
              {t('createSpace.apps')}
            </Typography>
            <AppPicker
              provided={offered.data ?? []}
              picked={apps}
              onChange={setApps}
              labelledBy={appsId}
            />
            {offered.isError && (
              <Alert severity="error">{t('createSpace.appsFailed')}</Alert>
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
            disabled={trimmed === '' || edit.isPending}
          >
            {t('common.save')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}

// Deletes a space in the Bin for good, in every app.
export function DeleteDialog({
  space,
  onClose
}: {
  space: Named
  onClose: () => void
}): ReactElement {
  const { t } = useI18n()
  const titleId = useId()
  const remove = useDeleteSpace(space.id)
  return (
    <Dialog open onClose={onClose} aria-labelledby={titleId} size="small">
      <DialogHeader
        id={titleId}
        title={t('spaceActions.deleteTitle', { name: space.name })}
        close={{ label: t('common.close'), onClick: onClose }}
      />
      <DialogContent>
        <Stack spacing={2}>
          <WriteError error={remove.error} />
          <Typography>{t('spaceActions.deleteHint')}</Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button variant="text" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={remove.isPending}
          onClick={() => {
            remove.mutate(undefined, { onSuccess: onClose })
          }}
        >
          {t('shelves.deleteForever')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
