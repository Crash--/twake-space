import { expose } from 'comlink'
import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'

import {
  helloMessage,
  parseAppMessage,
  type Badge,
  type Metadata
} from '@linagora/twake-embed'
import {
  OverlayFrame,
  overlayClipPath,
  parseOverlayRegionMessage,
  type OverlayRegion
} from '@linagora/twake-mui'

import { badgesOf } from '@/application/metadata'
import {
  isLoginRequired,
  legacyEmbedPath,
  parseEmbedPath,
  type EmbedPath
} from '@/application/embeddedApps'
import { meetRoomUrl } from '@/application/meet'
import { EmbedFrame } from '@/ds/EmbedFrame'
import { FloatingWindow, type WindowBody } from '@/ds/FloatingWindow'
import { useCall } from '@/ui/call/CallContext'
import { useI18n } from '@/ui/i18n/useI18n'
import { useServices } from '@/ui/services/Services'
import { useSession } from '@/ui/session/SessionGate'

// Downloads too: a sandboxed frame without it cannot save a file. A tab the
// frame opens inherits the sandbox (no alert, confirm or print) unless
// popups escape it; `allow-modals` stays off for the frame itself.
export const SANDBOX =
  'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads'
// The browser's full screen too: a video or a document of the app over the
// whole screen (the page of TwakeSpace is another thing, `fill-page`)
const ALLOW = 'clipboard-read; clipboard-write; fullscreen'

