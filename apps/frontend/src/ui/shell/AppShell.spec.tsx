import type { TwakeBarProps } from '@linagora/twake-bar'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { Space } from '@/application/spaces'
import { fakeSession, fakeUser } from '@/testing/fakeSession'
import { fakeSpaces } from '@/testing/fakeSpaces'
import { renderRoute } from '@/testing/renderWithProviders'

const createSdk = vi.hoisted(() => vi.fn(() => ({ status: 'ready' })))
vi.mock('@linagora/twake-sdk', () => ({ createSdk }))

// The bar is tested in its own package: only its wiring matters here
vi.mock('@linagora/twake-bar', () => ({
  TWAKE_BAR_HEIGHT: '3rem',
  SdkProvider: ({ children }: { children: ReactNode }): ReactNode => children,
  TwakeBar: ({ app, onLogOut }: TwakeBarProps): ReactElement => (
    <header role="banner">
      {app.name}
      <button onClick={onLogOut}>Log out</button>
    </header>
  )
}))

const spaces = () =>
  fakeSpaces([
    {
      id: 'space-1',
      name: 'Design',
      role: 'admin',
      color: null,
      description: '',
      pinnedAt: '2026-10-01T08:00:00.000Z',
      openedAt: '2026-10-02T08:00:00.000Z',
      manages: true,
      members: []
    },
    {
      id: 'space-2',
      name: 'Launch',
      role: 'viewer',
      color: null,
      description: '',
      pinnedAt: null,
      openedAt: '2026-10-01T08:00:00.000Z',
      manages: false,
      members: []
    },
    {
      id: 'space-3',
      name: 'Handover',
      role: 'viewer',
      color: null,
      description: '',
      pinnedAt: null,
      openedAt: null,
      manages: false,
      members: []
    }
  ])

const detail = (id: string, name: string, mailbox: string): Space => ({
  id,
  name,
  role: 'admin',
  createdAt: '2026-01-01T00:00:00.000Z',
  color: null,
  description: '',
  pinnedAt: null,
  openedAt: null,
  manages: true,
  apps: ['tasks', 'mail'],
  chat: true,
  mail: true,
  homeserverUrl: null,
  banner: null,
  members: [],
  groups: [],
  resources: [
    { kind: 'project', id: `project-${id}` },
    { kind: 'mailbox', id: mailbox }
  ]
})

function postFromFrame(title: string, origin: string, data: unknown) {
  const element = screen.getByTitle(title)
  if (!(element instanceof HTMLIFrameElement)) throw new Error('no frame')
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin,
        source: element.contentWindow
      })
    )
  })
}

