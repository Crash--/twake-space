import type { TwakeBarProps } from '@linagora/twake-bar'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { Space } from '@/application/spaces'
import { fakeSession, fakeUser } from '@/testing/fakeSession'
import { fakeSpaces } from '@/testing/fakeSpaces'
import { renderRoute } from '@/testing/renderWithProviders'

vi.mock('@linagora/twake-sdk', () => ({
  createSdk: () => ({
    status: 'ready',
    onStatusChange: () => () => undefined,
    createIntent: () => new Promise(() => undefined)
  })
}))

// The bar is tested in its own package: only whether it shows matters here
vi.mock('@linagora/twake-bar', () => ({
  TWAKE_BAR_HEIGHT: '3rem',
  SdkProvider: ({ children }: { children: ReactNode }): ReactNode => children,
  TwakeBar: ({ app }: TwakeBarProps): ReactElement => (
    <header role="banner">{app.name}</header>
  )
}))

const detail = (id: string, name: string): Space => ({
  id,
  name,
  role: 'admin',
  createdAt: '2026-01-01T00:00:00.000Z',
  color: null,
  description: '',
  pinnedAt: null,
  openedAt: null,
  manages: true,
  apps: ['chat', 'tasks', 'mail'],
  chat: true,
  mail: true,
  homeserverUrl: 'https://matrix.acme.test',
  banner: null,
  members: [],
  groups: [],
  resources: [
    { kind: 'matrix_space', id: `!${id}:acme` },
    { kind: 'project', id: `project-${id}` },
    { kind: 'mailbox', id: `${id}@acme` }
  ]
})

function renderAt(path: string) {
  const spaces = fakeSpaces([
    {
      id: 'space-1',
      name: 'Design',
      role: 'admin',
      color: null,
      description: '',
      pinnedAt: '2026-10-01T08:00:00.000Z',
      openedAt: null,
      manages: true,
      members: []
    },
    {
      id: 'space-2',
      name: 'Launch',
      role: 'admin',
      color: null,
      description: '',
      pinnedAt: null,
      openedAt: null,
      manages: true,
      members: []
    }
  ])
  vi.mocked(spaces.get).mockImplementation(id =>
    Promise.resolve(
      id === 'space-1' ? detail('space-1', 'Design') : detail(id, 'Launch')
    )
  )
  const session = fakeSession(() => Promise.resolve(fakeUser('id-token')))
  return renderRoute(path, { session, spaces })
}

function frame(title: string): HTMLIFrameElement {
  const element = screen.getByTitle(title)
  if (!(element instanceof HTMLIFrameElement)) throw new Error('no frame')
  return element
}

const fillButton = () => screen.getByRole('button', { name: 'Full page' })
const leaveButton = () =>
  screen.getByRole('button', { name: 'Leave full page' })

// Inert itself or under an inert element
function isInert(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement)
    if (node.inert) return true
  return false
}

function expectChrome(shown: boolean) {
  const chrome = [
    screen.queryByRole('banner'),
    screen.queryByRole('list', { name: 'Pinned' }),
    screen.queryByRole('tablist')
  ]
  for (const element of chrome) {
    if (shown) expect(element).toBeInTheDocument()
    else expect(element).toBe(null)
  }
}

describe('full page', () => {
  it("gives the whole page to the tab's app, without loading its frame again", async () => {
    renderAt('/spaces/space-1/tasks')
    await screen.findByTitle('Tasks')
    const tasks = frame('Tasks')
    const loads = vi.fn()
    tasks.addEventListener('load', loads)

    fireEvent.click(fillButton())

    expectChrome(false)
    expect(
      screen.getByRole('heading', { level: 1, name: 'Design' })
    ).toBeInTheDocument()
    expect(screen.getByText('Tasks')).toBeInTheDocument()
    expect(frame('Tasks')).toBe(tasks)
    // The panel of the frames is named without its tab
    screen.getByRole('tabpanel', { name: 'Tasks' })

    fireEvent.click(leaveButton())

    expectChrome(true)
    expect(frame('Tasks')).toBe(tasks)
    expect(loads).not.toHaveBeenCalled()
  })

  it('moves the focus onto the way back, and back onto the button', async () => {
    renderAt('/spaces/space-1/tasks')
    await screen.findByTitle('Tasks')

    fireEvent.click(fillButton())
    await waitFor(() => {
      expect(leaveButton()).toHaveFocus()
    })

    fireEvent.click(leaveButton())
    await waitFor(() => {
      expect(fillButton()).toHaveFocus()
    })
  })

  it('gives the page back on Escape from TwakeSpace', async () => {
    renderAt('/spaces/space-1/tasks')
    await screen.findByTitle('Tasks')
    fireEvent.click(fillButton())

    fireEvent.keyDown(leaveButton(), { key: 'Escape' })

    expectChrome(true)
    await waitFor(() => {
      expect(fillButton()).toHaveFocus()
    })
  })

  it('closes the assistant, which the page given to the tab cannot close', async () => {
    renderAt('/spaces/space-1/feed')
    await screen.findByRole('tabpanel')
    fireEvent.click(screen.getByRole('button', { name: 'Twake AI assistant' }))
    expect(
      screen.getByRole('status', { name: 'Opening the assistant…' })
    ).toBeInTheDocument()

    fireEvent.click(fillButton())

    expect(
      screen.queryByRole('status', { name: 'Opening the assistant…' })
    ).toBe(null)
  })

  it('gives the page to a tab of TwakeSpace too, keeping its panel', async () => {
    renderAt('/spaces/space-1/feed')
    const panel = await screen.findByRole('tabpanel')

    fireEvent.click(fillButton())

    expectChrome(false)
    expect(screen.getByRole('tabpanel', { name: 'Feed' })).toBe(panel)
  })

  it("floats Chat's call over it, and keeps it once the call is done", async () => {
    renderAt('/spaces/space-1/chat')
    await screen.findByTitle('Chat')
    const chat = frame('Chat')
    fireEvent.click(fillButton())
    const post = (fill: boolean) => {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'twake-embed:fill-page', fill },
            origin: 'https://chat.test',
            source: chat.contentWindow
          })
        )
      })
    }

    await waitFor(() => {
      post(true)
      expect(getComputedStyle(chat).position).toBe('fixed')
    })
    // The page under the call stays usable
    expect(isInert(leaveButton())).toBe(false)

    post(false)

    expect(getComputedStyle(chat).position).not.toBe('fixed')
    expectChrome(false)
  })

  it('gives the page back when another space opens, or the space settings', async () => {
    const { router } = renderAt('/spaces/space-1/tasks')
    await screen.findByTitle('Tasks')
    fireEvent.click(fillButton())

    await act(() => router.navigate('/spaces/space-2/tasks'))

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Launch' })
    ).toBeInTheDocument()
    expectChrome(true)

    fireEvent.click(fillButton())
    await act(() => router.navigate('/spaces/space-2/settings'))

    expect(screen.queryByRole('button', { name: 'Leave full page' })).toBe(null)
    expect(screen.getByRole('list', { name: 'Pinned' })).toBeInTheDocument()
  })
})
