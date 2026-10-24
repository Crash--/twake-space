import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import type { FeedItem } from '@/application/feed'
import type { Space } from '@/application/spaces'
import { fakeFeed } from '@/testing/fakeFeed'
import { fakeSpaces } from '@/testing/fakeSpaces'
import { renderWithProviders } from '@/testing/renderWithProviders'
import { EmbeddedApps } from '@/ui/space/EmbeddedApps'
import { SpaceScreen } from '@/ui/space/SpaceScreen'

const roadmap: Space = {
  id: 'a1',
  name: 'Roadmap',
  role: 'editor',
  createdAt: new Date().toISOString(),
  color: null,
  description: 'Where the year is planned',
  pinnedAt: null,
  openedAt: null,
  manages: false,
  apps: ['chat', 'tasks', 'drive', 'mail', 'calendar'],
  chat: false,
  mail: true,
  homeserverUrl: null,
  chatUrl: null,
  banner: null,
  members: [],
  groups: [],
  resources: [
    { kind: 'matrix_space', id: null },
    { kind: 'project', id: 'project-1' },
    { kind: 'drive', id: null },
    { kind: 'mailbox', id: 'roadmap@acme' },
    { kind: 'calendar', id: 'cal-1' }
  ]
}

function Path() {
  return <output aria-label="path">{useLocation().pathname}</output>
}

function renderAt(
  path: string,
  space: Space | null = roadmap,
  feedItems: FeedItem[] = []
) {
  const spaces = fakeSpaces()
  vi.mocked(spaces.get).mockImplementation(id =>
    space?.id === id
      ? Promise.resolve(space)
      : Promise.reject(Object.assign(new Error('not found'), { status: 404 }))
  )
  renderWithProviders(
    <>
      <Routes>
        <Route path="/spaces/:spaceId/:tab?/*" element={<SpaceScreen />} />
      </Routes>
      <EmbeddedApps />
      <Path />
    </>,
    { spaces, path, feed: fakeFeed({ a1: feedItems }) }
  )
  return spaces
}

function openTab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }))
}

function isHidden(element: HTMLElement): boolean {
  return element.closest('[aria-hidden="true"]') !== null
}

