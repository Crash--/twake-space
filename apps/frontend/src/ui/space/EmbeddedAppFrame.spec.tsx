import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import type { Badge } from '@linagora/twake-embed'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { EmbedPath } from '@/application/embeddedApps'
import type { SessionService } from '@/application/session'
import { fakeSession } from '@/testing/fakeSession'
import { renderWithProviders } from '@/testing/renderWithProviders'
import { useCall } from '@/ui/call/CallContext'
import { EmbeddedAppFrame } from '@/ui/space/EmbeddedAppFrame'

const MAIL = 'https://mail.test'
const EMBED = '/embed/team-mailboxes/m%2F1'

let notifications = {
  isWaiting: () => false,
  subscribe: () => () => undefined,
  allow: vi.fn(),
  show: vi.fn(),
  close: vi.fn()
}
let onBadges = vi.fn<(badges: readonly Badge[] | null) => void>()
let unmountFrame: () => void = () => undefined

// The room of the call window, as the app asked for it
function CallProbe() {
  const { call } = useCall()
  return <output data-testid="call">{call?.url ?? ''}</output>
}

async function renderFrame(
  session: SessionService = fakeSession(),
  meetUrl: string | null = 'https://meet.test'
) {
  const onPath = vi.fn<(report: EmbedPath) => void>()
  notifications = {
    isWaiting: () => false,
    subscribe: () => () => undefined,
    allow: vi.fn(),
    show: vi.fn(),
    close: vi.fn()
  }
  onBadges = vi.fn<(badges: readonly Badge[] | null) => void>()
  const { unmount } = renderWithProviders(
    <>
      <EmbeddedAppFrame
        app="mail"
        appUrl={`${MAIL}/`}
        embedPath={EMBED}
        src={`${MAIL}${EMBED}`}
        title="Mail"
        overlayPath="/embed/overlay.html"
        frameRef={createRef()}
        onPath={onPath}
        onBadges={onBadges}
        onMetadata={vi.fn()}
      />
      <CallProbe />
    </>,
    { session, meetUrl, notifications }
  )
  unmountFrame = unmount
  await screen.findByTitle('Mail')
  return onPath
}

function frame(): HTMLIFrameElement {
  const element = screen.getByTitle('Mail')
  if (!(element instanceof HTMLIFrameElement)) throw new Error('no frame')
  return element
}

function postFromFrame(
  data: unknown,
  origin = MAIL,
  source: MessageEventSource | null = frame().contentWindow
) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }))
  })
}

function overlay(): HTMLIFrameElement {
  const element = screen.getByTitle('Mail windows')
  if (!(element instanceof HTMLIFrameElement)) throw new Error('no overlay')
  return element
}

function region(value: unknown) {
  return { type: 'twake-embed:overlay-region', region: value }
}

// The app runs in its frame: the overlay is loaded from then on
async function appReady() {
  await waitFor(() => {
    postFromFrame({ type: 'twake-embed:ready' })
    expect(screen.getByTitle('Mail windows')).toBeInTheDocument()
  })
}

let calls = 0

// What cozy-external-bridge sends through comlink for `bridge.method(arg)`.
function bridgeCall(method: string, arg?: string, origin = MAIL) {
  calls += 1
  postFromFrame(
    {
      id: String(calls),
      type: 'APPLY',
      path: [method],
      argumentList: arg === undefined ? [] : [{ type: 'RAW', value: arg }]
    },
    origin
  )
}

// What the app reported, apart from the forgetting a document load brings
function reportedBadges(): (readonly Badge[])[] {
  return onBadges.mock.calls.flatMap(([badges]) => (badges ? [badges] : []))
}

