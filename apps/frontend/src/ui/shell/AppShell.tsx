import { Archive, Icon, Trash } from '@linagora/twake-icons'
import {
  List,
  ListItem,
  ListItemText,
  NavIcon,
  NavItem,
  NavText,
  SearchBar,
  IconButton
} from '@linagora/twake-mui'
import { useState, type ReactElement, type ReactNode } from 'react'
import { Outlet, NavLink as RouterNavLink, useMatch } from 'react-router'

import { badgeLabel } from '@/application/badges'
import {
  nameMatches,
  pinnedAndRecent,
  type SpaceSummary
} from '@/application/spaces'
import {
  AppFrame,
  NavAvatar,
  SidebarDivider,
  SidebarHeader,
  SidebarNav,
  SidebarSearch,
  SidebarSection
} from '@/ds/AppFrame'
import { FilterListIcon } from '@/ds/FilterListIcon'
import { AddIcon, SpaceCubeIcon } from '@/ds/icons'
import { NavDestination } from '@/ds/NavDestination'
import { AssistantContext, AssistantPanel } from '@/ui/assistant/AssistantPanel'
import { CallProvider } from '@/ui/call/CallContext'
import { CallWindow } from '@/ui/call/CallWindow'
import { Suggestions } from '@/ui/assistant/Suggestions'
import { AppFeedback } from '@/ui/feedback/AppFeedback'
import { useI18n } from '@/ui/i18n/useI18n'
import { CreateSpaceDialog } from '@/ui/home/CreateSpaceDialog'
import { PlatformBar } from '@/ui/shell/PlatformBar'
import { SpotSpace } from '@/ui/shell/SpotSpace'
import { useSpaceTotals } from '@/ui/space/Badges'
import { EmbeddedApps } from '@/ui/space/EmbeddedApps'
import { useFillPage } from '@/ui/space/FillPage'
import { useSession } from '@/ui/session/SessionGate'
import { useSpaceList } from '@/ui/spaces/queries'
import { NotificationPermissionPrompt } from '@/ui/shell/NotificationPermissionPrompt'

export function AppShell(): ReactElement {
  const { t } = useI18n()
  const { sdk } = useSession()
  const [creating, setCreating] = useState(false)
  // Null while the search is closed.
  const [query, setQuery] = useState<string | null>(null)
  const home = useMatch('/') !== null
  // The assistant is a space's: it shows beside a space, and stays open
  // from one space to the next.
  const [assistantOpen, setAssistantOpen] = useState(false)
  const spaceId = useMatch('/spaces/:spaceId/*')?.params.spaceId
  // A space's content may take the whole page, the platform bar's too
  const alone = useFillPage().space !== null

  return (
    <CallProvider>
      <AppFrame
        // Without a platform client there is no bar, and no room to leave for it
        topBar={sdk ? <PlatformBar /> : undefined}
        bare={home}
        alone={alone}
        aside={
          assistantOpen &&
          spaceId !== undefined && (
            <AssistantPanel
              spaceId={spaceId}
              onClose={() => {
                setAssistantOpen(false)
              }}
            />
          )
        }
        sidebar={
          <>
            <SidebarHeader
              title={t('shell.title')}
              action={
                <>
                  <IconButton
                    size="medium"
                    aria-label={t('shell.searchSpaces')}
                    aria-pressed={query !== null}
                    onClick={() => {
                      setQuery(query === null ? '' : null)
                    }}
                  >
                    <Icon icon={FilterListIcon} size={24} />
                  </IconButton>
                  <IconButton
                    size="medium"
                    color="primary"
                    aria-label={t('spaces.create')}
                    onClick={() => {
                      setCreating(true)
                    }}
                  >
                    <Icon icon={AddIcon} size={24} />
                  </IconButton>
                </>
              }
            />
            {query !== null && (
              <SidebarSearch>
                <SearchBar
                  elevation={0}
                  placeholder={t('shell.spaceName')}
                  value={query}
                  onChange={event => {
                    setQuery(event.target.value)
                  }}
                  onClear={() => {
                    setQuery('')
                  }}
                  componentsProps={{
                    inputBase: {
                      autoFocus: true,
                      onKeyDown: event => {
                        if (event.key === 'Escape') setQuery(null)
                      }
                    }
                  }}
                />
              </SidebarSearch>
            )}
            <AppNav />
            <SpaceList query={query ?? ''} />
            <ShelfLinks />
          </>
        }
      >
        <AssistantContext
          value={{ open: assistantOpen, setOpen: setAssistantOpen }}
        >
          <Outlet />
        </AssistantContext>
        <EmbeddedApps />
        <SpotSpace />
        <NotificationPermissionPrompt />
        <CallWindow />
        <AppFeedback />
        <Suggestions />
        {creating && (
          <CreateSpaceDialog
            onClose={() => {
              setCreating(false)
            }}
          />
        )}
      </AppFrame>
    </CallProvider>
  )
}

