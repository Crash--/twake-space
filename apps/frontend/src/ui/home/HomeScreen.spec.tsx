import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FeedItem } from '@/application/feed'
import type { SpaceSummary } from '@/application/spaces'
import { fakeFeed } from '@/testing/fakeFeed'
import { fakeSettings } from '@/testing/fakeSettings'
import { fakeSpaces } from '@/testing/fakeSpaces'
import { renderRoute, renderWithProviders } from '@/testing/renderWithProviders'
import { HomeScreen } from '@/ui/home/HomeScreen'

describe('HomeScreen', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('greets the person by first name with the date, and titles the page with the app name', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 29, 14))
    renderWithProviders(<HomeScreen />)

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Good afternoon, Alice'
      })
    ).toBeInTheDocument()
    expect(screen.getByText('Tuesday, September 29')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    await waitFor(() => {
      expect(document.title).toBe('Twake Space')
    })
  })

  it('keeps saying good evening past midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 30, 0, 49))
    renderWithProviders(<HomeScreen />)

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Good evening, Alice'
      })
    ).toBeInTheDocument()
  })

  it('greets and dates in the timezone set in Twake Workplace', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-29T23:30:00Z'))
    renderWithProviders(<HomeScreen />, {
      settings: fakeSettings({ timezone: 'Asia/Tokyo' })
    })

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Good morning, Alice'
      })
    ).toBeInTheDocument()
    expect(screen.getByText('Wednesday, September 30')).toBeInTheDocument()
  })

  it('greets by the display name set in Twake Workplace', async () => {
    renderWithProviders(<HomeScreen />, {
      settings: fakeSettings({ displayName: 'Ali Martin' })
    })

    expect(
      await screen.findByRole('heading', { level: 1, name: /, Ali$/ })
    ).toBeInTheDocument()
  })

  it('keeps the browser timezone when Twake Workplace sets one it does not know', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 29, 14))
    renderWithProviders(<HomeScreen />, {
      settings: fakeSettings({ timezone: 'Mars/Olympus' })
    })

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Good afternoon, Alice'
      })
    ).toBeInTheDocument()
  })

  it('follows the UI language', async () => {
    renderWithProviders(<HomeScreen />, { lang: 'fr' })

    expect(await screen.findByRole('main')).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('fr')
  })

  it("shows the person's spaces as cards after a create card, each opening the space", async () => {
    const spaces = fakeSpaces([
      {
        id: 'a1',
        name: 'Design Sprint',
        role: 'admin',
        color: null,
        description: '',
        pinnedAt: null,
        openedAt: null,
        manages: true,
        members: []
      },
      {
        id: 'b2',
        name: 'Roadmap',
        role: 'viewer',
        color: null,
        description: '',
        pinnedAt: null,
        openedAt: null,
        manages: false,
        members: []
      }
    ])
    renderWithProviders(<HomeScreen />, { spaces })

    const all = await screen.findByRole('region', { name: 'All spaces' })
    const [create, sprint, roadmap] = within(all).getAllByRole('listitem')
    expect(create).toHaveTextContent('Create new space')
    expect(sprint).toHaveTextContent('Design Sprint')
    expect(roadmap).toHaveTextContent('Roadmap')
    expect(
      within(all).getByRole('link', { name: 'Design Sprint' })
    ).toHaveAttribute('href', '/spaces/a1')
  })

  it('shows the pinned spaces above all spaces, which keep them', async () => {
    const spaces = fakeSpaces([
      {
        id: 'a1',
        name: 'Design Sprint',
        role: 'admin',
        color: null,
        description: '',
        pinnedAt: null,
        openedAt: null,
        manages: true,
        members: []
      },
      {
        id: 'b2',
        name: 'Roadmap',
        role: 'viewer',
        color: null,
        description: '',
        pinnedAt: '2026-10-01T08:00:00.000Z',
        openedAt: null,
        manages: false,
        members: []
      }
    ])
    renderWithProviders(<HomeScreen />, { spaces })

    const pinned = await screen.findByRole('region', { name: 'Pinned' })
    expect(
      within(pinned)
        .getAllByRole('listitem')
        .map(item => item.textContent)
    ).toEqual([expect.stringContaining('Roadmap')])
    const all = screen.getByRole('region', { name: 'All spaces' })
    expect(within(all).getAllByRole('listitem')).toHaveLength(3)
  })

  it('shows no Pinned section when nothing is pinned', async () => {
    renderWithProviders(<HomeScreen />, {
      spaces: fakeSpaces([
        {
          id: 'a1',
          name: 'Design Sprint',
          role: 'admin',
          color: null,
          description: '',
          pinnedAt: null,
          openedAt: null,
          manages: true,
          members: []
        }
      ])
    })

    await screen.findByRole('region', { name: 'All spaces' })
    expect(screen.queryByRole('region', { name: 'Pinned' })).toBe(null)
  })

  describe('since the last visit', () => {
    const space = (id: string, name: string): SpaceSummary => ({
      id,
      name,
      role: 'editor',
      color: null,
      description: '',
      pinnedAt: null,
      openedAt: null,
      manages: false,
      members: []
    })
    const post = (id: string, time: string): FeedItem => ({
      id,
      kind: 'post',
      category: 'messages',
      time,
      updatedAt: time,
      reactions: [],
      author: { type: 'user', id: 'u-bob', name: 'Bob' },
      body: 'Hello',
      editedAt: null
    })

    it('lists the spaces with news, those with mentions first, each opening the space', async () => {
      renderWithProviders(<HomeScreen />, {
        spaces: fakeSpaces([
          space('a1', 'Design Sprint'),
          space('b2', 'Roadmap'),
          space('c3', 'Quiet')
        ]),
        feed: fakeFeed(
          {
            a1: [
              post('p1', '2026-10-05T09:00:00.000Z'),
              post('p2', '2026-10-05T11:00:00.000Z'),
              post('p3', '2026-10-05T12:00:00.000Z')
            ],
            b2: [post('p4', '2026-10-05T11:00:00.000Z')],
            c3: [post('p5', '2026-10-05T09:00:00.000Z')]
          },
          {
            readAt: {
              a1: '2026-10-05T10:00:00.000Z',
              c3: '2026-10-05T10:00:00.000Z'
            },
            mentions: { b2: 1 }
          }
        )
      })

      const news = await screen.findByRole('region', {
        name: 'Since your last visit'
      })
      await waitFor(() => {
        expect(
          within(news)
            .getAllByRole('listitem')
            .map(item => item.textContent)
        ).toEqual([
          expect.stringContaining('Roadmap1 mention'),
          expect.stringContaining('Design Sprint2 new items')
        ])
      })
      expect(
        within(news).getByRole('link', { name: 'Roadmap' })
      ).toHaveAttribute('href', '/spaces/b2')
    })

    it('says when nothing is new', async () => {
      renderWithProviders(<HomeScreen />, {
        spaces: fakeSpaces([space('a1', 'Design Sprint')])
      })

      expect(
        await screen.findByText('Nothing new in your spaces')
      ).toBeInTheDocument()
    })

    it('leaves the summary out when it cannot be read', async () => {
      const feed = fakeFeed()
      vi.mocked(feed.news).mockRejectedValue(new Error('down'))
      renderWithProviders(<HomeScreen />, {
        spaces: fakeSpaces([space('a1', 'Design Sprint')]),
        feed
      })

      await screen.findByRole('region', { name: 'All spaces' })
      await waitFor(() => {
        expect(feed.news).toHaveBeenCalled()
      })
      expect(
        screen.queryByRole('region', { name: 'Since your last visit' })
      ).toBe(null)
    })
  })

  it('shows an empty state with the create action when there is no space', async () => {
    renderWithProviders(<HomeScreen />)

    expect(
      await screen.findByText('Create your first space')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create a space' })
    ).toBeInTheDocument()
  })

  it('creates a space with the description, color and apps picked, and opens it', async () => {
    const spaces = fakeSpaces()
    const { router } = renderRoute('/', { spaces })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create a space' })
    )
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('button', { name: 'Next' })).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('Space name'), {
      target: { value: '  Launch  ' }
    })
    fireEvent.change(within(dialog).getByLabelText('Describe (optional)'), {
      target: { value: ' Ship it ' }
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Personalize space' })
    )
    fireEvent.click(within(dialog).getByRole('radio', { name: '#46a2ff' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))

    expect(
      within(dialog).getByRole('checkbox', { name: 'Files' })
    ).toBeChecked()
    expect(
      within(dialog).getByRole('checkbox', { name: 'Calendar' })
    ).not.toBeChecked()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Chat' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Calendar' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/spaces/space-1')
    })
    expect(spaces.create).toHaveBeenCalledWith({
      name: 'Launch',
      description: 'Ship it',
      color: '#46a2ff',
      apps: ['drive', 'tasks', 'calendar']
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('offers only the apps a space can have a tab for', async () => {
    renderWithProviders(<HomeScreen />)

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create a space' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Space name'), {
      target: { value: 'Launch' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))

    expect(
      (await within(dialog).findAllByRole('checkbox')).map(
        box => box.closest('label')?.textContent
      )
    ).toEqual(['Files', 'Chat', 'Projects and tasks', 'Calendar', 'Mail'])
    expect(
      within(dialog).queryByRole('button', { name: 'Add shortcut' })
    ).not.toBeInTheDocument()
  })

  it('offers only the apps the deployment and the organization provide', async () => {
    const spaces = fakeSpaces()
    vi.mocked(spaces.apps).mockResolvedValue(['tasks', 'mail'])
    renderWithProviders(<HomeScreen />, { spaces })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create a space' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Space name'), {
      target: { value: 'Launch' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))

    expect(
      (await within(dialog).findAllByRole('checkbox')).map(
        box => box.closest('label')?.textContent
      )
    ).toEqual(['Projects and tasks', 'Mail'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(spaces.create).toHaveBeenCalledWith(
        expect.objectContaining({ apps: ['tasks'] })
      )
    })
  })

  it('keeps the dialog open and says so when the creation fails', async () => {
    const spaces = fakeSpaces()
    vi.mocked(spaces.create).mockRejectedValue(new Error('down'))
    renderWithProviders(<HomeScreen />, { spaces })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create a space' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Space name'), {
      target: { value: 'Launch' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(
      await within(dialog).findByText('The space could not be created.')
    ).toBeInTheDocument()
  })

  it('says the spaces are loading', async () => {
    const spaces = fakeSpaces()
    vi.mocked(spaces.list).mockReturnValue(new Promise(() => undefined))
    renderWithProviders(<HomeScreen />, { spaces })

    expect(
      await screen.findByRole('status', { name: 'Loading spaces…' })
    ).toBeInTheDocument()
  })

  it('says so when the spaces cannot be loaded', async () => {
    const spaces = fakeSpaces()
    vi.mocked(spaces.list).mockRejectedValue(
      Object.assign(new Error('forbidden'), { status: 403 })
    )
    renderWithProviders(<HomeScreen />, { spaces })

    expect(
      await screen.findByText('Your spaces could not be loaded.')
    ).toBeInTheDocument()
  })
})
