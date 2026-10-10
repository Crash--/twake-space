import { useQueryClient } from '@tanstack/react-query'
import {
  createRef,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject
} from 'react'
import {
  matchPath,
  NavigationType,
  useLocation,
  useNavigate,
  useNavigationType
} from 'react-router'

import {
  EMBEDDED_APPS,
  embeddedApp,
  loadMessage,
  navigateMessage,
  reconcile,
  reconcileHidden,
  spaceOfResource,
  tabPath,
  type EmbedPath,
  type EmbeddedApp,
  type FrameState,
  type ShownApp
} from '@/application/embeddedApps'
import { isTabReady, spaceTabs } from '@/application/spaceTabs'
import { KeptAlive, KeptAliveStack } from '@/ds/KeptAlive'
import { useI18n } from '@/ui/i18n/useI18n'
import { useServices } from '@/ui/services/Services'
import { useBadgeActions } from '@/ui/space/Badges'
import { EmbeddedAppFrame } from '@/ui/space/EmbeddedAppFrame'
import { useFillPage } from '@/ui/space/FillPage'
import { useAppUrls } from '@/ui/space/useAppUrls'
import { SPACES, useSpace } from '@/ui/spaces/queries'

const SPACE_ROUTE = '/spaces/:spaceId/:tab?/*'

type Frames = Partial<Record<EmbeddedApp, FrameState>>