describe('AppShell', () => {
  it.each(['/', '/spaces/space-1'])(
    'shows the platform bar and signs out from it on %s',
    async path => {
      const session = fakeSession(() => Promise.resolve(fakeUser('id-token')))
      renderRoute(path, { session, spaces: spaces() })

      const bar = within(await screen.findByRole('banner'))
      expect(bar.getByText('Twake Space')).toBeInTheDocument()
      expect(createSdk).toHaveBeenCalledWith({
        platformURL: 'https://alice.twake.test',
        idToken: 'id-token'
      })
      fireEvent.click(bar.getByRole('button', { name: 'Log out' }))

      expect(session.signOut).toHaveBeenCalled()
    }
  )

  it('shows no platform bar when the SSO did not name the platform', async () => {
    renderRoute('/', { spaces: spaces() })

    await screen.findByRole('navigation')
    expect(screen.queryByRole('banner')).toBe(null)
    expect(createSdk).not.toHaveBeenCalled()
  })

  it('fills the window when there is no platform bar to leave room for', async () => {
    renderRoute('/', { spaces: spaces() })

    const frame = (await screen.findByRole('navigation')).closest(
      'aside'
    )?.parentElement
    expect(frame).toBeTruthy()
    expect(
      getComputedStyle(frame as Element).getPropertyValue('--topBarHeight')
    ).toBe('0px')
  })

  it('lists the pinned and recent spaces in the sidebar and marks the current one', async () => {
    renderRoute('/spaces/space-2/feed', { spaces: spaces() })

    const pinned = within(await screen.findByRole('list', { name: 'Pinned' }))
    const recent = within(screen.getByRole('list', { name: 'Recent' }))
    const launch = recent.getByRole('link', { name: 'Launch' })
    expect(launch).toHaveAttribute('href', '/spaces/space-2')
    expect(launch).toHaveAttribute('aria-current', 'page')
    expect(pinned.getByRole('link', { name: 'Design' })).not.toHaveAttribute(
      'aria-current'
    )
    expect(recent.queryByRole('link', { name: 'Design' })).toBe(null)
    expect(screen.queryByRole('link', { name: 'Handover' })).toBe(null)
  })

  it('hides Pinned while nothing is pinned, and shows Recent with a hint while it is empty', async () => {
    const service = fakeSpaces([
      {
        id: 'space-3',
        name: 'Handover',
        role: 'viewer',
        color: null,
        description: '',
        pinnedAt: null,
        openedAt: null,
        manages: false,
        members: []
      }
    ])
    renderRoute('/', { spaces: service })

    expect(
      within(await screen.findByRole('list', { name: 'Recent' })).getByText(
        'The spaces you open show here'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Pinned' })).toBe(null)
  })

  it('searches every space by name from the sidebar', async () => {
    renderRoute('/', { spaces: spaces() })
    await screen.findByRole('list', { name: 'Pinned' })

    fireEvent.click(screen.getByRole('button', { name: 'Search your spaces' }))
    const search = screen.getByRole('textbox', { name: 'Space name' })
    expect(search).toHaveFocus()
    fireEvent.change(search, { target: { value: 'HAND' } })

    const found = within(screen.getByRole('list', { name: 'Your spaces' }))
    expect(found.getByRole('link', { name: 'Handover' })).toBeInTheDocument()
    expect(found.queryByRole('link', { name: 'Design' })).toBe(null)
    expect(screen.queryByRole('list', { name: 'Pinned' })).toBe(null)

    fireEvent.change(search, { target: { value: 'nothing' } })
    expect(found.getByText('No space found')).toBeInTheDocument()

    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Space name' })).toBe(null)
    expect(
      within(screen.getByRole('list', { name: 'Pinned' })).getByRole('link', {
        name: 'Design'
      })
    ).toBeInTheDocument()
  })

  it('links home from the navigation', async () => {
    renderRoute('/', { spaces: spaces() })

    const nav = within(await screen.findByRole('navigation'))
    expect(
      nav.getByRole('link', { name: 'All shared spaces' })
    ).toHaveAttribute('aria-current', 'page')
  })

  it('links the Archives and the Bin from the sidebar', async () => {
    renderRoute('/bin', { spaces: spaces() })

    const shelves = within(
      await screen.findByRole('list', { name: 'Archives and Bin' })
    )
    expect(shelves.getByRole('link', { name: 'Archives' })).toHaveAttribute(
      'href',
      '/archives'
    )
    expect(shelves.getByRole('link', { name: 'Bin' })).toHaveAttribute(
      'aria-current',
      'page'
    )
  })

  it('follows the UI language', async () => {
    renderRoute('/', { lang: 'fr', spaces: spaces() })

    expect(
      await screen.findByRole('list', { name: 'Épinglés' })
    ).toBeInTheDocument()
  })

  describe('counts of the apps', () => {
    function renderWithCounts() {
      const service = spaces()
      vi.mocked(service.get).mockImplementation(id =>
        Promise.resolve(
          id === 'space-1'
            ? detail('space-1', 'Design', 'design@acme')
            : detail('space-2', 'Launch', 'launch@acme')
        )
      )
      renderRoute('/spaces/space-1/feed', { spaces: service })
      return service
    }

    it('adds up, per space, the counts of its resources across the apps', async () => {
      renderWithCounts()
      await screen.findByRole('link', { name: 'Design' })
      await screen.findByTitle('Tasks')

      // An app's snapshot covers every space the user has
      await waitFor(() => {
        postFromFrame('Mail', 'https://mail.test', {
          type: 'twake-embed:badges',
          badges: [
            { resourceId: 'design@acme', count: 3 },
            { resourceId: 'launch@acme', count: 120 }
          ]
        })
        postFromFrame('Tasks', 'https://tasks.test', {
          type: 'twake-embed:badges',
          badges: [
            { resourceId: 'project-space-1', count: 2 },
            { resourceId: 'unknown', count: 50 }
          ]
        })
        expect(
          screen.getByRole('link', { name: 'Design, 5 new' })
        ).toBeInTheDocument()
      })
      const pinned = within(screen.getByRole('list', { name: 'Pinned' }))
      const recent = within(screen.getByRole('list', { name: 'Recent' }))
      expect(pinned.getByText('5')).toBeInTheDocument()
      expect(
        recent.getByRole('link', { name: 'Launch, 120 new' })
      ).toBeInTheDocument()
      expect(recent.getByText('99+')).toBeInTheDocument()
    })

    it('shows no total for a space the apps reported nothing for', async () => {
      renderWithCounts()
      await screen.findByRole('link', { name: 'Design' })
      await screen.findByTitle('Mail')

      await waitFor(() => {
        postFromFrame('Mail', 'https://mail.test', {
          type: 'twake-embed:badges',
          badges: [
            { resourceId: 'design@acme', count: 3 },
            { resourceId: 'launch@acme', count: 0 }
          ]
        })
        expect(
          screen.getByRole('link', { name: 'Design, 3 new' })
        ).toBeInTheDocument()
      })
      expect(screen.getByRole('link', { name: 'Launch' })).toBeInTheDocument()
    })

    it('reads no space in full until an app reports', async () => {
      const service = renderWithCounts()
      await screen.findByRole('link', { name: 'Design' })

      expect(service.get).not.toHaveBeenCalledWith('space-2')
    })
  })
})
