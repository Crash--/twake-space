import { Icon } from '@linagora/twake-icons'
import { Alert, Button, Link, Tab, Tabs, Typography } from '@linagora/twake-mui'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement
} from 'react'
import {
  Navigate,
  Link as RouterLink,
  useNavigate,
  useParams
} from 'react-router'

import { badgeLabel, tabCount } from '@/application/badges'
import { embeddedApp } from '@/application/embeddedApps'
import { isRefusal } from '@/application/spaces'
import { PREPARING_MS, spaceTabs } from '@/application/spaceTabs'
import { NameAvatar } from '@/ds/AppFrame'
import { CountedLabel } from '@/ds/CountedLabel'
import { IconButton } from '@/ds/IconButton'
import { CloseFullscreenIcon, Home, OpenInFullIcon } from '@/ds/icons'
import {
  CompactSpaceHeader,
  LoadingRows,
  Page,
  SpaceHeader,
  TabPanel
} from '@/ds/Page'
import { useAssistant } from '@/ui/assistant/AssistantPanel'
import { useSpaceTabTag } from '@/ui/feedback/useSpaceTabTag'
import { useI18n } from '@/ui/i18n/useI18n'
import { useBadges } from '@/ui/space/Badges'
import { useAppUrls } from '@/ui/space/useAppUrls'
import { FeedPanel } from '@/ui/space/FeedPanel'
import { FeedSearch } from '@/ui/space/FeedSearch'
import { useFillPage } from '@/ui/space/FillPage'
import { SpaceActions } from '@/ui/space/SpaceActions'
import { SpaceHome } from '@/ui/space/SpaceHome'
import { useMarkOpened, useSpace } from '@/ui/spaces/queries'
import { useDocumentTitle } from '@/ui/useDocumentTitle'

function useNowAfter(at: number): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setTimeout(
      () => {
        setNow(Date.now())
      },
      Math.max(0, at - Date.now())
    )
    return () => {
      clearTimeout(timer)
    }
  }, [at])
  return now
}