describe('EmbeddedAppFrame', () => {
  it('frames the app in a sandbox, named for its overlay', async () => {
    await renderFrame()
    await appReady()

    expect(frame()).toHaveAttribute('src', `${MAIL}${EMBED}`)
    expect(frame()).toHaveAttribute('name', 'twake-embed-mail')
    expect(frame()).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads'
    )
    expect(frame()).toHaveAttribute(
      'allow',
      'clipboard-read; clipboard-write; fullscreen'
    )
    expect(overlay()).toHaveAttribute('name', 'twake-embed-mail:overlay')
    expect(overlay()).toHaveAttribute('src', `${MAIL}/embed/overlay.html`)
    expect(overlay()).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads'
    )
    expect(overlay()).toHaveAttribute(
      'allow',
      'clipboard-read; clipboard-write; fullscreen'
    )
  })

  it("reports the frame's path, as the app says it", async () => {
    const onPath = await renderFrame()

    await waitFor(() => {
      postFromFrame({
        type: 'twake-embed:path',
        resourceId: 'm/1',
        path: '/t/9?x=1',
        replace: false
      })
      expect(onPath).toHaveBeenCalledWith({
        dialect: 'embed',
        resourceId: 'm/1',
        path: '/t/9?x=1',
        replace: false
      })
    })
  })

  it("reports the frame's path from the bridge, as a replace", async () => {
    const onPath = await renderFrame()

    await waitFor(() => {
      bridgeCall('updateHistory', `${MAIL}${EMBED}/t/9?x=1`)
      expect(onPath).toHaveBeenCalledWith({
        dialect: 'legacy',
        resourceId: null,
        path: '/t/9?x=1',
        replace: true
      })
    })
  })

  it('ignores a path from another origin or another route', async () => {
    const onPath = await renderFrame()
    await waitFor(() => {
      bridgeCall('updateHistory', `${MAIL}${EMBED}`)
      expect(onPath).toHaveBeenCalledOnce()
    })
    onPath.mockClear()

    bridgeCall('updateHistory', `${MAIL}${EMBED}/t/9`, 'https://evil.test')
    bridgeCall('updateHistory', `${MAIL}/embed/team-mailboxes/m%2F12`)
    bridgeCall('updateHistory', `https://evil.test${EMBED}/t`)
    postFromFrame(
      {
        type: 'twake-embed:path',
        resourceId: 'm/1',
        path: '/t',
        replace: true
      },
      'https://evil.test'
    )

    expect(onPath).not.toHaveBeenCalled()
  })

  it('signs in again when the embed has no SSO session', async () => {
    const session = fakeSession()
    await renderFrame(session)

    postFromFrame({ type: 'twake-embed:login-required' }, 'https://evil.test')
    expect(session.signIn).not.toHaveBeenCalled()

    await waitFor(() => {
      postFromFrame({ type: 'twake-embed:login-required' })
      expect(session.signIn).toHaveBeenCalledOnce()
    })
  })

  it('signs in again when the embed asks through the bridge', async () => {
    const session = fakeSession()
    await renderFrame(session)

    await waitFor(() => {
      bridgeCall('notifyLoginRequired')
      expect(session.signIn).toHaveBeenCalledOnce()
    })
  })

  it('greets the frame on each of its loads, and nothing else, not before', async () => {
    await renderFrame()
    const contentWindow = frame().contentWindow
    if (!contentWindow) throw new Error('no frame window')
    const post = vi.spyOn(contentWindow, 'postMessage')

    expect(post).not.toHaveBeenCalled()
    fireEvent.load(frame())

    expect(post.mock.calls).toEqual([[{ type: 'twake-embed:hello' }, MAIL]])

    // The silent login loaded another document in the frame
    fireEvent.load(frame())
    expect(post.mock.calls).toEqual([
      [{ type: 'twake-embed:hello' }, MAIL],
      [{ type: 'twake-embed:hello' }, MAIL]
    ])
  })

  it('greets an app that says it listens, from its frame only', async () => {
    await renderFrame()
    const contentWindow = frame().contentWindow
    if (!contentWindow) throw new Error('no frame window')
    const post = vi.spyOn(contentWindow, 'postMessage')

    postFromFrame({ type: 'twake-embed:ready' }, 'https://evil.test')
    expect(post).not.toHaveBeenCalled()

    await waitFor(() => {
      postFromFrame({ type: 'twake-embed:ready' })
      expect(post).toHaveBeenCalledWith({ type: 'twake-embed:hello' }, MAIL)
    })
  })

  it('takes the page out of reach while the app blocks it', async () => {
    const root = document.createElement('div')
    root.id = 'root'
    document.body.appendChild(root)
    await renderFrame()
    await appReady()

    await waitFor(() => {
      postFromFrame(region('full'))
      expect(root.inert).toBe(true)
    })

    postFromFrame(region([]))
    expect(root.inert).toBe(false)
    root.remove()
  })

  it('loads the overlay once the app runs in its frame, and keeps it', async () => {
    await renderFrame()

    expect(screen.queryByTitle('Mail windows')).toBe(null)

    await appReady()
    const loaded = overlay()
    fireEvent.load(frame())
    postFromFrame({ type: 'twake-embed:ready' })

    expect(overlay()).toBe(loaded)
  })

  it('shows nothing of the overlay until the app draws there', async () => {
    await renderFrame()
    await appReady()

    expect(overlay().style.clipPath).toBe('inset(0 0 100% 0)')
    expect(overlay()).toHaveAttribute('aria-hidden', 'true')
    expect(overlay()).toHaveAttribute('tabindex', '-1')
  })

  it('shows the region the app draws in, then the whole page', async () => {
    await renderFrame()
    await appReady()

    await waitFor(() => {
      postFromFrame(region([{ x: 600, y: 300, width: 400, height: 500 }]))
      expect(overlay().style.clipPath).toBe("path('M600 300h400v500h-400Z')")
    })
    expect(overlay()).not.toHaveAttribute('aria-hidden')

    postFromFrame(region('full'))
    expect(overlay().style.clipPath).toBe('none')

    postFromFrame(region([]))
    expect(overlay().style.clipPath).toBe('inset(0 0 100% 0)')
  })

  it("takes a region only from the app's frame", async () => {
    await renderFrame()
    await appReady()
    await waitFor(() => {
      bridgeCall('updateHistory', `${MAIL}${EMBED}`)
    })

    postFromFrame(region('full'), 'https://evil.test')
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: region('full'),
          origin: MAIL,
          source: overlay().contentWindow
        })
      )
    })

    expect(overlay().style.clipPath).toBe('inset(0 0 100% 0)')
  })

  it('shows nothing of the overlay once the frame loads again', async () => {
    await renderFrame()
    await appReady()
    await waitFor(() => {
      postFromFrame(region('full'))
      expect(overlay().style.clipPath).toBe('none')
    })

    fireEvent.load(frame())

    expect(overlay().style.clipPath).toBe('inset(0 0 100% 0)')
  })

  describe('system notifications', () => {
    const ring = {
      type: 'twake-embed:notification',
      tag: 'call',
      title: 'Alice',
      body: 'Incoming call'
    }

    it('shows, then closes, the notification the app asks for', async () => {
      await renderFrame()

      postFromFrame(ring)
      expect(notifications.show).toHaveBeenCalledWith(
        'mail',
        { tag: 'call', title: 'Alice', body: 'Incoming call' },
        expect.any(Function)
      )

      postFromFrame({ type: 'twake-embed:notification-close', tag: 'call' })
      expect(notifications.close).toHaveBeenCalledWith('mail', 'call')
    })

    it('ignores a notification from another origin or window', async () => {
      await renderFrame()

      postFromFrame(ring, 'https://evil.test')
      postFromFrame(ring, MAIL, window)
      postFromFrame(
        { type: 'twake-embed:notification-close', tag: 'call' },
        'https://evil.test'
      )
      expect(notifications.show).not.toHaveBeenCalled()
      expect(notifications.close).not.toHaveBeenCalled()
    })
  })

  describe('a call the app asks to open', () => {
    const room = 'https://meet.test/abc-defg-hij'

    it('opens a room of this Meet in the call window', async () => {
      await renderFrame()
      postFromFrame({ type: 'twake-embed:pip', url: room })
      expect(screen.getByTestId('call')).toHaveTextContent(room)
    })

    it('drops anything that is not a room of this Meet', async () => {
      await renderFrame()
      postFromFrame({ type: 'twake-embed:pip', url: 'https://evil.test/x' })
      postFromFrame({ type: 'twake-embed:pip', url: room }, 'https://evil.test')
      postFromFrame({ type: 'twake-embed:pip', url: 'javascript:alert(1)' })
      expect(screen.getByTestId('call')).toHaveTextContent('')
    })

    it('opens nothing without a Meet', async () => {
      await renderFrame(fakeSession(), null)
      postFromFrame({ type: 'twake-embed:pip', url: room })
      expect(screen.getByTestId('call')).toHaveTextContent('')
    })
  })

  describe('counts for the tabs', () => {
    const snapshot = {
      type: 'twake-embed:badges',
      badges: [
        { resourceId: 'm/1', count: 3 },
        { resourceId: 'm/2', count: 0 }
      ]
    }

    it("reports the app's whole snapshot, as it says it", async () => {
      await renderFrame()

      postFromFrame(snapshot)
      expect(reportedBadges()).toEqual([snapshot.badges])

      postFromFrame({ type: 'twake-embed:badges', badges: [] })
      expect(reportedBadges()).toEqual([snapshot.badges, []])
    })

    it('ignores counts from another origin or another window', async () => {
      await renderFrame()

      postFromFrame(snapshot, 'https://evil.test')
      postFromFrame(snapshot, MAIL, window)
      postFromFrame(snapshot, MAIL, null)
      expect(reportedBadges()).toEqual([])
    })

    it('ignores counts that are not valid', async () => {
      await renderFrame()

      postFromFrame({
        type: 'twake-embed:badges',
        badges: [{ resourceId: 'm/1', count: -1 }]
      })
      postFromFrame({
        type: 'twake-embed:badges',
        badges: [{ resourceId: 'm/1', count: 1.5 }]
      })
      postFromFrame({ type: 'twake-embed:badges', badges: 'many' })
      expect(reportedBadges()).toEqual([])
    })

    it("forgets the counts when the frame's document reloads", async () => {
      await renderFrame()
      postFromFrame(snapshot)
      onBadges.mockClear()

      fireEvent.load(frame())

      expect(onBadges).toHaveBeenCalledExactlyOnceWith(null)
    })

    it('forgets the counts when the frame goes', async () => {
      await renderFrame()
      postFromFrame(snapshot)
      onBadges.mockClear()

      unmountFrame()

      expect(onBadges).toHaveBeenCalledWith(null)
    })
  })
})
