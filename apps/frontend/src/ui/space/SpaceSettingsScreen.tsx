import {
  Archive,
  CrossCircleOutline,
  Icon,
  Key,
  List as ListIcon,
  Pen,
  PersonAdd,
  Previous,
  Team,
  Text,
  Trash
} from '@linagora/twake-icons'
import {
  Alert,
  Avatar,
  Button,
  Chip,
  Dialog,
  DialogContent,
  IconButton,
  Link,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Stack,
  Switch,
  Tab,
  Tabs,
  Typography
} from '@linagora/twake-mui'
import { useId, useState, type ReactElement, type ReactNode } from 'react'
import { Link as RouterLink, useParams } from 'react-router'

import { avatarUrl } from '@/application/avatar'
import {
  isRefusal,
  SPACE_ROLES,
  type Space,
  type SpaceApp,
  type SpaceRole,
  type SpacesService
} from '@/application/spaces'
import { TABS } from '@/application/spaceTabs'
import { NameAvatar } from '@/ds/AppFrame'
import { CountedLabel } from '@/ds/CountedLabel'
import { DialogHeader } from '@/ds/Dialog'
import { LoadingRows, Page } from '@/ds/Page'
import { useI18n } from '@/ui/i18n/useI18n'
import { useSession } from '@/ui/session/SessionGate'
import { AddPeopleRow } from '@/ui/space/PeopleDialog'
import { RoleMenu } from '@/ui/space/RoleMenu'
import { EditDialog, useConfirmedShelve } from '@/ui/space/SpaceMenu'
import { WriteError } from '@/ui/space/WriteError'
import { AppIcon } from '@/ui/spaces/AppPicker'
import {
  useEditSpace,
  useSpace,
  useSpaceApps,
  useSpaceWrite
} from '@/ui/spaces/queries'
import { useDocumentTitle } from '@/ui/useDocumentTitle'

type RoleFilter = 'all' | SpaceRole

const ADMIN_FIRST = [...SPACE_ROLES].reverse()

// A person or a linked group, as one list shows them.
interface Row {
  kind: 'member' | 'group'
  id: string
  name: string
  detail: string
  role: SpaceRole
  avatar: string | null
}

// The management page of a space, for its admins. The mockup's access and
// notification settings, and the color edit, wait for their backend.
export function SpaceSettingsScreen(): ReactElement {
  const { t } = useI18n()
  const { spaceId = '' } = useParams()
  const space = useSpace(spaceId)
  useDocumentTitle(space.data?.name ?? null)
  const back = (
    <Link component={RouterLink} to={`/spaces/${encodeURIComponent(spaceId)}`}>
      {t('common.back')}
    </Link>
  )

  if (space.isPending) {
    return (
      <Page>
        <LoadingRows count={3} label={t('space.loading')} />
      </Page>
    )
  }
  if (space.isError) {
    return (
      <Page>
        <Alert severity="error" className="u-mb-1">
          {t(
            isRefusal(space.error) && space.error.status === 404
              ? 'space.notFound'
              : 'space.loadFailed'
          )}
        </Alert>
        {back}
      </Page>
    )
  }
  if (space.data.role !== 'admin') {
    return (
      <Page>
        <Alert severity="info" className="u-mb-1">
          {t('settings.adminsOnly')}
        </Alert>
        {back}
      </Page>
    )
  }
  return <Settings space={space.data} />
}

