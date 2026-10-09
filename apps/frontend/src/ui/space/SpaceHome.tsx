import { Button } from '@linagora/twake-mui'
import { useEffect, useState, type ReactElement } from 'react'
import { Link as RouterLink } from 'react-router'

import { avatarUrl } from '@/application/avatar'
import { badgeLabel, tabCount } from '@/application/badges'
import {
  HOME_FIGURES,
  homeFigure,
  type HomeFigure
} from '@/application/metadata'
import type { Space, SpaceApp } from '@/application/spaces'
import type { Tab, TabState } from '@/application/spaceTabs'
import chatArt from '@/assets/home-chat.svg'
import driveArt from '@/assets/home-drive.svg'
import mailArt from '@/assets/home-mail.svg'
import tasksArt from '@/assets/home-tasks.svg'
import {
  AppArt,
  AppCard,
  CalendarLeaf,
  MemberAvatars,
  Tile,
  TileGrid,
  TileNumber,
  TileRow
} from '@/ds/Card'
import { ScrollPanel, SpaceCover } from '@/ds/Page'
import { useGreeting } from '@/ui/home/Greeting'
import { useI18n } from '@/ui/i18n/useI18n'
import { useBadges, useMetadata } from '@/ui/space/Badges'
import { BannerButton } from '@/ui/space/BannerButton'
import { PeopleDialog } from '@/ui/space/PeopleDialog'
import { useCommonSettings } from '@/ui/settings/useCommonSettings'
import { AppIcon } from '@/ui/spaces/AppPicker'
import { useBanner } from '@/ui/spaces/queries'

// In the mockup's order
const CARDS: readonly SpaceApp[] = [
  'calendar',
  'mail',
  'chat',
  'drive',
  'tasks'
]

const FIGURES: readonly HomeFigure[] = ['tasks', 'files', 'events']

// How long the home waits for an app's figure before it gives up on it
const FIGURE_WAIT_MS = 10_000

const NO_FIGURE = '–'

const ART: Record<Exclude<SpaceApp, 'calendar'>, string> = {
  mail: mailArt,
  chat: chatArt,
  drive: driveArt,
  tasks: tasksArt
}

function Today(): ReactElement {
  const { lang } = useI18n()
  const { settings } = useCommonSettings()
  const timeZone = settings.timezone ?? undefined
  const now = new Date()
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(lang, { ...options, timeZone }).format(now)
  return (
    <CalendarLeaf
      weekday={part({ weekday: 'long' })}
      day={part({ day: 'numeric' })}
      month={part({ month: 'long' })}
    />
  )
}

export function SpaceHome({
  space,
  tabs
}: {
  space: Space
  tabs: { tab: Tab; state: TabState }[]
}): ReactElement {
  const { t, lang } = useI18n()
  const badges = useBadges()
  const metadata = useMetadata()
  const banner = useBanner(space)
  const { date, greeting } = useGreeting()
  const [managing, setManaging] = useState(false)
  const stateOf = (app: SpaceApp) => tabs.find(item => item.tab === app)?.state
  // The wait starts over for another space, or an app that gets ready
  const waiting = [
    space.id,
    ...FIGURES.filter(figure => stateOf(HOME_FIGURES[figure].app) === 'ready')
  ].join()
  const [waited, setWaited] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => {
      setWaited(waiting)
    }, FIGURE_WAIT_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [waiting])
  const apps = CARDS.flatMap(app => {
    const state = stateOf(app)
    return state ? [{ app, state }] : []
  })
  // A placeholder while the app may still report the figure
  const shown = (figure: HomeFigure, state: TabState) => {
    if (state === 'preparing') return null
    const value = state === 'ready' ? homeFigure(metadata, space, figure) : null
    if (value === undefined) return waited === waiting ? NO_FIGURE : null
    if (value === null) return NO_FIGURE
    return figure === 'tasks'
      ? new Intl.NumberFormat(lang, { style: 'percent' }).format(value / 100)
      : value
  }
  const figures = FIGURES.flatMap(figure => {
    const state = stateOf(HOME_FIGURES[figure].app)
    return state === undefined || state === 'off'
      ? []
      : [{ figure, shown: shown(figure, state) }]
  })
  const members = space.members.length

  return (
    <ScrollPanel>
      <SpaceCover
        src={banner}
        action={space.role === 'admin' && <BannerButton spaceId={space.id} />}
        date={date}
        title={greeting}
      />
      <TileRow>
        {figures.map(({ figure, shown }) => (
          <Tile key={figure}>
            <TileNumber
              value={shown}
              label={t(`spaceHome.figures.${figure}`)}
            />
          </Tile>
        ))}
        <Tile wide>
          <TileNumber
            value={members}
            label={t('spaceHome.users', { smart_count: members })}
          />
          {members > 0 && (
            <MemberAvatars
              size="m"
              members={space.members.map(member => ({
                id: member.id,
                name: member.displayName ?? member.username,
                src: avatarUrl(member.workplaceFqdn)
              }))}
            />
          )}
          {space.role === 'admin' && (
            <Button
              variant="outlined"
              onClick={() => {
                setManaging(true)
              }}
            >
              {t('spaceHome.manageUsers')}
            </Button>
          )}
        </Tile>
      </TileRow>
      <TileGrid min={320}>
        {apps.map(({ app, state }) => {
          const name = t(`spaceHome.app.${app}.name`)
          const open = t(`spaceHome.app.${app}.open`)
          const count = tabCount(badges, space, app)
          return (
            <AppCard
              key={app}
              visual={
                app === 'calendar' ? <Today /> : <AppArt src={ART[app]} />
              }
              icon={<AppIcon app={app} size={16} />}
              name={name}
              nameLabel={
                count > 0
                  ? t('tabs.withCount', { app: name, smart_count: count })
                  : undefined
              }
              count={badgeLabel(count)}
              description={t(`spaceHome.app.${app}.description`)}
              action={
                state === 'off' ? (
                  <Button variant="outlined" disabled>
                    {open}
                  </Button>
                ) : (
                  <Button
                    variant="outlined"
                    component={RouterLink}
                    to={`/spaces/${space.id}/${app}`}
                  >
                    {open}
                  </Button>
                )
              }
            />
          )
        })}
      </TileGrid>
      {managing && (
        <PeopleDialog
          space={space}
          onClose={() => {
            setManaging(false)
          }}
        />
      )}
    </ScrollPanel>
  )
}