// The frames of the embedded apps, kept alive for the whole session under
// the shell (ADR 010): a space change shows another resource in the same
// frame, with a `load`, and the frames never write the browser history.
// The address is the source of truth: on every change, the frame shown is
// brought to what the address says. The space's other ready apps have their
// frame too, hidden and alive, moved to the space's resources on a space
// change: only the frame shown ever writes the address.
export function EmbeddedApps(): ReactElement | null {
  const { t } = useI18n()
  const appUrls = useAppUrls()
  const location = useLocation()
  const popped = useNavigationType() === NavigationType.Pop
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { spaces } = useServices()
  // The space whose resource a notification is about: the spaces are read
  // in full on the click only, from the cache the list of spaces shares
  const spaceOfNotification = async (
    app: EmbeddedApp,
    resourceId: string
  ): Promise<string | null> => {
    const list = await queryClient.query({
      queryKey: SPACES,
      queryFn: () => spaces.list()
    })
    const details = await Promise.all(
      list.map(space =>
        queryClient
          .query({
            queryKey: [...SPACES, space.id],
            queryFn: () => spaces.get(space.id)
          })
          .catch(() => null)
      )
    )
    return spaceOfResource(
      details.filter(detail => detail !== null),
      app,
      resourceId
    )
  }
  const badges = useBadgeActions()
  const filled = useFillPage().space !== null
  const match = matchPath(SPACE_ROUTE, location.pathname)
  const spaceId = match?.params.spaceId ?? ''
  const space = useSpace(spaceId)

  const spec = embeddedApp(match?.params.tab)
  const appUrl = spec ? appUrls[spec.app] : null
  const ready =
    spec !== null &&
    space.data !== undefined &&
    isTabReady(space.data, spec.app)
  const resourceId = ready
    ? (space.data.resources.find(r => r.kind === spec.resource)?.id ?? null)
    : null
  const rest = match?.params['*'] ?? ''
  const shown: ShownApp | null =
    spec && appUrl !== null && resourceId !== null
      ? {
          app: spec.app,
          spaceId,
          resourceId,
          path: `${rest ? `/${rest}` : ''}${location.search}${location.hash}`
        }
      : null
  // The ready tabs of the space that have an app, and the resource of each
  const targets = space.data
    ? spaceTabs(space.data, 0).flatMap(item => {
        const itemSpec = embeddedApp(item.tab)
        const itemUrl = itemSpec ? appUrls[itemSpec.app] : null
        const id = space.data.resources.find(
          r => r.kind === itemSpec?.resource
        )?.id
        return item.state === 'ready' &&
          itemSpec &&
          itemUrl !== null &&
          id !== undefined &&
          id !== null
          ? [{ spec: itemSpec, appUrl: itemUrl, resourceId: id }]
          : []
      })
    : []
  const hiddenTargets = targets.filter(target => target.spec.app !== shown?.app)
  const here = location.pathname + location.search + location.hash

  const [frames, setFrames] = useState<Frames>({})
  // The app whose frame floats over the page (Chat in a call)
  const [floating, setFloating] = useState<EmbeddedApp | null>(null)
  const [elements] = useState<
    Record<EmbeddedApp, RefObject<HTMLIFrameElement | null>>
  >(() => ({
    chat: createRef(),
    tasks: createRef(),
    drive: createRef(),
    mail: createRef(),
    calendar: createRef()
  }))

  // The frames follow the address: a state adjusted while rendering, as
  // React derives state from props. Each step settles on the next render.
  // The frames of the space's other ready tabs are mounted up front, hidden,
  // so that every app can report its counts: they follow the space shown,
  // never the address. A floating frame keeps its resource until it lands:
  // moving it would end Chat's call.
  let adopt: string | null = null
  let next = frames
  for (const target of hiddenTargets) {
    const { spec: hiddenSpec, resourceId: hiddenResource } = target
    if (hiddenSpec.app === floating) continue
    const frame = frames[hiddenSpec.app] ?? null
    const step = reconcileHidden(
      frame,
      hiddenResource,
      hiddenSpec,
      target.appUrl
    )
    if (step.kind === 'create' || step.kind === 'replace') {
      next = {
        ...next,
        [hiddenSpec.app]: {
          key: (frame?.key ?? 0) + 1,
          src: step.src,
          spaceId,
          resourceId: hiddenResource,
          path: '',
          dialect: null,
          pending: null,
          writtenFrom: null
        }
      }
    } else if (step.kind === 'load' && frame) {
      next = {
        ...next,
        [hiddenSpec.app]: {
          ...frame,
          spaceId,
          resourceId: hiddenResource,
          path: '',
          pending: loadMessage(hiddenResource, '')
        }
      }
    }
  }
  const written = (Object.keys(frames) as EmbeddedApp[]).find(app => {
    const from = frames[app]?.writtenFrom
    return from !== undefined && from !== null && from !== here
  })
  if (written !== undefined) {
    // The address TwakeSpace wrote shows: the frame follows it again
    next = withFrame(next, written, { writtenFrom: null })
  } else if (
    shown !== null &&
    appUrl !== null &&
    spec !== null &&
    !(
      shown.app === floating &&
      frames[shown.app]?.resourceId !== shown.resourceId
    )
  ) {
    const frame = frames[shown.app] ?? null
    const step = reconcile(frame, shown, spec, appUrl, popped, here)
    switch (step.kind) {
      case 'create':
      case 'replace':
        next = {
          ...next,
          [shown.app]: {
            key: (frame?.key ?? 0) + 1,
            src: step.src,
            spaceId: shown.spaceId,
            resourceId: shown.resourceId,
            path: shown.path,
            dialect: null,
            pending: null,
            writtenFrom: null
          }
        }
        break
      case 'load':
        if (frame) {
          next = {
            ...next,
            [shown.app]: {
              ...frame,
              spaceId: shown.spaceId,
              resourceId: shown.resourceId,
              path: shown.path,
              pending: loadMessage(shown.resourceId, shown.path)
            }
          }
        }
        break
      case 'navigate':
        if (frame) {
          next = {
            ...next,
            [shown.app]: {
              ...frame,
              path: shown.path,
              pending: navigateMessage(shown.resourceId, shown.path)
            }
          }
        }
        break
      case 'adopt':
        adopt = step.to
        break
      case 'none':
        break
    }
  }
  if (next !== frames) setFrames(next)

  useEffect(() => {
    if (adopt !== null) void navigate(adopt, { replace: true })
  }, [adopt, navigate])

  // Each message goes once, after the render that decided it
  const sent = useRef(new WeakSet<object>())
  useEffect(() => {
    for (const app of Object.keys(frames) as EmbeddedApp[]) {
      const message = frames[app]?.pending
      const url = appUrls[app]
      if (!message || url === null || sent.current.has(message)) continue
      sent.current.add(message)
      elements[app].current?.contentWindow?.postMessage(
        message,
        new URL(url).origin
      )
    }
  })

  // What the message handlers read: the frames and the address as committed
  const committed = useRef({ frames, shown, here })
  useEffect(() => {
    committed.current = { frames, shown, here }
  })

  // The frame's URL: written in the address when its tab shows, kept for
  // when it shows again otherwise. A path for another resource is a late
  // message of the previous one, or a frame that booted before its `load`
  // reached it: the frame is told again.
  const onPath = (app: EmbeddedApp, report: EmbedPath): void => {
    const frame = committed.current.frames[app]
    if (!frame) return
    const dialect = frame.dialect === 'embed' ? 'embed' : report.dialect
    if (report.resourceId !== null && report.resourceId !== frame.resourceId) {
      setFrames(prev =>
        withFrame(prev, app, {
          dialect,
          pending:
            dialect === 'embed'
              ? loadMessage(frame.resourceId, frame.path)
              : frame.pending
        })
      )
      return
    }
    const current = committed.current.shown
    // A frame whose path changed while it booted was never told: on its first
    // report the address wins (e.g. Start an instant meeting from the feed)
    if (
      frame.dialect === null &&
      dialect === 'embed' &&
      current?.app === app &&
      current.path !== frame.path
    ) {
      setFrames(prev =>
        withFrame(prev, app, {
          dialect,
          path: current.path,
          pending: navigateMessage(frame.resourceId, current.path)
        })
      )
      return
    }
    const { here: from } = committed.current
    // A floating frame still on another space's resource writes no address
    const to =
      current?.app === app && current.resourceId === frame.resourceId
        ? tabPath(current.spaceId, app) + report.path
        : null
    const writes = to !== null && to !== from
    setFrames(prev =>
      withFrame(prev, app, {
        dialect,
        path: report.path,
        writtenFrom: writes ? from : null
      })
    )
    if (writes) void navigate(to, { replace: report.replace })
  }

  const mounted = (Object.keys(frames) as EmbeddedApp[]).filter(
    app => appUrls[app] !== null
  )
  if (mounted.length === 0) return null

  return (
    <KeptAliveStack
      active={shown !== null}
      reachable={floating !== null}
      role="tabpanel"
      id={shown ? `panel-${shown.app}` : undefined}
      // Without its tab, on a page given to it, the panel names itself
      aria-label={shown && filled ? t(`tabs.${shown.app}`) : undefined}
      aria-labelledby={shown && !filled ? `tab-${shown.app}` : undefined}
    >
      {mounted.map(app => {
        const frame = frames[app]
        const url = appUrls[app]
        if (!frame || url === null) return null
        return (
          <KeptAlive
            key={app}
            active={shown?.app === app}
            reachable={floating === app}
          >
            <EmbeddedAppFrame
              key={frame.key}
              app={app}
              appUrl={url}
              embedPath={EMBEDDED_APPS[app].embedPath(frame.resourceId)}
              src={frame.src}
              title={t(`tabs.${app}`)}
              overlayPath={EMBEDDED_APPS[app].overlayPath}
              allow={EMBEDDED_APPS[app].allow}
              canFillPage={EMBEDDED_APPS[app].canFillPage}
              frameRef={elements[app]}
              onFloat={floats => {
                setFloating(current =>
                  floats ? app : current === app ? null : current
                )
              }}
              onPath={report => {
                onPath(app, report)
              }}
              onOpen={resourceId => {
                void (async () => {
                  // The space of the resource it is about, else the one the
                  // frame shows
                  const spaceId =
                    resourceId === null
                      ? null
                      : await spaceOfNotification(app, resourceId).catch(
                          () => null
                        )
                  if (spaceId !== null) {
                    void navigate(tabPath(spaceId, app))
                    return
                  }
                  const current = committed.current.frames[app]
                  if (current) {
                    void navigate(tabPath(current.spaceId, app) + current.path)
                  }
                })()
              }}
              onBadges={reported => {
                if (reported === null) badges.reset(app)
                else badges.replace(app, reported)
              }}
              onMetadata={reported => {
                badges.metadata(app, reported)
              }}
            />
          </KeptAlive>
        )
      })}
    </KeptAliveStack>
  )
}

function withFrame(
  frames: Frames,
  app: EmbeddedApp,
  patch: Partial<FrameState>
): Frames {
  const frame = frames[app]
  if (!frame) return frames
  const next = { ...frame, ...patch }
  return (Object.keys(patch) as (keyof FrameState)[]).every(
    key => frame[key] === next[key]
  )
    ? frames
    : { ...frames, [app]: next }
}