function Settings({ space }: { space: Space }): ReactElement {
  const { t } = useI18n()
  const { ask, notice } = useConfirmedShelve(space)
  const [dialog, setDialog] = useState<'edit' | 'add' | null>(null)
  const closeDialog = (): void => {
    setDialog(null)
  }

  return (
    <Page>
      <Link
        component={RouterLink}
        to={`/spaces/${encodeURIComponent(space.id)}`}
        underline="none"
        className="u-inline-flex u-flex-items-center u-flex-self-start u-mb-1"
      >
        <Icon icon={Previous} className="u-mr-half" />
        {t('common.back')}
      </Link>
      <div className="u-flex u-flex-items-center u-flex-wrap u-mb-1">
        <NameAvatar name={space.name} color={space.color} size="l" />
        <Typography
          variant="h5"
          component="h1"
          noWrap
          className="u-ml-1 u-flex-auto"
        >
          {space.name}
        </Typography>
        <Stack direction="row" spacing={1} className="u-ml-auto">
          <Button
            variant="outlined"
            startIcon={<Icon icon={Pen} />}
            onClick={() => {
              setDialog('edit')
            }}
          >
            {t('settings.edit')}
          </Button>
          <Button
            variant="outlined"
            startIcon={<Icon icon={Archive} />}
            onClick={() => {
              ask('archived')
            }}
          >
            {t('settings.archive')}
          </Button>
          <Button
            variant="outlined"
            startIcon={<Icon icon={Trash} />}
            onClick={() => {
              ask('trashed')
            }}
          >
            {t('common.delete')}
          </Button>
        </Stack>
      </div>

      <Section title={t('settings.personalization')}>
        <List className="u-maw-7">
          <ListItem gutters="disabled">
            <ListItemIcon>
              <Icon icon={Text} />
            </ListItemIcon>
            <ListItemText
              primary={t('settings.description')}
              secondary={space.description || t('settings.descriptionHint')}
            />
          </ListItem>
        </List>
      </Section>

      <Section
        title={t('settings.members')}
        hint={t('settings.membersHint')}
        action={
          <Button
            variant="outlined"
            startIcon={<Icon icon={PersonAdd} />}
            onClick={() => {
              setDialog('add')
            }}
          >
            {t('settings.addMembers')}
          </Button>
        }
      >
        <Members space={space} />
      </Section>

      <Section title={t('settings.apps')} hint={<AppsCount space={space} />}>
        <Apps space={space} />
      </Section>

      <Section title={t('settings.dangerZone')}>
        <List className="u-maw-7">
          <ListItem gutters="disabled">
            <ListItemIcon>
              <Icon icon={Key} />
            </ListItemIcon>
            <ListItemText
              primary={t('apiTokens.title')}
              secondary={t('settings.apiTokensHint')}
            />
            <Button
              component={RouterLink}
              to={`/settings/api-tokens?space=${encodeURIComponent(space.id)}`}
              variant="outlined"
              className="u-flex-none u-ml-1"
            >
              {t('settings.manage')}
            </Button>
          </ListItem>
          <ListItem gutters="disabled">
            <ListItemIcon>
              <Icon icon={Archive} />
            </ListItemIcon>
            <ListItemText
              primary={t('settings.archiveSpace')}
              secondary={t('settings.archiveHint')}
            />
            <Button
              variant="outlined"
              className="u-flex-none u-ml-1"
              onClick={() => {
                ask('archived')
              }}
            >
              {t('settings.archive')}
            </Button>
          </ListItem>
          <ListItem gutters="disabled">
            <ListItemIcon className="u-error">
              <Icon icon={Trash} />
            </ListItemIcon>
            <ListItemText
              primary={t('spaceActions.delete')}
              secondary={t('settings.deleteHint')}
            />
            <Button
              variant="outlined"
              color="error"
              className="u-flex-none u-ml-1"
              onClick={() => {
                ask('trashed')
              }}
            >
              {t('common.delete')}
            </Button>
          </ListItem>
        </List>
      </Section>

      {dialog === 'edit' && <EditDialog space={space} onClose={closeDialog} />}
      {dialog === 'add' && (
        <AddMembersDialog space={space} onClose={closeDialog} />
      )}
      {notice}
    </Page>
  )
}

