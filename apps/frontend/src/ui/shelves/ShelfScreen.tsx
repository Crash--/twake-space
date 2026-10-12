import { Archive, Dots, Icon, Restore, Trash } from '@linagora/twake-icons'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  Divider,
  IconButton,
  Menu,
  Stack,
  Typography
} from '@linagora/twake-mui'
import { useId, useState, type ReactElement } from 'react'

import { avatarUrl } from '@/application/avatar'
import type { ShelfState, ShelvedSpace } from '@/application/spaces'
import { NameAvatar } from '@/ds/AppFrame'
import { CardGrid, MemberAvatars, SpaceCard } from '@/ds/Card'
import { DialogHeader } from '@/ds/Dialog'
import { MenuEntry } from '@/ds/Menu'
import { IconEmpty, LoadingRows, Page } from '@/ds/Page'
import { useI18n } from '@/ui/i18n/useI18n'
import { DeleteDialog, useShelve } from '@/ui/space/SpaceMenu'
import { WriteError } from '@/ui/space/WriteError'
import { useEmptyBin, useShelved } from '@/ui/spaces/queries'
import { useDocumentTitle } from '@/ui/useDocumentTitle'

const TEXTS = {
  archived: {
    title: 'shelves.archives',
    intro: 'shelves.archivesIntro',
    empty: 'shelves.noArchives',
    emptyIcon: Archive
  },
  trashed: {
    title: 'shelves.bin',
    intro: 'shelves.binIntro',
    empty: 'shelves.binIsEmpty',
    emptyIcon: Trash
  }
} as const

// The archived spaces, or those in the Bin, that the person manages. A card
// opens nothing: the space is out of reach until it is restored.
export function ShelfScreen({ state }: { state: ShelfState }): ReactElement {
  const { t } = useI18n()
  const spaces = useShelved(state)
  const texts = TEXTS[state]
  const [emptying, setEmptying] = useState(false)
  useDocumentTitle(t(texts.title))

  return (
    <Page>
      <Typography variant="h3" component="h1">
        {t(texts.title)}
      </Typography>
      <div className="u-flex u-flex-items-center u-flex-wrap u-mt-half u-mb-1">
        <Typography color="textSecondary" className="u-flex-auto u-maw-7">
          {t(texts.intro)}
        </Typography>
        {state === 'trashed' && spaces.data && spaces.data.length > 0 && (
          <Button
            variant="outlined"
            color="error"
            className="u-flex-none"
            onClick={() => {
              setEmptying(true)
            }}
          >
            {t('shelves.emptyTheBin')}
          </Button>
        )}
      </div>
      {spaces.isPending && (
        <LoadingRows count={3} label={t('spaces.loading')} />
      )}
      {spaces.isError && (
        <Alert severity="error">{t('spaces.loadFailed')}</Alert>
      )}
      {spaces.data?.length === 0 && (
        <IconEmpty icon={texts.emptyIcon} title={t(texts.empty)} />
      )}
      {spaces.data && spaces.data.length > 0 && (
        <CardGrid>
          {spaces.data.map(space => (
            <SpaceCard
              key={space.id}
              avatar={
                <NameAvatar name={space.name} color={space.color} size="s" />
              }
              link={space.name}
              description={space.description}
              members={
                space.members.length > 0 && (
                  <MemberAvatars
                    members={space.members.map(member => ({
                      id: member.id,
                      name: member.displayName ?? member.username,
                      src: avatarUrl(member.workplaceFqdn)
                    }))}
                  />
                )
              }
              menu={<ShelfMenu space={space} state={state} />}
            />
          ))}
        </CardGrid>
      )}
      {emptying && (
        <EmptyBinDialog
          onClose={() => {
            setEmptying(false)
          }}
        />
      )}
    </Page>
  )
}

function ShelfMenu({
  space,
  state
}: {
  space: ShelvedSpace
  state: ShelfState
}): ReactElement {
  const { t } = useI18n()
  const { shelve, notice } = useShelve(space.id)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [deleting, setDeleting] = useState(false)
  const close = (): void => {
    setAnchor(null)
  }

  return (
    <>
      <IconButton
        size="small"
        aria-label={t('spaceMenu.open', { name: space.name })}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={event => {
          setAnchor(event.currentTarget)
        }}
      >
        <Icon icon={Dots} />
      </IconButton>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={close}>
        <MenuEntry
          icon={<Icon icon={Restore} />}
          onClick={() => {
            close()
            shelve('active')
          }}
        >
          {t('shelves.restore')}
        </MenuEntry>
        <Divider />
        {state === 'archived' ? (
          <MenuEntry
            icon={<Icon icon={Trash} />}
            onClick={() => {
              close()
              shelve('trashed')
            }}
          >
            {t('shelves.moveToBin')}
          </MenuEntry>
        ) : (
          <MenuEntry
            icon={<Icon icon={Trash} />}
            danger
            onClick={() => {
              close()
              setDeleting(true)
            }}
          >
            {t('shelves.deleteForever')}
          </MenuEntry>
        )}
      </Menu>
      {notice}
      {deleting && (
        <DeleteDialog
          space={space}
          onClose={() => {
            setDeleting(false)
          }}
        />
      )}
    </>
  )
}

function EmptyBinDialog({ onClose }: { onClose: () => void }): ReactElement {
  const { t } = useI18n()
  const titleId = useId()
  const empty = useEmptyBin()
  return (
    <Dialog open onClose={onClose} aria-labelledby={titleId} size="small">
      <DialogHeader
        id={titleId}
        title={t('shelves.emptyTitle')}
        close={{ label: t('common.close'), onClick: onClose }}
      />
      <DialogContent>
        <Stack spacing={2}>
          <WriteError error={empty.error} />
          <Typography>{t('shelves.emptyHint')}</Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button variant="text" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={empty.isPending}
          onClick={() => {
            empty.mutate(undefined, { onSuccess: onClose })
          }}
        >
          {t('shelves.emptyTheBin')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