// What cozy-external-bridge sends through comlink for `bridge.method(arg)`.
describe('SpaceScreen', () => {
  it("shows the space's name with its actions", async () => {
    renderAt('/spaces/a1/feed')

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Roadmap' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'More actions for Roadmap' })
    ).toBeInTheDocument()
  })

  it('records the visit for Recent once the space shows', async () => {
    const spaces = renderAt('/spaces/a1/feed')

    await screen.findByRole('heading', { level: 1, name: 'Roadmap' })

    await waitFor(() => {
      expect(spaces.markOpened).toHaveBeenCalledWith('a1')
    })
  })

  it('records no visit of a space it cannot show', async () => {
    const spaces = renderAt('/spaces/zz', null)

    await screen.findByText('This space does not exist, or you are not in it.')

    expect(spaces.markOpened).not.toHaveBeenCalled()
  })

  it('opens on the home, which every space has', async () => {
    renderAt('/spaces/a1', { ...roadmap, apps: ['chat', 'tasks'] })

    expect(
      await screen.findByRole('tab', { name: 'Home', selected: true })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('path')).toHaveTextContent('/spaces/a1/home')
  })

  it('turns Chat off without chat and says why', async () => {
    renderAt('/spaces/a1/tasks')

    expect(await screen.findByRole('tab', { name: 'Chat' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: 'Feed' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: 'Mail' })).toBeEnabled()
    expect(
      screen.getByText('Chat is not set up for your organization yet.')
    ).toBeInTheDocument()
  })

  it('turns Mail off without a validated mail domain and says why', async () => {
    renderAt('/spaces/a1/tasks', { ...roadmap, chat: true, mail: false })

    expect(await screen.findByRole('tab', { name: 'Mail' })).toBeDisabled()
    expect(
      screen.getByText(
        "Mail turns on once your organization's domain is validated."
      )
    ).toBeInTheDocument()
  })

  it('says once why Chat and Mail are both off', async () => {
    renderAt('/spaces/a1/tasks', { ...roadmap, chat: false, mail: false })

    expect(await screen.findByRole('tab', { name: 'Mail' })).toBeDisabled()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Chat and mail turn on once your organization's domain is validated."
    )
  })

  it('leaves a tab that is off for the first tab that is on', async () => {
    renderAt('/spaces/a1/chat')

    expect(
      await screen.findByRole('tab', { name: 'Home', selected: true })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('path')).toHaveTextContent('/spaces/a1/home')
  })

  it('keeps the tab in the URL', async () => {
    renderAt('/spaces/a1/tasks')

    fireEvent.click(await screen.findByRole('tab', { name: 'Drive' }))

    expect(
      screen.getByRole('tab', { name: 'Drive', selected: true })
    ).toBeInTheDocument()
    expect(screen.getByLabelText('path')).toHaveTextContent('/spaces/a1/drive')
  })

  it('frames the board a Tasks link points at', async () => {
    renderAt('/spaces/a1/tasks/boards/b1?task=T-1')

    expect(await screen.findByTitle('Projects and tasks')).toHaveAttribute(
      'src',
      'https://tasks.test/embed/projects/project-1/boards/b1?task=T-1'
    )
  })

  it("frames the space's team mailbox on the Mail tab", async () => {
    renderAt('/spaces/a1/mail')

    expect(await screen.findByTitle('Mail')).toHaveAttribute(
      'src',
      'https://mail.test/embed/team-mailboxes/roadmap%40acme'
    )
  })

  it("frames the space's shared drive on the Drive tab, kept alive", async () => {
    renderAt('/spaces/a1/drive', {
      ...roadmap,
      resources: roadmap.resources.map(r =>
        r.kind === 'drive' ? { ...r, id: 'sharing-1' } : r
      )
    })
    const frame = await screen.findByTitle('Drive')
    expect(frame).toHaveAttribute(
      'src',
      'https://alice-drive.twake.test/#/embed/sharings/sharing-1'
    )

    openTab('Feed')
    await screen.findByRole('tab', { name: 'Feed', selected: true })
    expect(screen.getByTitle('Drive')).toBe(frame)
    expect(isHidden(frame)).toBe(true)
  })

  it.each(['tasks', 'mail'])('shows the %s frame alone', async tab => {
    renderAt(`/spaces/a1/${tab}`)

    expect(await screen.findByRole('tabpanel')).toContainElement(
      document.querySelector('iframe')
    )
    expect(
      screen.queryByText('Where the year is planned')
    ).not.toBeInTheDocument()
    expect(document.querySelector('main img')).toBeNull()
  })

  it('greets on the home, with a card per app that opens its tab', async () => {
    renderAt('/spaces/a1/home')

    expect(
      await screen.findByRole('heading', { level: 2, name: /^Good \w+, / })
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open tasks' })).toHaveAttribute(
      'href',
      '/spaces/a1/tasks'
    )
    // Preparing, the tab is shown all the same; off, it is not.
    expect(screen.getByRole('link', { name: 'Open files' })).toHaveAttribute(
      'href',
      '/spaces/a1/drive'
    )
    expect(screen.getByRole('button', { name: 'Open chat' })).toBeDisabled()

    fireEvent.click(screen.getByRole('link', { name: 'Open calendar' }))
    expect(
      await screen.findByRole('tab', { name: 'Calendar', selected: true })
    ).toBeInTheDocument()
  })

  it('shows the banner on the home, not on the feed', async () => {
    renderAt('/spaces/a1/home')
    await screen.findByRole('tab', { name: 'Home', selected: true })
    expect(document.querySelector('main img')).not.toBeNull()

    openTab('Feed')
    await screen.findByRole('tab', { name: 'Feed', selected: true })
    expect(document.querySelector('main img')).toBeNull()
  })

  it('shows the banner an admin uploaded', async () => {
    const spaces = renderAt('/spaces/a1/home', {
      ...roadmap,
      banner: '2026-10-08T08:00:00.000Z'
    })

    await waitFor(() => {
      expect(document.querySelector('main img')).toHaveAttribute(
        'src',
        expect.stringMatching(/^data:image\/png;base64,/)
      )
    })
    expect(spaces.banner).toHaveBeenCalledWith('a1')
  })

  it('lets an admin upload a banner', async () => {
    const spaces = renderAt('/spaces/a1/home', { ...roadmap, role: 'admin' })
    await screen.findByRole('button', { name: 'Change the banner' })
    const image = new File(['png'], 'cover.png', { type: 'image/png' })

    fireEvent.change(screen.getByTestId('banner-file'), {
      target: { files: [image] }
    })

    await waitFor(() => {
      expect(spaces.setBanner).toHaveBeenCalledWith('a1', image)
    })
  })

  it('shows the upload in progress until the new banner is in', async () => {
    const spaces = renderAt('/spaces/a1/home', { ...roadmap, role: 'admin' })
    await screen.findByRole('button', { name: 'Change the banner' })
    const save = Promise.withResolvers<undefined>()
    const image = Promise.withResolvers<Blob>()
    vi.mocked(spaces.setBanner).mockReturnValue(save.promise)
    vi.mocked(spaces.banner).mockReturnValue(image.promise)
    vi.mocked(spaces.get).mockResolvedValue({
      ...roadmap,
      role: 'admin',
      banner: '2026-10-08T08:00:00.000Z'
    })

    fireEvent.change(screen.getByTestId('banner-file'), {
      target: { files: [new File(['png'], 'cover.png', { type: 'image/png' })] }
    })

    const button = await screen.findByRole('button', {
      name: 'Uploading the banner…'
    })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('progressbar')).toBeInTheDocument()

    act(() => {
      save.resolve(undefined)
    })
    await waitFor(() => {
      expect(spaces.banner).toHaveBeenCalledWith('a1')
    })
    expect(button).toHaveAccessibleName('Uploading the banner…')

    act(() => {
      image.resolve(new Blob(['png'], { type: 'image/png' }))
    })

    expect(
      await screen.findByRole('button', { name: 'Change the banner' })
    ).toHaveAttribute('aria-disabled', 'false')
    expect(document.querySelector('main img')).toHaveAttribute(
      'src',
      expect.stringMatching(/^data:image\/png;base64,/)
    )
  })

  it('refuses a banner that is no image the backend takes', async () => {
    const spaces = renderAt('/spaces/a1/home', { ...roadmap, role: 'admin' })
    await screen.findByRole('button', { name: 'Change the banner' })

    fireEvent.change(screen.getByTestId('banner-file'), {
      target: {
        files: [new File(['<svg/>'], 'cover.svg', { type: 'image/svg+xml' })]
      }
    })

    expect(
      await screen.findByText(
        'Pick a PNG, JPEG, WebP or GIF image of 5 MB at most.'
      )
    ).toBeInTheDocument()
    expect(spaces.setBanner).not.toHaveBeenCalled()
  })

  it.each([
    [413, 'The server refused the image as too large.'],
    [415, 'The server refused this type of image.'],
    [500, 'The banner could not be saved.']
  ])('says why the server refused a banner (%i)', async (status, notice) => {
    const spaces = renderAt('/spaces/a1/home', { ...roadmap, role: 'admin' })
    await screen.findByRole('button', { name: 'Change the banner' })
    vi.mocked(spaces.setBanner).mockRejectedValue(
      Object.assign(new Error('refused'), { status, code: null })
    )

    fireEvent.change(screen.getByTestId('banner-file'), {
      target: { files: [new File(['png'], 'cover.png', { type: 'image/png' })] }
    })

    expect(await screen.findByText(notice)).toBeInTheDocument()
  })

  it('leaves the banner to admins', async () => {
    renderAt('/spaces/a1/home')

    expect(await screen.findByText('Space users')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Change the banner' })
    ).not.toBeInTheDocument()
  })

  it("counts the space's members, and lets an admin manage them", async () => {
    const members = [
      {
        id: 'u1',
        username: 'alice',
        email: 'alice@acme.test',
        displayName: 'Alice Martin',
        workplaceFqdn: 'alice.acme.test',
        role: 'admin' as const
      },
      {
        id: 'u2',
        username: 'bob',
        email: 'bob@acme.test',
        displayName: null,
        workplaceFqdn: null,
        role: 'viewer' as const
      }
    ]
    renderAt('/spaces/a1/home', { ...roadmap, role: 'admin', members })

    expect(await screen.findByText('Space users')).toBeInTheDocument()
    expect(
      screen.getByLabelText('Alice Martin').querySelector('img')
    ).toHaveAttribute(
      'src',
      'https://alice.acme.test/public/avatar?fallback=404'
    )
    expect(
      screen.getByLabelText('bob').querySelector('img')
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Manage users' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('leaves managing the members to admins', async () => {
    renderAt('/spaces/a1/home')

    expect(await screen.findByText('Space users')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Manage users' })
    ).not.toBeInTheDocument()
  })

  it("shows the space's feed on the Feed tab, chat or not", async () => {
    renderAt('/spaces/a1/feed')

    expect(
      await screen.findByRole('tab', { name: 'Feed', selected: true })
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('textbox', { name: 'Text message' })
    ).toBeInTheDocument()
  })

  it('shows a resource without an id as being prepared', async () => {
    renderAt('/spaces/a1/drive')

    expect(
      await screen.findByText('Drive is being prepared for this space.')
    ).toBeInTheDocument()
  })

  it('says the app is not ready once it should have been, and checks again', async () => {
    const spaces = renderAt('/spaces/a1/drive', {
      ...roadmap,
      createdAt: '2026-01-01T00:00:00.000Z'
    })

    expect(
      await screen.findByText(
        'Drive is not ready yet. Try again later, and tell your administrator if it stays this way.'
      )
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => {
      expect(spaces.get).toHaveBeenCalledTimes(2)
    })
  })

  it('has no tab for an app this deployment does not provide', async () => {
    renderAt('/spaces/a1/tasks', {
      ...roadmap,
      resources: roadmap.resources.filter(r => r.kind !== 'drive')
    })

    expect(
      await screen.findByRole('tab', { name: 'Projects and tasks' })
    ).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'Drive' })).not.toBeInTheDocument()
  })

  it('says so when the space is not found', async () => {
    renderAt('/spaces/zz', null)

    expect(
      await screen.findByText(
        'This space does not exist, or you are not in it.'
      )
    ).toBeInTheDocument()
  })

  it('keeps the Mail frame alive, hidden, on the other tabs', async () => {
    renderAt('/spaces/a1/mail')
    const frame = await screen.findByTitle('Mail')

    openTab('Feed')
    expect(
      await screen.findByRole('tab', { name: 'Feed', selected: true })
    ).toBeInTheDocument()
    expect(screen.getByTitle('Mail')).toBe(frame)
    expect(isHidden(frame)).toBe(true)

    openTab('Mail')
    await waitFor(() => {
      expect(isHidden(frame)).toBe(false)
    })
    expect(screen.getByTitle('Mail')).toBe(frame)
  })

  it('keeps the Tasks and Mail frames of the space side by side', async () => {
    renderAt('/spaces/a1/tasks')
    const tasks = await screen.findByTitle('Projects and tasks')

    openTab('Mail')
    const mail = await screen.findByTitle('Mail')

    expect(screen.getByTitle('Projects and tasks')).toBe(tasks)
    expect(isHidden(tasks)).toBe(true)
    expect(isHidden(mail)).toBe(false)
  })

  it('mounts the frame of every ready tab up front, hidden', async () => {
    renderAt('/spaces/a1/feed')
    await screen.findByRole('tab', { name: 'Feed', selected: true })

    const mail = await screen.findByTitle('Mail')
    const tasks = await screen.findByTitle('Projects and tasks')
    expect(isHidden(mail)).toBe(true)
    expect(isHidden(tasks)).toBe(true)
    // Chat is off and Drive still preparing: no frame for either
    expect(screen.queryByTitle('Chat')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Drive')).not.toBeInTheDocument()
  })

  describe('counts on the tabs', () => {
    function postBadges(
      title: string,
      origin: string,
      badges: { resourceId: string; count: number }[]
    ) {
      const element = screen.getByTitle(title)
      if (!(element instanceof HTMLIFrameElement)) throw new Error('no frame')
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'twake-embed:badges', badges },
            origin,
            source: element.contentWindow
          })
        )
      })
    }

    async function reportMail(count: number) {
      await screen.findByTitle('Mail')
      await waitFor(() => {
        postBadges('Mail', 'https://mail.test', [
          { resourceId: 'roadmap@acme', count },
          { resourceId: 'other@acme', count: 7 }
        ])
        expect(screen.getByRole('tab', { name: /^Mail/ })).toHaveAccessibleName(
          count > 0 ? `Mail, ${String(count)} new` : 'Mail'
        )
      })
    }

    it("shows the app's count for the space's resource, in the tab's name", async () => {
      renderAt('/spaces/a1/feed')
      await reportMail(3)

      const tab = screen.getByRole('tab', { name: 'Mail, 3 new' })
      expect(tab).toHaveTextContent('Mail3')
      expect(
        screen.getByRole('tab', { name: 'Projects and tasks' })
      ).toHaveTextContent(/^Projects and tasks$/)
    })

    it("shows the same count on the app's card of the home", async () => {
      renderAt('/spaces/a1/home')
      await reportMail(3)

      expect(
        screen.getByRole('heading', { level: 3, name: 'Team mailbox, 3 new' })
      ).toHaveTextContent('Team mailbox3')
    })

    it('shows 99+ above 99, and says the count in full', async () => {
      renderAt('/spaces/a1/feed')
      await reportMail(100)

      expect(
        screen.getByRole('tab', { name: 'Mail, 100 new' })
      ).toHaveTextContent('Mail99+')
    })

    it('shows 99 as it is', async () => {
      renderAt('/spaces/a1/feed')
      await reportMail(99)

      expect(
        screen.getByRole('tab', { name: 'Mail, 99 new' })
      ).toHaveTextContent('Mail99')
    })

    it('shows nothing at 0, or without a count for the resource', async () => {
      renderAt('/spaces/a1/feed')
      await reportMail(0)

      expect(screen.getByRole('tab', { name: 'Mail' })).toHaveTextContent(
        /^Mail$/
      )
      expect(screen.getByRole('tab', { name: 'Feed' })).toHaveTextContent(
        /^Feed$/
      )
    })

    it('replaces the previous snapshot, and forgets it when the frame reloads', async () => {
      renderAt('/spaces/a1/feed')
      await reportMail(3)

      postBadges('Mail', 'https://mail.test', [])
      expect(
        await screen.findByRole('tab', { name: 'Mail' })
      ).toBeInTheDocument()

      postBadges('Mail', 'https://mail.test', [
        { resourceId: 'roadmap@acme', count: 4 }
      ])
      expect(
        await screen.findByRole('tab', { name: 'Mail, 4 new' })
      ).toBeInTheDocument()

      fireEvent.load(screen.getByTitle('Mail'))
      expect(
        await screen.findByRole('tab', { name: 'Mail' })
      ).toBeInTheDocument()
    })

    it('ignores counts that do not come from the app', async () => {
      renderAt('/spaces/a1/feed')
      await screen.findByTitle('Mail')

      postBadges('Mail', 'https://evil.test', [
        { resourceId: 'roadmap@acme', count: 3 }
      ])
      // Tasks' frame is not Mail's
      postBadges('Projects and tasks', 'https://mail.test', [
        { resourceId: 'roadmap@acme', count: 3 }
      ])
      await act(() => Promise.resolve())

      expect(screen.getByRole('tab', { name: 'Mail' })).toHaveTextContent(
        /^Mail$/
      )
    })

    it('has no frame, so no count, for a tab that is off', async () => {
      renderAt('/spaces/a1/feed', { ...roadmap, mail: false })
      await screen.findByRole('tab', { name: 'Mail' })

      expect(screen.queryByTitle('Mail')).not.toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Mail' })).toBeDisabled()
    })
  })

  describe('figures on the home', () => {
    function postMetadata(title: string, origin: string, data: unknown): void {
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

    function figure(label: string): HTMLElement {
      const element = screen.getByText(label).parentElement
      if (element === null) throw new Error('no tile')
      return element
    }

    it('waits for the apps, then shows what they report', async () => {
      renderAt('/spaces/a1/home')
      await screen.findByTitle('Projects and tasks')

      expect(figure('Tasks completed')).toHaveAttribute('aria-busy', 'true')
      expect(figure('Upcoming events')).toHaveAttribute('aria-busy', 'true')
      // The space's drive is still being prepared
      expect(figure('Shared files')).toHaveAttribute('aria-busy', 'true')

      postMetadata('Projects and tasks', 'https://tasks.test', {
        type: 'twake-embed:metadata',
        metadata: [
          { resourceId: 'project-1', name: 'tasks.done', value: 21 },
          { resourceId: 'project-1', name: 'tasks.total', value: 25 },
          { resourceId: 'project-1', name: 'badge', value: 2 }
        ]
      })
      postMetadata('Calendar', 'https://calendar.test', {
        type: 'twake-embed:metadata',
        metadata: [{ resourceId: 'cal-1', name: 'events.upcoming', value: 3 }]
      })

      expect(figure('Tasks completed')).toHaveTextContent('84%Tasks completed')
      expect(figure('Upcoming events')).toHaveTextContent('3Upcoming events')
      expect(
        screen.getByRole('tab', { name: 'Projects and tasks, 2 new' })
      ).toBeInTheDocument()
    })

    it('shows no figure when the app does not report one in time', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        renderAt('/spaces/a1/home')
        await screen.findByTitle('Projects and tasks')

        act(() => {
          vi.advanceTimersByTime(10_000)
        })

        expect(figure('Tasks completed')).toHaveTextContent('–Tasks completed')
      } finally {
        vi.useRealTimers()
      }
    })

    it('shows no share of an empty project', async () => {
      renderAt('/spaces/a1/home')
      await screen.findByTitle('Projects and tasks')

      postMetadata('Projects and tasks', 'https://tasks.test', {
        type: 'twake-embed:metadata',
        metadata: [
          { resourceId: 'project-1', name: 'tasks.done', value: 0 },
          { resourceId: 'project-1', name: 'tasks.total', value: 0 }
        ]
      })

      expect(figure('Tasks completed')).toHaveTextContent('–Tasks completed')
    })

    it('takes the counts from the metadata of an app that sends both', async () => {
      renderAt('/spaces/a1/home')
      await screen.findByTitle('Projects and tasks')

      postMetadata('Projects and tasks', 'https://tasks.test', {
        type: 'twake-embed:metadata',
        metadata: [{ resourceId: 'project-1', name: 'badge', value: 2 }]
      })
      postMetadata('Projects and tasks', 'https://tasks.test', {
        type: 'twake-embed:badges',
        badges: [{ resourceId: 'project-1', count: 5 }]
      })

      expect(
        screen.getByRole('tab', { name: 'Projects and tasks, 2 new' })
      ).toBeInTheDocument()
    })

    it('keeps the badges of an app whose metadata has no counts', async () => {
      renderAt('/spaces/a1/home')
      await screen.findByTitle('Projects and tasks')

      postMetadata('Projects and tasks', 'https://tasks.test', {
        type: 'twake-embed:badges',
        badges: [{ resourceId: 'project-1', count: 5 }]
      })
      postMetadata('Projects and tasks', 'https://tasks.test', {
        type: 'twake-embed:metadata',
        metadata: [{ resourceId: 'project-1', name: 'tasks.total', value: 0 }]
      })

      expect(
        screen.getByRole('tab', { name: 'Projects and tasks, 5 new' })
      ).toBeInTheDocument()
    })

    it('has no figure for an app the space has not', async () => {
      renderAt('/spaces/a1/home', { ...roadmap, apps: ['chat', 'mail'] })
      await screen.findByRole('heading', { level: 2 })

      expect(screen.queryByText('Tasks completed')).not.toBeInTheDocument()
      expect(screen.queryByText('Upcoming events')).not.toBeInTheDocument()
    })
  })

  describe('search', () => {
    const items: FeedItem[] = [
      {
        id: 'post-1',
        kind: 'post',
        category: 'messages',
        time: '2026-10-07T09:00:00.000Z',
        updatedAt: '2026-10-07T09:00:00.000Z',
        reactions: [],
        author: { type: 'user', id: 'u-bob', name: 'Bob Durand' },
        body: 'The launch plan is ready',
        editedAt: null,
        poll: null
      },
      {
        id: 'card-1',
        kind: 'card',
        category: 'activities',
        time: '2026-10-07T08:00:00.000Z',
        updatedAt: '2026-10-07T08:00:00.000Z',
        reactions: [],
        type: 'com.twake.tasks.task.created.v1',
        actor: null,
        object: {
          type: 'task',
          id: 'T-1',
          title: 'Plan the launch',
          container: { kind: 'project', id: 'project-1' }
        },
        preview: null,
        state: {},
        files: null
      }
    ]

    async function search(text: string) {
      const input = await screen.findByRole('combobox', { name: 'Search' })
      fireEvent.change(input, { target: { value: text } })
      return input
    }

    it('suggests feed items as one types and opens a post in the feed', async () => {
      renderAt('/spaces/a1/tasks', roadmap, items)
      await search('launch')

      const options = await screen.findAllByRole('option')
      expect(options.map(option => option.textContent)).toEqual([
        'BDThe launch plan is readyBob Durand',
        'Plan the launchTasks'
      ])
      fireEvent.click(screen.getByRole('option', { name: /launch plan/ }))

      expect(screen.getByLabelText('path')).toHaveTextContent('/spaces/a1/feed')
      await waitFor(() => {
        expect(
          screen.getByRole('article', { name: 'Bob Durand' })
        ).toHaveFocus()
      })
    })

    it("opens a card in its app's tab", async () => {
      renderAt('/spaces/a1/feed', roadmap, items)
      await search('plan the')

      fireEvent.click(
        await screen.findByRole('option', { name: /Plan the launch/ })
      )

      expect(screen.getByLabelText('path')).toHaveTextContent(
        '/spaces/a1/tasks'
      )
    })

    it('says when nothing matches', async () => {
      renderAt('/spaces/a1/feed', roadmap, items)
      await search('budget')

      expect(await screen.findByText('No results')).toBeInTheDocument()
    })

    it('loads older pages of the feed until the post shows', async () => {
      const posts: FeedItem[] = Array.from({ length: 25 }, (_, i) => ({
        id: `post-${String(i)}`,
        kind: 'post',
        category: 'messages',
        time: new Date(Date.UTC(2026, 9, 1, 8, i)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 9, 1, 8, i)).toISOString(),
        reactions: [],
        author: { type: 'user', id: 'u-bob', name: `Author ${String(i)}` },
        body: i === 0 ? 'The oldest note' : `Note ${String(i)}`,
        editedAt: null,
        poll: null
      }))
      renderAt('/spaces/a1/feed', roadmap, posts)
      await search('oldest')

      fireEvent.click(await screen.findByRole('option', { name: /oldest/ }))

      await waitFor(() => {
        expect(screen.getByRole('article', { name: 'Author 0' })).toHaveFocus()
      })
    })
  })
})