export function SpaceScreen(): ReactElement {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { spaceId = '', tab } = useParams()
  const badges = useBadges()
  const space = useSpace(spaceId)
  const appUrls = useAppUrls(space.data?.chatUrl ?? null)
  useMarkOpened(spaceId, space.isSuccess)
  useDocumentTitle(space.data?.name ?? null)
  const now = useNowAfter(
    space.data ? Date.parse(space.data.createdAt) + PREPARING_MS : 0
  )
  const readyTab =
    space.data &&
    tab !== undefined &&
    spaceTabs(space.data, now).some(
      item => item.tab === tab && item.state === 'ready'
    )
      ? tab
      : null
  useSpaceTabTag(readyTab)

  // The page given to the open tab: until the person takes it back, another
  // space opens, or this one leaves or fails
  const fillPage = useFillPage()
  const { leave } = fillPage
  const assistant = useAssistant()
  const filled = fillPage.space === spaceId
  useLayoutEffect(() => leave, [spaceId, leave])
  useLayoutEffect(() => {
    if (space.isError) leave()
  }, [space.isError, leave])
  // Escape gives it back, from TwakeSpace: inside an app's frame, the keys
  // are the app's, and the way back is the first stop out of the frame
  const focusNext = useRef<'fill' | 'leave' | null>(null)
  useEffect(() => {
    if (!filled) return
    const listening = new AbortController()
    window.addEventListener(
      'keydown',
      event => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        focusNext.current = 'fill'
        leave()
      },
      { signal: listening.signal }
    )
    return () => {
      listening.abort()
    }
  }, [filled, leave])
  // The focus follows the person's own moves only: onto the way back, then
  // back onto the button that gave the page
  const fillButton = useRef<HTMLButtonElement>(null)
  const leaveButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const next = focusNext.current
    if (next === null) return
    focusNext.current = null
    ;(next === 'leave' ? leaveButton : fillButton).current?.focus()
  }, [filled])

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
        <Link component={RouterLink} to="/">
          {t('space.back')}
        </Link>
      </Page>
    )
  }

  const tabs = spaceTabs(space.data, now)
  const current = tabs.find(item => item.tab === tab && item.state !== 'off')
  if (!current) {
    const first = tabs.find(item => item.state !== 'off')
    return <Navigate to={`/spaces/${spaceId}/${first?.tab ?? ''}`} replace />
  }
  const label = t(`tabs.${current.tab}`)
  // The frame of an embedded app follows the page, under the shell
  const embedded = current.state === 'ready' ? embeddedApp(current.tab) : null
  const embeddedUrl = embedded ? appUrls[embedded.app] : null
  const framed = embedded !== null && embeddedUrl !== null
  const appsOff = space.data.chat
    ? space.data.mail
      ? null
      : 'space.mailOff'
    : space.data.mail
      ? 'space.chatOff'
      : 'space.chatAndMailOff'

  // The children keep their places whether the tab has the page or not, so
  // that the panel is not mounted again
  return (
    <Page fill={!framed} compact={filled}>
      {!filled && <FeedSearch key={spaceId} space={space.data} />}
      {filled ? (
        <CompactSpaceHeader
          back={
            <Button
              ref={leaveButton}
              variant="text"
              size="small"
              startIcon={<Icon icon={CloseFullscreenIcon} />}
              onClick={() => {
                focusNext.current = 'fill'
                leave()
              }}
            >
              {t('space.leaveFullPage')}
            </Button>
          }
          avatar={
            <NameAvatar
              name={space.data.name}
              color={space.data.color}
              size="xs"
            />
          }
          title={space.data.name}
          tab={label}
        />
      ) : (
        <SpaceHeader
          avatar={
            <NameAvatar
              name={space.data.name}
              color={space.data.color}
              size="m"
            />
          }
          title={space.data.name}
          actions={
            <>
              <IconButton
                ref={fillButton}
                size="small"
                label={t('space.fullPage')}
                onClick={() => {
                  focusNext.current = 'leave'
                  // The page given to the tab has no button to close the assistant with
                  assistant.setOpen(false)
                  fillPage.fill(spaceId)
                }}
              >
                <Icon icon={OpenInFullIcon} />
              </IconButton>
              <SpaceActions space={space.data} />
            </>
          }
          tabs={
            <Tabs
              narrowed
              variant="scrollable"
              scrollButtons={false}
              value={current.tab}
              onChange={(_event, value: string) => {
                void navigate(`/spaces/${spaceId}/${value}`)
              }}
            >
              {tabs.map(item => {
                const app = embeddedApp(item.tab)
                const count = app ? tabCount(badges, space.data, app.app) : 0
                const name = t(`tabs.${item.tab}`)
                return (
                  <Tab
                    key={item.tab}
                    value={item.tab}
                    label={
                      item.tab === 'home' ? (
                        <Icon icon={Home} size={24} />
                      ) : (
                        <CountedLabel label={name} count={badgeLabel(count)} />
                      )
                    }
                    aria-label={
                      count > 0
                        ? t('tabs.withCount', { app: name, smart_count: count })
                        : item.tab === 'home'
                          ? name
                          : undefined
                    }
                    disabled={item.state === 'off'}
                    id={`tab-${item.tab}`}
                    aria-controls={`panel-${item.tab}`}
                  />
                )
              })}
            </Tabs>
          }
        />
      )}
      {!filled && appsOff && (
        <Alert severity="info" className="u-mt-1 u-mb-1">
          {t(appsOff)}
        </Alert>
      )}
      {/* A framed tab's panel is the frame itself, under the shell */}
      {!framed && (
        <TabPanel tab={current.tab} label={filled ? label : undefined}>
          {current.state === 'preparing' && (
            <Typography className="u-mt-1">
              {t('space.preparing', { app: label })}
            </Typography>
          )}
          {current.state === 'stalled' && (
            <Alert
              severity="warning"
              className="u-mt-1"
              action={
                <Button
                  size="small"
                  disabled={space.isFetching}
                  onClick={() => {
                    void space.refetch()
                  }}
                >
                  {t('space.checkAgain')}
                </Button>
              }
            >
              {t('space.stalled', { app: label })}
            </Alert>
          )}
          {current.tab === 'home' && (
            <SpaceHome space={space.data} tabs={tabs} />
          )}
          {current.tab === 'feed' && (
            <FeedPanel key={spaceId} space={space.data} />
          )}
          {embedded && embeddedUrl === null && (
            <Typography className="u-mt-1">
              {t(`${embedded.app}.notSetUp`)}
            </Typography>
          )}
        </TabPanel>
      )}
    </Page>
  )
}