function Section({
  title,
  hint,
  action,
  children
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
}): ReactElement {
  const id = useId()
  return (
    <section aria-labelledby={id} className="u-mt-1-half">
      <div className="u-flex u-flex-items-start u-flex-justify-between u-flex-wrap">
        <div className="u-mb-half">
          <Typography id={id} variant="h5" component="h2">
            {title}
          </Typography>
          {hint && (
            <Typography variant="caption" color="textSecondary" component="p">
              {hint}
            </Typography>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function Members({ space }: { space: Space }): ReactElement {
  const { t } = useI18n()
  const { user } = useSession()
  const write = useSpaceWrite(space.id)
  const [filter, setFilter] = useState<RoleFilter>('all')
  const run = (change: (spaces: SpacesService) => Promise<void>): void => {
    write.mutate(change)
  }
  const rows: Row[] = [
    ...space.members.map(m => ({
      kind: 'member' as const,
      id: m.id,
      name: m.displayName ?? m.username,
      detail: m.email,
      role: m.role,
      avatar: avatarUrl(m.workplaceFqdn)
    })),
    ...space.groups.map(g => ({
      kind: 'group' as const,
      id: g.id,
      name: g.name,
      detail: t('members.group'),
      role: g.role,
      avatar: null
    }))
  ]
  const shown = filter === 'all' ? rows : rows.filter(r => r.role === filter)
  const tab = (value: RoleFilter, label: string, count: number) => (
    <Tab
      key={value}
      value={value}
      label={
        <span className="u-inline-flex u-flex-items-center">
          <CountedLabel label={label} count={String(count)} />
        </span>
      }
      aria-label={`${label}, ${String(count)}`}
    />
  )

  return (
    <div className="u-maw-7">
      <WriteError error={write.error} className="u-mb-1" />
      <Tabs
        narrowed
        value={filter}
        onChange={(_event, value: RoleFilter) => {
          setFilter(value)
        }}
      >
        {tab('all', t('settings.all'), rows.length)}
        {ADMIN_FIRST.map(role =>
          tab(
            role,
            t(`roles.${role}`),
            rows.filter(r => r.role === role).length
          )
        )}
      </Tabs>
      {shown.length === 0 ? (
        <Typography color="textSecondary" className="u-mt-1">
          {t('settings.noOne')}
        </Typography>
      ) : (
        <List aria-label={t('settings.members')}>
          {shown.map(row => {
            const me = row.kind === 'member' && row.id === user.id
            return (
              <ListItem key={`${row.kind}:${row.id}`} size="small">
                <ListItemIcon>
                  {row.kind === 'member' ? (
                    <NameAvatar name={row.name} size="m" src={row.avatar} />
                  ) : (
                    <Avatar size="m" border aria-hidden>
                      <Icon icon={Team} />
                    </Avatar>
                  )}
                </ListItemIcon>
                <ListItemText
                  primary={me ? t('settings.you') : row.name}
                  secondary={row.detail}
                  slotProps={{
                    primary: { noWrap: true },
                    secondary: { noWrap: true }
                  }}
                />
                <Stack
                  direction="row"
                  spacing={1}
                  className="u-flex-items-center u-flex-none u-ml-half"
                >
                  {me ? (
                    <Chip
                      label={t(`roles.${row.role}`)}
                      size="small"
                      variant="outlined"
                    />
                  ) : (
                    <>
                      <RoleMenu
                        label={t('members.roleOf', { name: row.name })}
                        value={row.role}
                        onChange={role => {
                          run(s =>
                            row.kind === 'member'
                              ? s.setMemberRole(space.id, row.id, role)
                              : s.setGroupRole(space.id, row.id, role)
                          )
                        }}
                      />
                      <IconButton
                        size="small"
                        aria-label={t(
                          row.kind === 'member'
                            ? 'members.remove'
                            : 'members.unlink',
                          { name: row.name }
                        )}
                        onClick={() => {
                          run(s =>
                            row.kind === 'member'
                              ? s.removeMember(space.id, row.id)
                              : s.unlinkGroup(space.id, row.id)
                          )
                        }}
                      >
                        <Icon icon={CrossCircleOutline} />
                      </IconButton>
                    </>
                  )}
                </Stack>
              </ListItem>
            )
          })}
        </List>
      )}
    </div>
  )
}

// The feed and the apps this deployment provides; the feed is always on.
function useAppTabs(space: Space) {
  const offered = useSpaceApps()
  const provided = offered.data ?? []
  const tabs = TABS.filter(
    (tab): tab is 'feed' | SpaceApp =>
      tab === 'feed' || (tab !== 'home' && provided.includes(tab))
  )
  const isOn = (tab: 'feed' | SpaceApp): boolean =>
    tab === 'feed' || space.apps.includes(tab)
  return { tabs, isOn, failed: offered.isError }
}

function AppsCount({ space }: { space: Space }): ReactElement {
  const { t } = useI18n()
  const { tabs, isOn } = useAppTabs(space)
  return (
    <>
      {t('settings.appsCount', {
        on: tabs.filter(isOn).length,
        total: tabs.length
      })}
    </>
  )
}

function Apps({ space }: { space: Space }): ReactElement {
  const { t } = useI18n()
  const { tabs, isOn, failed } = useAppTabs(space)
  const edit = useEditSpace(space.id)
  // Apps this deployment no longer provides stay picked, out of sight.
  const toggle = (app: SpaceApp, checked: boolean): void => {
    edit.mutate({
      apps: checked
        ? [...space.apps, app]
        : space.apps.filter(picked => picked !== app)
    })
  }

  return (
    <div className="u-maw-7">
      <WriteError error={edit.error} className="u-mb-1" />
      {failed && (
        <Alert severity="error" className="u-mb-1">
          {t('createSpace.appsFailed')}
        </Alert>
      )}
      <List>
        {tabs.map(tab => {
          const name = t(`tabs.${tab}`)
          return (
            <ListItem key={tab} gutters="disabled">
              <ListItemIcon>
                {tab === 'feed' ? (
                  <Icon icon={ListIcon} size={24} />
                ) : (
                  <AppIcon app={tab} />
                )}
              </ListItemIcon>
              <ListItemText
                primary={name}
                secondary={t(`settings.appHint.${tab}`)}
              />
              <Switch
                checked={isOn(tab)}
                disabled={tab === 'feed' || edit.isPending}
                onChange={(_event, checked) => {
                  if (tab !== 'feed') toggle(tab, checked)
                }}
                slotProps={{ input: { 'aria-label': name } }}
              />
            </ListItem>
          )
        })}
      </List>
    </div>
  )
}

function AddMembersDialog({
  space,
  onClose
}: {
  space: Space
  onClose: () => void
}): ReactElement {
  const { t } = useI18n()
  const titleId = useId()
  const write = useSpaceWrite(space.id)
  return (
    <Dialog open onClose={onClose} aria-labelledby={titleId} size="medium">
      <DialogHeader
        id={titleId}
        title={t('settings.addMembers')}
        close={{ label: t('common.close'), onClick: onClose }}
      />
      <DialogContent>
        <Stack spacing={2}>
          <WriteError error={write.error} />
          <AddPeopleRow space={space} write={write} />
        </Stack>
      </DialogContent>
    </Dialog>
  )
}