function RouteNavLink({
  to,
  end = false,
  label,
  children
}: {
  to: string
  end?: boolean
  // Names the link, when its text alone does not
  label?: string | undefined
  children: ReactNode
}): ReactElement {
  const selected = useMatch({ path: to, end }) !== null

  return (
    <NavDestination
      link={RouterNavLink}
      linkProps={{ to, end, 'aria-label': label }}
      selected={selected}
    >
      {children}
    </NavDestination>
  )
}

function AppNav(): ReactElement {
  const { t } = useI18n()

  return (
    <SidebarNav>
      <NavItem>
        <RouteNavLink to="/" end>
          <NavIcon icon={SpaceCubeIcon} />
          <NavText>{t('shell.allSpaces')}</NavText>
        </RouteNavLink>
      </NavItem>
    </SidebarNav>
  )
}

// Pinned and Recent, or every space whose name holds the filter while one is
// typed.
function SpaceList({ query }: { query: string }): ReactElement | null {
  const { t } = useI18n()
  const spaces = useSpaceList().data ?? []
  const totals = useSpaceTotals(spaces)
  if (spaces.length === 0) return null

  if (query.trim() !== '') {
    const found = spaces.filter(space => nameMatches(space.name, query))
    return (
      <SidebarSection label={t('shell.yourSpaces')}>
        {found.length === 0 && <Hint text={t('shell.noSpaceFound')} />}
        <SpaceLinks spaces={found} totals={totals} />
      </SidebarSection>
    )
  }

  // Recent shows even empty, with a hint, so people learn it exists.
  const { pinned, recent } = pinnedAndRecent(spaces)
  return (
    <>
      {pinned.length > 0 && (
        <SidebarSection label={t('shell.pinned')}>
          <SpaceLinks spaces={pinned} totals={totals} />
        </SidebarSection>
      )}
      <SidebarSection label={t('shell.recent')}>
        {recent.length === 0 && <Hint text={t('shell.noRecent')} />}
        <SpaceLinks spaces={recent} totals={totals} />
      </SidebarSection>
    </>
  )
}

function Hint({ text }: { text: string }): ReactElement {
  return (
    <ListItem>
      <ListItemText secondary={text} />
    </ListItem>
  )
}

function ShelfLinks(): ReactElement {
  const { t } = useI18n()
  return (
    <>
      <SidebarDivider />
      <List aria-label={t('shell.shelves')}>
        <NavItem>
          <RouteNavLink to="/archives">
            <NavIcon icon={Archive} />
            <NavText>{t('shell.archives')}</NavText>
          </RouteNavLink>
        </NavItem>
        <NavItem>
          <RouteNavLink to="/bin">
            <NavIcon icon={Trash} />
            <NavText>{t('shell.bin')}</NavText>
          </RouteNavLink>
        </NavItem>
      </List>
    </>
  )
}

function SpaceLinks({
  spaces,
  totals
}: {
  spaces: SpaceSummary[]
  totals: Map<string, number>
}): ReactElement {
  const { t } = useI18n()
  return (
    <>
      {spaces.map(space => {
        const total = totals.get(space.id) ?? 0
        return (
          <NavItem key={space.id} badge={badgeLabel(total)}>
            <RouteNavLink
              to={`/spaces/${space.id}`}
              label={
                total > 0
                  ? t('shell.spaceWithCount', {
                      name: space.name,
                      smart_count: total
                    })
                  : undefined
              }
            >
              <NavAvatar name={space.name} color={space.color} />
              <NavText>{space.name}</NavText>
            </RouteNavLink>
          </NavItem>
        )
      })}
    </>
  )
}