// The frame of an app, and what every embedded app gets from TwakeSpace:
// - its path reported to the host (`twake-embed:path`, or the legacy
//   `twake-tasks:path` and cozy-external-bridge's `updateHistory`),
// - a new sign in when its session expired (`twake-embed:login-required`,
//   or the bridge's `notifyLoginRequired`),
// - a greeting on each of its loads and whenever the app says it listens
//   (`twake-embed:hello` for `twake-embed:ready`), from which the app learns
//   where TwakeSpace is,
// - its counts for the tabs (`twake-embed:badges`), the whole snapshot each
//   time, forgotten when the frame's document reloads or the frame goes,
// - the system notifications it asks for (`twake-embed:notification`, and
//   `-close` for one tag), which the browser refuses to the frame itself,
// - the same for its metadata (`twake-embed:metadata`): the figures of the
//   space home, and maybe its counts under `badge`. Once a document sends
//   its counts there, its badges are left aside,
// - an overlay over the whole page, on the app's origin, for its docked
//   windows and dialogs: an empty page the app renders into, shown within
//   the region the app reports (`twake-embed:overlay-region`),
// - with `canFillPage`, a floating window while the app asks for the page
//   (`twake-embed:fill-page`): Chat during a call, on whichever tab or page
//   TwakeSpace shows, which stays usable,
// - its call window for a Meet room the app holds a link to
//   (`twake-embed:pip`): a room of this Meet only, anything else is dropped.
// The frame's `src` is set once: the host moves it with messages.
export function EmbeddedAppFrame({
  app,
  appUrl,
  embedPath,
  src,
  title,
  overlayPath,
  allow,
  canFillPage = false,
  frameRef,
  onPath,
  onBadges,
  onMetadata,
  onFloat,
  onOpen
}: {
  // Names the frame `twake-embed-<app>`, and its overlay `<that>:overlay`
  app: string
  appUrl: string
  // The embed route the frame was created on, to read legacy paths
  embedPath: string
  src: string
  title: string
  overlayPath: string | null
  // Permissions of this app alone, beyond the clipboard (Chat's calls)
  allow?: string | undefined
  canFillPage?: boolean | undefined
  frameRef: RefObject<HTMLIFrameElement | null>
  // The frame's URL, already checked to come from it
  onPath: (report: EmbedPath) => void
  // The app's counts, already checked to come from the frame: its whole
  // snapshot, or null when the frame's document is gone
  onBadges: (badges: readonly Badge[] | null) => void
  onMetadata: (metadata: readonly Metadata[]) => void
  onFloat?: (floats: boolean) => void
  // A click on one of its system notifications: show the app
  // with the resource it is about, when the app said it
  onOpen?: (resourceId: string | null) => void
}): ReactElement {
  const { t } = useI18n()
  const { signIn } = useSession()
  const { meetUrl, notifications } = useServices()
  const { join } = useCall()
  const origin = new URL(appUrl).origin
  const name = `twake-embed-${app}`

  const report = useRef(onPath)
  const reportBadges = useRef(onBadges)
  const reportMetadata = useRef(onMetadata)
  const countsInMetadata = useRef(false)
  const open = useRef(onOpen)
  useEffect(() => {
    report.current = onPath
    reportBadges.current = onBadges
    reportMetadata.current = onMetadata
    open.current = onOpen
  })
  // A frame replaced or removed takes its counts with it
  useEffect(
    () => () => {
      reportBadges.current(null)
    },
    []
  )

  const [region, setRegion] = useState<OverlayRegion | null>(null)
  // The overlay loads once the app runs in its frame, signed in: an app on a
  // cozy-stack signs in there, and an overlay loaded earlier holds the
  // stack's error page, which the app would then draw its dialogs on. Once
  // loaded it stays, as the app holds on to its document.
  const [overlayed, setOverlayed] = useState(false)

  const [asksPage, setAsksPage] = useState(false)
  const floats = canFillPage && asksPage
  const [body, setBody] = useState<WindowBody | null>(null)
  const float = useRef(onFloat)
  useEffect(() => {
    float.current = onFloat
  })
  useEffect(() => {
    if (!floats) return
    float.current?.(true)
    return () => {
      float.current?.(false)
      setBody(null)
    }
  }, [floats])

  // Until the app loads, the frame holds about:blank on this page's origin.
  // Each document the frame loads (the silent login makes several) is
  // greeted, and so is an app that says it listens after its frame loaded:
  // the app answers the origin that greets it.
  // No theme goes with the greeting: each app follows its own setting or
  // the system, through the common settings (ADR 010).
  const [loads, setLoads] = useState(0)
  useEffect(() => {
    if (loads === 0) return
    frameRef.current?.contentWindow?.postMessage(helloMessage(), origin)
  }, [frameRef, loads, origin])

  useEffect(() => {
    const target = frameRef.current?.contentWindow
    if (!target) return
    const listening = new AbortController()
    const fromFrame = (event: Event) =>
      event instanceof MessageEvent &&
      event.origin === origin &&
      event.source === target

    window.addEventListener(
      'message',
      event => {
        if (!fromFrame(event)) return
        if (isLoginRequired(event.data)) {
          void signIn()
          return
        }
        const reported = parseOverlayRegionMessage(event.data)
        if (reported !== null) {
          setRegion(reported)
          return
        }
        const message = parseAppMessage(event.data)
        if (message?.type === 'twake-embed:notification') {
          const { tag, title, body, resourceId } = message
          notifications.show(app, { tag, title, body }, () => {
            open.current?.(resourceId ?? null)
          })
          return
        }
        if (message?.type === 'twake-embed:notification-close') {
          notifications.close(app, message.tag)
          return
        }
        if (message?.type === 'twake-embed:ready') {
          setOverlayed(true)
          setLoads(n => n + 1)
          return
        }
        if (message?.type === 'twake-embed:fill-page') {
          setAsksPage(message.fill)
          return
        }
        if (message?.type === 'twake-embed:badges') {
          if (!countsInMetadata.current) reportBadges.current(message.badges)
          return
        }
        if (message?.type === 'twake-embed:metadata') {
          if (message.metadata.some(({ name }) => name === 'badge')) {
            countsInMetadata.current = true
            reportBadges.current(badgesOf(message.metadata))
          }
          reportMetadata.current(message.metadata)
          return
        }
        if (message?.type === 'twake-embed:pip') {
          const room =
            meetUrl === null ? null : meetRoomUrl(message.url, meetUrl)
          if (room !== null) join({ url: room })
          return
        }
        const path = parseEmbedPath(event.data, embedPath)
        if (path !== null) report.current(path)
      },
      { signal: listening.signal }
    )
    // Mail's facade talks through cozy-external-bridge, over comlink.
    expose(
      {
        updateHistory: (url: string) => {
          const next = new URL(url, origin)
          if (next.origin !== origin) return
          const path = legacyEmbedPath(
            next.pathname + next.search + next.hash,
            embedPath
          )
          if (path !== null) report.current(path)
        },
        notifyLoginRequired: signIn
      },
      {
        postMessage: (message: unknown, transfer?: Transferable[]) => {
          target.postMessage(message, origin, transfer)
        },
        addEventListener: (type, listener) => {
          window.addEventListener(
            type,
            event => {
              if (fromFrame(event)) (listener as EventListener)(event)
            },
            { signal: listening.signal }
          )
        },
        removeEventListener: () => undefined
      }
    )
    return () => {
      listening.abort()
    }
  }, [app, embedPath, frameRef, join, meetUrl, notifications, origin, signIn])

  return (
    <>
      <EmbedFrame
        frameRef={frameRef}
        name={name}
        title={title}
        src={src}
        sandbox={SANDBOX}
        allow={allow === undefined ? ALLOW : `${ALLOW}; ${allow}`}
        over={floats ? body : null}
        onLoad={() => {
          // A frame loaded again draws nothing on the overlay yet, and
          // floats no more
          setRegion(null)
          setAsksPage(false)
          // The new document reports its counts again, on its greeting
          countsInMetadata.current = false
          reportBadges.current(null)
          setLoads(n => n + 1)
        }}
      />
      {overlayPath !== null && overlayed && (
        <AppOverlay
          name={`${name}:overlay`}
          src={new URL(overlayPath, appUrl).href}
          title={t('embed.overlay', { app: title })}
          region={region}
        />
      )}
      {floats &&
        createPortal(
          <FloatingWindow
            title={t('call.window')}
            storageKey={`twake-space:${name}:call-window`}
            labels={{
              minimize: t('call.minimize'),
              maximize: t('call.maximize'),
              restore: t('call.restore'),
              close: t('call.leave')
            }}
            onBody={setBody}
          />,
          document.body
        )}
    </>
  )
}

// The overlay, shown within the region its app reports.
function AppOverlay({
  name,
  src,
  title,
  region
}: {
  name: string
  src: string
  title: string
  region: OverlayRegion | null
}): ReactElement {
  // While the app blocks the page (a dialog), the rest of it, the app's own
  // frame included, is out of reach of the keyboard and screen readers
  useEffect(() => {
    if (region !== 'full') return
    const page = document.getElementById('root')
    if (!page) return
    page.inert = true
    return () => {
      page.inert = false
    }
  }, [region])

  return (
    <OverlayFrame
      name={name}
      src={src}
      title={title}
      sandbox={SANDBOX}
      allow={ALLOW}
      clipPath={overlayClipPath(region)}
    />
  )
}
