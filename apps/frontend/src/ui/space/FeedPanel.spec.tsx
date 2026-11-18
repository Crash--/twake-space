import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import {
  approvalState,
  type Approver,
  type Decision,
  type FeedCard,
  type Announcement,
  type FeedItem,
  type FeedPost,
  type Form
} from '@/application/feed'
import type { Space } from '@/application/spaces'
import { fakeFeed } from '@/testing/fakeFeed'
import { fakeLive } from '@/testing/fakeLive'
import { stubPhoneScreen } from '@/testing/phoneScreen'
import { renderWithProviders } from '@/testing/renderWithProviders'
import { CallWindow } from '@/ui/call/CallWindow'
import { useLiveUpdates } from '@/ui/live/useLiveUpdates'
import { uploadToDrive } from '@/ui/space/driveUpload'
import { FeedPanel } from '@/ui/space/FeedPanel'

vi.mock('@/ui/space/driveUpload', () => ({
  uploadToDrive: vi.fn(() => Promise.resolve())
}))

const roadmap: Space = {
  id: 'a1',
  name: 'Roadmap',
  role: 'editor',
  createdAt: '2026-10-01T08:00:00.000Z',
  color: null,
  description: '',
  pinnedAt: null,
  openedAt: null,
  manages: false,
  apps: ['chat', 'tasks', 'mail', 'calendar'],
  chat: true,
  mail: true,
  homeserverUrl: null,
  chatUrl: null,
  banner: null,
  // I reach this space through a linked group, not as a direct member.
  members: [],
  groups: [{ id: 'g-team', name: 'Team', role: 'editor' }],
  resources: [
    { kind: 'project', id: 'project-1' },
    { kind: 'mailbox', id: 'roadmap@acme' },
    { kind: 'calendar', id: 'cal-1' }
  ]
}

const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 7, 8, minute)).toISOString()

const post = (minute: number, overrides: Partial<FeedPost> = {}): FeedPost => ({
  id: `post-${String(minute)}`,
  kind: 'post',
  category: 'messages',
  time: at(minute),
  updatedAt: at(minute),
  reactions: [],
  author: { type: 'user', id: 'u-bob', name: 'Bob Durand' },
  body: `Message ${String(minute)}`,
  editedAt: null,
  poll: null,
  approval: null,
  announcement: null,
  feedback: null,
  form: null,
  ...overrides
})

const task: FeedCard = {
  id: 'task-card',
  kind: 'card',
  category: 'activities',
  time: at(1),
  updatedAt: at(1),
  reactions: [],
  type: 'com.twake.tasks.task.completed.v1',
  actor: { type: 'user', id: 'u-bob', name: 'Bob Durand' },
  object: {
    type: 'task',
    id: 'T-1',
    title: 'Write the brief',
    container: { kind: 'project', id: 'project-1' }
  },
  preview: null,
  state: {},
  files: null
}

const mail: FeedCard = {
  ...task,
  id: 'mail-card',
  category: 'messages',
  time: at(2),
  type: 'com.twake.mail.message.received.v1',
  actor: null,
  object: {
    type: 'message',
    id: 'm-1',
    title: 'Partner feedback',
    container: { kind: 'mailbox', id: 'roadmap@acme' }
  }
}

const event: FeedCard = {
  ...task,
  id: 'event-card',
  category: 'events',
  time: at(3),
  type: 'com.twake.calendar.event.rescheduled.v1',
  actor: { type: 'user', id: null, name: null },
  object: {
    type: 'event',
    id: 'e-1',
    title: 'Roadmap review',
    container: { kind: 'calendar', id: 'cal-1' }
  },
  state: {
    start: '2026-10-09T09:00:00Z',
    end: '2026-10-09T10:00:00Z',
    allDay: false,
    location: 'Room 4',
    previous: { start: '2026-10-09T08:00:00Z', end: '2026-10-09T09:00:00Z' }
  }
}

function renderFeed(
  items: FeedItem[],
  {
    space = roadmap,
    pageSize,
    readAt,
    live = fakeLive()
  }: {
    space?: Space
    pageSize?: number
    readAt?: string
    live?: ReturnType<typeof fakeLive>
  } = {}
) {
  const feed = fakeFeed(
    { a1: items },
    {
      roles: { a1: space.role },
      ...(pageSize && { pageSize }),
      ...(readAt && { readAt: { a1: readAt } })
    }
  )
  renderWithProviders(<LiveFeed space={space} />, { feed, live })
  return { feed, live }
}

function LiveFeed({ space }: { space: Space }) {
  useLiveUpdates()
  return (
    <>
      <FeedPanel space={space} />
      <CallWindow />
      <output aria-label="Address">{useLocation().pathname}</output>
    </>
  )
}

const articles = () =>
  screen.getAllByRole('article').map(a => a.getAttribute('aria-label'))

describe('FeedPanel', () => {
  it('shows the newest item last, above the composer', async () => {
    renderFeed([post(5), task, post(9)])

    await screen.findByText('Message 9')
    expect(articles()).toEqual([
      'Bob Durand: Write the brief',
      'Bob Durand',
      'Bob Durand'
    ])
    expect(screen.getAllByText(/^Message/).map(m => m.textContent)).toEqual([
      'Message 5',
      'Message 9'
    ])
    expect(screen.getByRole('textbox', { name: 'Text message' })).toBeVisible()
  })

  it('says what each app card is about, and opens its tab', async () => {
    renderFeed([task, mail, event])

    const taskCard = await screen.findByRole('article', {
      name: 'Bob Durand: Write the brief'
    })
    expect(within(taskCard).getByText('completed a task')).toBeInTheDocument()
    expect(
      within(taskCard).getByRole('link', { name: 'Open in Tasks' })
    ).toHaveAttribute('href', '/spaces/a1/tasks')

    const mailCard = screen.getByRole('article', {
      name: 'Mail: Partner feedback'
    })
    expect(within(mailCard).getByText('New email received')).toBeInTheDocument()
    expect(
      within(mailCard).getByRole('link', { name: 'Open in Mail' })
    ).toHaveAttribute('href', '/spaces/a1/mail/email/m-1')

    const eventCard = screen.getByRole('article', {
      name: 'Someone: Roadmap review'
    })
    expect(
      within(eventCard).getByText('rescheduled an event')
    ).toBeInTheDocument()
    expect(within(eventCard).getByText(/Moved from/)).toBeInTheDocument()
    expect(within(eventCard).getByText(/Room 4/)).toBeInTheDocument()
    expect(
      within(eventCard).getByRole('link', { name: 'View event' })
    ).toHaveAttribute('href', '/spaces/a1/calendar/events/e-1')
  })

  it.each([
    { start: '1900-00-00', end: '1900-00-00', allDay: true },
    {
      start: '2026-10-08T09:00:00Z',
      end: '2026-10-08T10:00:00Z',
      allDay: true
    },
    { start: 'tomorrow', end: 'tomorrow', allDay: false }
  ])('shows a calendar card whose times do not parse (%o)', async state => {
    renderFeed([{ ...event, state }])

    expect(await screen.findByText('Roadmap review')).toBeInTheDocument()
  })

  it('shows the time of an event whose previous time does not parse', async () => {
    renderFeed([
      {
        ...event,
        state: {
          start: '2026-10-09T09:00:00Z',
          end: '2026-10-09T10:00:00Z',
          previous: { start: '+275760-00-00', end: '1900-00-00' }
        }
      }
    ])

    const eventCard = await screen.findByRole('article', {
      name: 'Someone: Roadmap review'
    })
    expect(within(eventCard).getByText(/1 hour/)).toBeInTheDocument()
    expect(within(eventCard).queryByText(/Moved from/)).not.toBeInTheDocument()
  })

  describe('a Drive file', () => {
    const driveSpace: Space = {
      ...roadmap,
      apps: [...roadmap.apps, 'drive'],
      resources: [...roadmap.resources, { kind: 'drive', id: 'drive-1' }]
    }
    const file = (action: string): FeedCard => ({
      ...task,
      id: `file-${action}`,
      category: 'files',
      type: `com.twake.drive.file.${action}.v1`,
      object: {
        type: 'file',
        id: 'f-1',
        title: 'Budget 2027.xlsx',
        container: { kind: 'drive', id: 'drive-1' }
      }
    })

    it('shows one just added as a card with its type, and opens the drive tab', async () => {
      renderFeed([file('created')], { space: driveSpace })

      const card = await screen.findByRole('article', {
        name: 'Bob Durand: Budget 2027.xlsx'
      })
      expect(within(card).getByText('added a file')).toBeInTheDocument()
      expect(within(card).getByText('Budget 2027.xlsx')).toBeInTheDocument()
      expect(within(card).getByText('XLSX')).toBeInTheDocument()
      expect(
        within(card).getByRole('link', { name: 'Open in Drive' })
      ).toHaveAttribute('href', '/spaces/a1/drive')
    })

    it('shows one updated as a line with its type and where it comes from', async () => {
      renderFeed([file('updated')], { space: driveSpace })

      const card = await screen.findByRole('article', {
        name: 'Bob Durand: Budget 2027.xlsx'
      })
      expect(within(card).getByText('updated a file')).toBeInTheDocument()
      expect(within(card).getByText('XLSX · From Drive')).toBeInTheDocument()
    })

    const digest = (files: FeedCard['files']): FeedCard => ({
      ...task,
      id: 'folder-q4',
      category: 'files',
      type: 'com.twake.drive.folder.changed.v1',
      object: {
        type: 'folder',
        id: 'q4',
        title: 'Q4 assets',
        container: { kind: 'drive', id: 'drive-1' }
      },
      files
    })

    it('counts the files of a folder digest, leaving out a count of 0, with the first names', async () => {
      renderFeed(
        [
          digest({
            created: 1200,
            updated: 3,
            deleted: 0,
            samples: ['logo.svg', 'banner.png']
          })
        ],
        { space: driveSpace }
      )

      const card = await screen.findByRole('article', {
        name: 'Bob Durand: Q4 assets'
      })
      expect(
        within(card).getByText('added 1,200 files and updated 3 files')
      ).toBeInTheDocument()
      expect(within(card).getByText('Q4 assets')).toBeInTheDocument()
      expect(within(card).getByText('logo.svg, banner.png')).toBeInTheDocument()
      expect(
        within(card).getByRole('link', { name: 'Open in Drive' })
      ).toHaveAttribute('href', '/spaces/a1/drive/q4')
    })

    it('reads a digest with only deletions as a deletion', async () => {
      renderFeed(
        [digest({ created: 0, updated: 0, deleted: 1, samples: ['old.pdf'] })],
        { space: driveSpace }
      )

      const card = await screen.findByRole('article', {
        name: 'Bob Durand: Q4 assets'
      })
      expect(within(card).getByText('deleted 1 file')).toBeInTheDocument()
    })
  })

  it('keeps the reaction button for hover until the item has a reaction', async () => {
    renderFeed([
      post(1),
      post(2, { reactions: [{ key: '👍', userIds: ['u-bob'] }] })
    ])

    const buttons = await screen.findAllByRole('button', {
      name: 'Add a reaction'
    })
    expect(buttons[0]).toHaveAttribute('data-quiet')
    expect(buttons[1]).not.toHaveAttribute('data-quiet')
  })

  it('says what every kind of activity did, and none as an update posted', async () => {
    const verbs: Record<string, string> = {
      'tasks.created': 'created a task',
      'tasks.updated': 'updated a task',
      'tasks.assigned': 'assigned a task',
      'tasks.unassigned': 'unassigned a task',
      'tasks.moved': 'moved a task',
      'tasks.completed': 'completed a task',
      'tasks.reopened': 'reopened a task',
      'tasks.deleted': 'deleted a task',
      'tasks.restored': 'restored a task',
      'mail.received': 'New email received',
      'mail.sent': 'Email sent',
      'calendar.created': 'created an event',
      'calendar.updated': 'updated an event',
      'calendar.rescheduled': 'rescheduled an event',
      'calendar.accepted': 'accepted an event',
      'calendar.declined': 'declined an event',
      'calendar.proposed': 'proposed a new time',
      'drive.created': 'added a file',
      'drive.updated': 'updated a file'
    }
    const cards = Object.keys(verbs).map((key, i): FeedCard => ({
      ...task,
      id: key,
      time: at(i),
      updatedAt: at(i),
      type: `com.twake.${key.replace('.', '.thing.')}.v1`,
      actor: { type: 'user', id: 'u-bob', name: 'Bob Durand' },
      object: {
        ...task.object,
        id: key,
        title: `Object of ${key}`,
        container: null
      }
    }))
    const showcase: Space = roadmap
    renderFeed(cards, { space: showcase, pageSize: 100 })

    await screen.findAllByRole('article')
    const texts = screen
      .getAllByRole('article')
      .map(article => article.textContent)
    const missing = Object.values(verbs).filter(
      verb => !texts.some(text => text.includes(verb))
    )
    expect(missing).toEqual([])
    expect(texts.some(text => text.includes('posted an update'))).toBe(false)
  })

  it('shows who acted on a card with the app as a badge, and the app when no person did', async () => {
    renderFeed([
      task,
      mail,
      {
        ...task,
        id: 'token-card',
        actor: { type: 'token', id: 't', name: 'Zap' }
      }
    ])

    const taskCard = await screen.findByRole('article', {
      name: 'Bob Durand: Write the brief'
    })
    expect(within(taskCard).getByText('BD')).toBeInTheDocument()
    expect(within(taskCard).getByLabelText('Tasks')).toBeInTheDocument()

    const mailCard = screen.getByRole('article', {
      name: 'Mail: Partner feedback'
    })
    expect(within(mailCard).getByLabelText('Mail')).toBeInTheDocument()

    const tokenCard = screen.getByRole('article', {
      name: 'Zap: Write the brief'
    })
    expect(within(tokenCard).getByLabelText('Tasks')).toBeInTheDocument()
  })

  it('names an event place once, and leaves out replies nobody gave', async () => {
    renderFeed([
      {
        ...event,
        preview: 'Room 4',
        state: {
          ...event.state,
          rsvp: { accepted: 0, tentative: 0, declined: 0, pending: 0 }
        }
      }
    ])

    const card = await screen.findByRole('article', {
      name: 'Someone: Roadmap review'
    })
    expect(within(card).getByText(/Room 4/)).toBeInTheDocument()
    expect(within(card).queryByText(/waiting/)).not.toBeInTheDocument()
  })

  it('says how long an event lasts, and marks a call with a Visio chip', async () => {
    renderFeed([
      {
        ...event,
        state: {
          ...event.state,
          end: '2026-10-09T10:30:00Z',
          meeting: { room: 'abc-defg-hij' }
        }
      }
    ])

    const card = await screen.findByRole('article', {
      name: 'Someone: Roadmap review'
    })
    expect(within(card).getByText(/· 1 hour 30 minutes/)).toBeInTheDocument()
    expect(within(card).getByText('Visio')).toBeInTheDocument()
    expect(
      within(card).getByRole('button', { name: 'Join meeting' })
    ).toHaveTextContent('Join')
  })

  it('shows no Visio chip or Join button on an event without a room', async () => {
    renderFeed([event])

    const card = await screen.findByRole('article', {
      name: 'Someone: Roadmap review'
    })
    expect(within(card).getByText(/· 1 hour/)).toBeInTheDocument()
    expect(within(card).queryByText('Visio')).toBe(null)
    expect(within(card).queryByRole('button', { name: 'Join meeting' })).toBe(
      null
    )
  })

  it('gives only the hour of an event that has no length', async () => {
    renderFeed([
      { ...event, state: { ...event.state, end: event.state.start } }
    ])

    const card = await screen.findByRole('article', {
      name: 'Someone: Roadmap review'
    })
    expect(within(card).queryByText(/·\s*·/)).toBe(null)
  })

  it("joins an event's Meet room, and shares its link", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() =>
      Promise.resolve()
    )
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })
    renderFeed([
      { ...event, state: { ...event.state, meeting: { room: 'abc-defg-hij' } } }
    ])
    const card = await screen.findByRole('article', {
      name: 'Someone: Roadmap review'
    })

    fireEvent.click(within(card).getByRole('button', { name: 'Join meeting' }))
    expect(
      within(screen.getByRole('region', { name: 'Video meeting' })).getByTitle(
        'Video meeting'
      )
    ).toHaveAttribute('src', 'https://meet.test/abc-defg-hij')

    fireEvent.click(
      within(card).getByRole('button', { name: 'Connection details' })
    )
    const dialog = screen.getByRole('dialog', { name: 'Connection details' })
    expect(within(dialog).getByLabelText('Meeting link')).toHaveValue(
      'https://meet.test/abc-defg-hij'
    )
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Copy the link' })
    )
    expect(await screen.findByText('Link copied')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith('https://meet.test/abc-defg-hij')
  })

  it('offers no meeting on an event without a room', async () => {
    renderFeed([event])

    const card = await screen.findByRole('article', {
      name: 'Someone: Roadmap review'
    })
    expect(
      within(card).queryByRole('button', { name: 'Join meeting' })
    ).not.toBeInTheDocument()
  })

  it('shows one category at a time', async () => {
    const { feed } = renderFeed([post(5), task, event])
    await screen.findByText('Message 5')

    fireEvent.click(screen.getByRole('button', { name: 'Filter by' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Events' }))

    await waitFor(() => {
      expect(articles()).toEqual(['Someone: Roadmap review'])
    })
    expect(feed.list).toHaveBeenLastCalledWith('a1', { category: 'events' })
  })

  it('loads older items on demand', async () => {
    renderFeed(
      Array.from({ length: 3 }, (_, i) => post(i + 1)),
      { pageSize: 2 }
    )
    await screen.findByText('Message 3')
    expect(screen.queryByText('Message 1')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load older' }))

    expect(await screen.findByText('Message 1')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Load older' })
    ).not.toBeInTheDocument()
  })

  it('marks where the new items start, loading back to it', async () => {
    renderFeed(
      Array.from({ length: 6 }, (_, i) => post(i + 1)),
      { pageSize: 2, readAt: at(2) }
    )

    const mark = await screen.findByRole('separator', { name: 'New' })
    expect(mark.nextElementSibling).toHaveTextContent('Message 3')
    expect(screen.getByText('Message 2')).toBeInTheDocument()
  })

  it('marks no new items on a first visit, or once all are seen', async () => {
    renderFeed([post(1), post(2)], { readAt: at(2) })
    await screen.findByText('Message 2')
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  it('remembers the newest item seen, in the whole feed only', async () => {
    const { feed } = renderFeed([post(1), post(5), event], { readAt: at(1) })
    await screen.findByText('Message 5')

    await waitFor(() => {
      expect(feed.markRead).toHaveBeenCalledWith('a1', at(5))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Filter by' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Events' }))
    await waitFor(() => {
      expect(articles()).toEqual(['Someone: Roadmap review'])
    })
    expect(feed.markRead).toHaveBeenCalledTimes(1)
  })

  it('remembers an edit seen, as a mention it adds dates from it', async () => {
    const { feed } = renderFeed(
      [post(1), post(2, { editedAt: at(7), updatedAt: at(7) }), post(5)],
      { readAt: at(1) }
    )
    await screen.findByText('Message 5')

    await waitFor(() => {
      expect(feed.markRead).toHaveBeenCalledWith('a1', at(7))
    })
  })

  it('invites the team to a new space', async () => {
    renderFeed([], { space: { ...roadmap, role: 'admin' } })

    expect(
      await screen.findByRole('heading', { name: 'Set up Roadmap' })
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Invite members' }))
    expect(
      await screen.findByRole('dialog', {
        name: 'Invite members to “Roadmap”'
      })
    ).toBeInTheDocument()
  })

  it('offers the apps the new space has, and no filter', async () => {
    renderFeed([], {
      space: {
        ...roadmap,
        apps: ['tasks', 'drive', 'calendar'],
        resources: [
          { kind: 'project', id: 'project-1' },
          { kind: 'drive', id: 'drive-1' },
          { kind: 'calendar', id: 'cal-1' }
        ]
      }
    })

    await screen.findByRole('heading', { name: 'Set up Roadmap' })
    expect(screen.getByRole('link', { name: 'Share a file' })).toHaveAttribute(
      'href',
      '/spaces/a1/drive'
    )
    expect(screen.getByRole('link', { name: 'Create a task' })).toHaveAttribute(
      'href',
      '/spaces/a1/tasks'
    )
    expect(
      screen.getByRole('link', { name: 'Create an event' })
    ).toHaveAttribute('href', '/spaces/a1/calendar')
    expect(screen.queryByRole('button', { name: 'Filter by' })).toBe(null)
  })

  it('shows the members of the space beside the feed, and invites more', async () => {
    renderFeed([post(1)], {
      space: {
        ...roadmap,
        role: 'admin',
        members: [
          {
            id: 'u-bob',
            username: 'bob',
            email: 'bob@acme',
            displayName: 'Bob Durand',
            workplaceFqdn: null,
            role: 'editor'
          }
        ]
      }
    })
    await screen.findByText('Message 1')
    expect(screen.queryByRole('complementary', { name: 'Space members' })).toBe(
      null
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show the members' }))
    const panel = screen.getByRole('complementary', { name: 'Space members' })
    expect(within(panel).getByText('Bob')).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: 'Hide the members' })
    ).toHaveLength(1)

    fireEvent.click(
      within(panel).getByRole('button', { name: 'Hide the members' })
    )
    expect(screen.queryByRole('complementary', { name: 'Space members' })).toBe(
      null
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show the members' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add member' }))
    expect(
      await screen.findByRole('dialog', {
        name: 'Invite members to “Roadmap”'
      })
    ).toBeInTheDocument()
  })

  it('moves the focus into the members panel, and back on Escape', async () => {
    renderFeed([post(1)])
    await screen.findByText('Message 1')
    const button = screen.getByRole('button', { name: 'Show the members' })
    button.focus()

    fireEvent.click(button)
    const panel = screen.getByRole('complementary', { name: 'Space members' })
    expect(panel).toHaveFocus()

    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Space members' })).toBe(
      null
    )
    expect(
      screen.getByRole('button', { name: 'Show the members' })
    ).toHaveFocus()
  })

  it('moves the focus into the members panel and back on a phone too', async () => {
    stubPhoneScreen()
    try {
      renderFeed([post(1)])
      await screen.findByText('Message 1')
      const button = screen.getByRole('button', { name: 'Show the members' })
      button.focus()

      fireEvent.click(button)
      const panel = await screen.findByRole('complementary', {
        name: 'Space members'
      })
      await waitFor(() => {
        expect(panel).toHaveFocus()
      })

      fireEvent.keyDown(panel, { key: 'Escape' })
      expect(
        screen.queryByRole('complementary', { name: 'Space members' })
      ).toBe(null)
      expect(
        screen.getByRole('button', { name: 'Show the members' })
      ).toHaveFocus()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('says so when a category is empty', async () => {
    renderFeed([post(1)])
    await screen.findByText('Message 1')

    fireEvent.click(screen.getByRole('button', { name: 'Filter by' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Files' }))

    expect(await screen.findByText('Nothing here yet.')).toBeInTheDocument()
  })

  it('posts a message', async () => {
    const { feed } = renderFeed([post(1)])
    const composer = await screen.findByRole('textbox', {
      name: 'Text message'
    })

    fireEvent.change(composer, { target: { value: '  Hello team  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('Hello team')).toBeInTheDocument()
    expect(feed.post).toHaveBeenCalledWith('a1', 'Hello team', [])
    expect(composer).toHaveValue('')
  })

  it('mentions the member picked after an "@"', async () => {
    const { feed } = renderFeed([post(1)], {
      space: {
        ...roadmap,
        members: [
          {
            id: 'u-bob',
            username: 'bob',
            email: 'bob@acme',
            displayName: 'Bob Durand',
            workplaceFqdn: null,
            role: 'editor'
          }
        ]
      }
    })
    const composer = await screen.findByRole('textbox', {
      name: 'Text message'
    })

    fireEvent.change(composer, { target: { value: 'Thanks @bo' } })
    fireEvent.select(composer)
    fireEvent.click(await screen.findByRole('option', { name: /Bob Durand/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('@Bob Durand')).toBeInTheDocument()
    expect(feed.post).toHaveBeenCalledWith('a1', 'Thanks @Bob Durand', [
      'u-bob'
    ])
  })

  it('lets a viewer react, but not post', async () => {
    const { feed } = renderFeed([post(1)], {
      space: { ...roadmap, role: 'viewer' }
    })
    await screen.findByText('Message 1')
    expect(
      screen.queryByRole('textbox', { name: 'Text message' })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add a reaction' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '🎉' }))

    expect(
      await screen.findByRole('button', { name: '🎉 1', pressed: true })
    ).toBeInTheDocument()
    expect(feed.react).toHaveBeenCalledWith('a1', 'post-1', '🎉')
  })

  it('takes back a reaction of mine', async () => {
    const { feed } = renderFeed([
      post(1, { reactions: [{ key: '👍', userIds: ['u-bob', 'u-me'] }] })
    ])

    fireEvent.click(
      await screen.findByRole('button', { name: '👍 2', pressed: true })
    )

    expect(
      await screen.findByRole('button', { name: '👍 1', pressed: false })
    ).toBeInTheDocument()
    expect(feed.unreact).toHaveBeenCalledWith('a1', 'post-1', '👍')
  })

  describe('a poll', () => {
    const lunch = (
      overrides: Partial<FeedPost> = {},
      closedAt: string | null = null
    ) =>
      post(1, {
        body: 'Which day?',
        poll: {
          kind: 'choice',
          multiple: false,
          anonymous: false,
          options: [
            { label: 'Tuesday', count: 1, userIds: ['u-bob'] },
            { label: 'Friday', count: 0, userIds: [] }
          ],
          closesAt: null,
          closedAt
        },
        ...overrides
      })

    it('publishes a question and its options from the composer', async () => {
      const { feed } = renderFeed([post(0)])
      fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Poll' }))
      const dialog = screen.getByRole('dialog', { name: 'New poll' })
      const publish = within(dialog).getByRole('button', { name: 'Send poll' })

      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Question' }),
        { target: { value: ' Which day? ' } }
      )
      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Option 1' }),
        { target: { value: 'Tuesday' } }
      )
      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Option 2' }),
        { target: { value: 'Tuesday' } }
      )
      expect(publish).toBeDisabled()

      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Add option' })
      )
      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Option 3' }),
        { target: { value: 'Friday' } }
      )
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Remove option 2' })
      )
      expect(
        within(dialog).getByRole('textbox', { name: 'Option 2' })
      ).toHaveValue('Friday')
      fireEvent.click(
        within(dialog).getByRole('switch', { name: 'Allow multiple answers' })
      )
      fireEvent.click(publish)

      expect(
        await screen.findByRole('group', { name: 'Which day?' })
      ).toBeInTheDocument()
      expect(feed.post).toHaveBeenCalledWith('a1', 'Which day?', [], {
        poll: {
          options: ['Tuesday', 'Friday'],
          multiple: true,
          anonymous: false
        }
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('votes, changes the vote and takes it back', async () => {
      const { feed } = renderFeed([lunch()])
      const poll = await screen.findByRole('group', { name: 'Which day?' })
      expect(screen.getByText('Single choice')).toBeInTheDocument()
      expect(within(poll).getByText('100%')).toBeInTheDocument()

      fireEvent.click(
        within(poll).getByRole('radio', { name: 'Friday: 0 votes' })
      )
      expect(
        await within(poll).findByRole('radio', {
          name: 'Friday: 1 vote',
          checked: true
        })
      ).toBeInTheDocument()
      expect(within(poll).getAllByText('50%')).toHaveLength(2)
      expect(feed.vote).toHaveBeenCalledWith('a1', 'post-1', 1)

      fireEvent.click(
        await within(poll).findByRole('radio', {
          name: 'Tuesday: 1 vote',
          checked: false
        })
      )
      expect(
        await within(poll).findByRole('radio', {
          name: 'Tuesday: 2 votes',
          checked: true
        })
      ).toBeInTheDocument()
      expect(feed.vote).toHaveBeenLastCalledWith('a1', 'post-1', 0)

      fireEvent.click(
        await within(poll).findByRole('radio', { name: 'Tuesday: 2 votes' })
      )
      expect(
        await within(poll).findByRole('radio', {
          name: 'Tuesday: 1 vote',
          checked: false
        })
      ).toBeInTheDocument()
      expect(feed.unvote).toHaveBeenCalledWith('a1', 'post-1', 0)
    })

    it('shows who voted, unless the poll is anonymous', async () => {
      renderFeed([
        lunch(),
        lunch({
          id: 'post-2',
          body: 'Which room?',
          poll: {
            kind: 'choice',
            multiple: false,
            anonymous: true,
            options: [
              { label: 'Blue', count: 1, userIds: [] },
              { label: 'Red', count: 0, userIds: [] }
            ],
            closesAt: null,
            closedAt: null
          }
        })
      ])
      const open = await screen.findByRole('group', { name: 'Which day?' })
      const anonymous = screen.getByRole('group', { name: 'Which room?' })

      expect(within(open).getByText('SO')).toBeInTheDocument()
      expect(within(anonymous).getByText('100%')).toBeInTheDocument()
      expect(within(anonymous).queryByText('SO')).not.toBeInTheDocument()
    })

    it('keeps each pick on a multiple poll', async () => {
      const { feed } = renderFeed([
        lunch({
          poll: {
            kind: 'choice',
            multiple: true,
            anonymous: false,
            options: [
              { label: 'Tuesday', count: 1, userIds: ['u-bob'] },
              { label: 'Friday', count: 0, userIds: [] }
            ],
            closesAt: null,
            closedAt: null
          }
        })
      ])
      const poll = await screen.findByRole('group', { name: 'Which day?' })
      expect(screen.getByText('Multiple choice')).toBeInTheDocument()

      fireEvent.click(
        within(poll).getByRole('checkbox', { name: 'Tuesday: 1 vote' })
      )
      fireEvent.click(
        await within(poll).findByRole('checkbox', { name: 'Friday: 0 votes' })
      )

      expect(
        await within(poll).findByRole('checkbox', {
          name: 'Friday: 1 vote',
          checked: true
        })
      ).toBeInTheDocument()
      expect(
        within(poll).getByRole('checkbox', {
          name: 'Tuesday: 2 votes',
          checked: true
        })
      ).toBeInTheDocument()
      expect(feed.unvote).not.toHaveBeenCalled()
    })

    it("lets its author close it, and no one vote once it's closed", async () => {
      const { feed } = renderFeed([
        lunch({ author: { type: 'user', id: 'u-me', name: 'Alice Martin' } })
      ])
      const poll = await screen.findByRole('group', { name: 'Which day?' })

      fireEvent.click(screen.getByRole('button', { name: 'Close the poll' }))

      expect(await screen.findByText('1 vote · Closed')).toBeInTheDocument()
      expect(feed.closePoll).toHaveBeenCalledWith('a1', 'post-1')
      expect(
        within(poll).getByRole('radio', { name: 'Friday: 0 votes' })
      ).toBeDisabled()
      expect(
        screen.queryByRole('button', { name: 'Close the poll' })
      ).not.toBeInTheDocument()
    })

    it('shows the poll as it is now when a vote fails', async () => {
      const { feed } = renderFeed([lunch()])
      const poll = await screen.findByRole('group', { name: 'Which day?' })
      vi.mocked(feed.vote).mockRejectedValueOnce(new Error('poll_closed'))
      vi.mocked(feed.item).mockResolvedValueOnce(lunch({}, at(5)))

      fireEvent.click(
        within(poll).getByRole('radio', { name: 'Friday: 0 votes' })
      )

      expect(await screen.findByText('1 vote · Closed')).toBeInTheDocument()
      expect(
        within(poll).getByRole('radio', { name: 'Friday: 0 votes' })
      ).toBeDisabled()
      expect(screen.getByText('Could not save your vote.')).toBeInTheDocument()
    })

    it('asks to slow down when a vote is refused for going too fast', async () => {
      const { feed } = renderFeed([lunch()])
      const poll = await screen.findByRole('group', { name: 'Which day?' })
      vi.mocked(feed.vote).mockRejectedValueOnce(
        Object.assign(new Error('rate_limited'), {
          status: 429,
          code: 'rate_limited'
        })
      )

      fireEvent.click(
        within(poll).getByRole('radio', { name: 'Friday: 0 votes' })
      )

      expect(
        await screen.findByText(
          "You're going too fast. Wait a moment and try again."
        )
      ).toBeInTheDocument()
      expect(
        screen.queryByText('Could not save your vote.')
      ).not.toBeInTheDocument()
    })

    it('offers no one else to close it, and lets a viewer vote', async () => {
      const { feed } = renderFeed([lunch()], {
        space: { ...roadmap, role: 'viewer' }
      })
      const poll = await screen.findByRole('group', { name: 'Which day?' })
      expect(
        screen.queryByRole('button', { name: 'Close the poll' })
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Add' })
      ).not.toBeInTheDocument()

      fireEvent.click(
        within(poll).getByRole('radio', { name: 'Friday: 0 votes' })
      )

      await waitFor(() => {
        expect(feed.vote).toHaveBeenCalledWith('a1', 'post-1', 1)
      })
    })
  })

  it('publishes a yes/no question, answered yes or no', async () => {
    const { feed } = renderFeed([post(0)])
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Yes/no question' }))
    const dialog = screen.getByRole('dialog', { name: 'New yes/no question' })
    expect(
      within(dialog).queryByRole('textbox', { name: 'Option 1' })
    ).not.toBeInTheDocument()

    fireEvent.change(
      within(dialog).getByRole('textbox', { name: 'Question' }),
      { target: { value: 'Keep the demo?' } }
    )
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Send question' })
    )

    const poll = await screen.findByRole('group', { name: 'Keep the demo?' })
    expect(feed.post).toHaveBeenCalledWith('a1', 'Keep the demo?', [], {
      poll: { kind: 'yes_no' }
    })
    expect(screen.getByText('asked a question')).toBeInTheDocument()
    fireEvent.click(within(poll).getByRole('button', { name: 'No: 0 votes' }))
    expect(
      await within(poll).findByRole('button', {
        name: 'No: 1 vote',
        pressed: true
      })
    ).toBeInTheDocument()
    expect(
      within(poll).getByRole('button', { name: 'Yes: 0 votes', pressed: false })
    ).toBeInTheDocument()
    expect(screen.getByText('1 answered')).toBeInTheDocument()
  })

  it("heads the yes/no dialog with its menu item's icon", async () => {
    renderFeed([post(0)])
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    const item = screen.getByRole('menuitem', { name: 'Yes/no question' })
    const icon = item.querySelector('svg path')?.getAttribute('d')
    fireEvent.click(item)
    const dialog = screen.getByRole('dialog', { name: 'New yes/no question' })

    expect(icon).toBeTruthy()
    expect(dialog.querySelector('svg path')?.getAttribute('d')).toBe(icon)
  })

  it('asks a yes/no question until a deadline', async () => {
    const { feed } = renderFeed([post(0)])
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Yes/no question' }))
    const dialog = screen.getByRole('dialog', { name: 'New yes/no question' })
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: 'Question' }),
      { target: { value: 'Ship today?' } }
    )
    fireEvent.click(
      within(dialog).getByRole('switch', { name: 'Set a deadline' })
    )
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Send question' })
    )

    await screen.findByRole('group', { name: 'Ship today?' })
    const ask = vi.mocked(feed.post).mock.calls[0]?.[3]
    const closesAt =
      ask && 'poll' in ask && 'kind' in ask.poll ? ask.poll.closesAt : undefined
    expect(new Date(closesAt ?? 0).getTime()).toBeGreaterThan(Date.now())
    expect(screen.getByText(/^By /)).toBeInTheDocument()
  })

  it('closes a yes/no question when its deadline passes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderFeed([
        post(1, {
          author: { type: 'user', id: 'u-me', name: 'Alice Martin' },
          body: 'Ship today?',
          poll: {
            kind: 'yes_no',
            multiple: false,
            anonymous: false,
            options: [
              { label: 'Yes', count: 0, userIds: [] },
              { label: 'No', count: 0, userIds: [] }
            ],
            closesAt: new Date(Date.now() + 60_000).toISOString(),
            closedAt: null
          }
        })
      ])
      const poll = await screen.findByRole('group', { name: 'Ship today?' })
      expect(
        within(poll).getByRole('button', { name: 'Yes: 0 votes' })
      ).toBeEnabled()

      act(() => {
        vi.advanceTimersByTime(60_000)
      })

      expect(screen.getByText('0 answered · Closed')).toBeInTheDocument()
      expect(
        within(poll).getByRole('button', { name: 'Yes: 0 votes' })
      ).toBeDisabled()
      expect(
        screen.queryByRole('button', { name: 'Close the poll' })
      ).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  describe('an approval request', () => {
    const bob = {
      id: 'u-bob',
      username: 'bob',
      email: 'bob@acme',
      displayName: 'Bob Durand',
      workplaceFqdn: null,
      role: 'editor' as const
    }
    const approver = (
      id: string,
      name: string,
      decision: Decision | null = null,
      comment: string | null = null
    ): Approver => ({
      id,
      name,
      decision,
      comment,
      decidedAt: decision && at(2)
    })
    const request = (
      approvers: Approver[],
      overrides: Partial<FeedPost> = {}
    ) =>
      post(1, {
        body: 'Ship the copy?',
        approval: {
          state: approvalState(approvers),
          approvers,
          closedAt: null
        },
        ...overrides
      })

    it('asks the members picked to approve, with details', async () => {
      const { feed } = renderFeed([post(0)], {
        space: { ...roadmap, members: [bob] }
      })
      fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Approval request' })
      )
      const dialog = screen.getByRole('dialog', { name: 'Approval request' })
      expect(
        within(dialog).getByText('Ask teammates to make a decision.')
      ).toBeInTheDocument()
      const send = within(dialog).getByRole('button', { name: 'Send request' })

      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'What needs approval?' }),
        { target: { value: ' Ship the copy? ' } }
      )
      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Details (optional)' }),
        { target: { value: 'Final copy is in Drive.' } }
      )
      expect(send).toBeDisabled()
      const approvers = within(dialog).getByRole('combobox', {
        name: 'Approvers'
      })
      expect(approvers).toHaveAttribute('placeholder', 'Select approvers')
      fireEvent.keyDown(approvers, { key: 'ArrowDown' })
      fireEvent.click(await screen.findByRole('option', { name: /Bob Durand/ }))
      fireEvent.click(send)

      const card = await screen.findByRole('group', { name: 'Ship the copy?' })
      expect(
        within(card).getByText('Final copy is in Drive.')
      ).toBeInTheDocument()
      expect(feed.post).toHaveBeenCalledWith(
        'a1',
        'Ship the copy?\n\nFinal copy is in Drive.',
        [],
        { approval: { approvers: ['u-bob'] } }
      )
    })

    it('offers no approval request without another member', async () => {
      renderFeed([post(0)])
      fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
      expect(
        screen.getAllByRole('menuitem').map(item => item.textContent)
      ).toEqual(['Poll', 'Yes/no question', 'Announcement', 'Feedback', 'Form'])
    })

    it('sends picked files to the space drive, above the asks, and keeps the draft', async () => {
      renderFeed([post(0)], {
        space: {
          ...roadmap,
          apps: [...roadmap.apps, 'drive'],
          resources: [...roadmap.resources, { kind: 'drive', id: 'drive-1' }]
        }
      })
      const composer = await screen.findByRole('textbox', {
        name: 'Text message'
      })
      fireEvent.change(composer, { target: { value: 'Draft' } })
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      expect(
        screen.getAllByRole('menuitem').map(item => item.textContent)
      ).toEqual([
        'Upload files',
        'Photos or Videos',
        'Poll',
        'Yes/no question',
        'Announcement',
        'Feedback',
        'Form'
      ])

      const opened = vi.spyOn(HTMLInputElement.prototype, 'click')
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Photos or Videos' })
      )
      const picker = opened.mock.contexts[0] as HTMLInputElement
      opened.mockRestore()
      expect(picker.type).toBe('file')
      expect(picker.accept).toBe('image/*,video/*')

      const photo = new File(['p'], 'photo.png', { type: 'image/png' })
      fireEvent.change(picker, { target: { files: [photo] } })

      await waitFor(() => {
        expect(uploadToDrive).toHaveBeenCalledWith(
          null,
          'drive-1',
          [photo],
          expect.anything()
        )
      })
      expect(composer).toHaveValue('Draft')
      expect(
        screen.getByRole('status', { name: 'Address' })
      ).not.toHaveTextContent('drive')
    })

    it('says when the drive could not take the files', async () => {
      vi.mocked(uploadToDrive).mockRejectedValueOnce(new Error('quota'))
      renderFeed([post(0)], {
        space: {
          ...roadmap,
          apps: [...roadmap.apps, 'drive'],
          resources: [...roadmap.resources, { kind: 'drive', id: 'drive-1' }]
        }
      })
      fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
      const opened = vi.spyOn(HTMLInputElement.prototype, 'click')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Upload files' }))
      const picker = opened.mock.contexts[0] as HTMLInputElement
      opened.mockRestore()
      expect(picker.accept).toBe('')

      fireEvent.change(picker, {
        target: { files: [new File(['a'], 'notes.txt')] }
      })

      expect(
        await screen.findByText('Your files could not be added to the Drive.')
      ).toBeInTheDocument()
    })

    async function uploadFiles(files: File[]) {
      let options: NonNullable<Parameters<typeof uploadToDrive>[3]> = {}
      let finish: () => void = () => undefined
      vi.mocked(uploadToDrive).mockImplementationOnce(
        (_sdk, _drive, _files, given = {}) => {
          options = given
          return new Promise<void>(resolve => {
            finish = resolve
            given.signal?.addEventListener('abort', () => {
              resolve()
            })
          })
        }
      )
      renderFeed([post(0)], {
        space: {
          ...roadmap,
          apps: [...roadmap.apps, 'drive'],
          resources: [...roadmap.resources, { kind: 'drive', id: 'drive-1' }]
        }
      })
      fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
      const opened = vi.spyOn(HTMLInputElement.prototype, 'click')
      fireEvent.click(screen.getByRole('menuitem', { name: 'Upload files' }))
      const picker = opened.mock.contexts[0] as HTMLInputElement
      opened.mockRestore()
      fireEvent.change(picker, { target: { files } })
      await screen.findByText('Adding your files to the Drive…')
      return {
        progress: (index: number, loaded: number, total: number) => {
          act(() => {
            options.onProgress?.({ index, loaded, total })
          })
        },
        finish: () => {
          act(finish)
        }
      }
    }

    it('shows a bar per file, filled as Drive reports each file', async () => {
      const upload = await uploadFiles([
        new File(['a'], 'notes.txt'),
        new File(['b'], 'plan.pdf')
      ])
      const notes = screen.getByRole('progressbar', { name: 'notes.txt' })
      const plan = screen.getByRole('progressbar', { name: 'plan.pdf' })
      // jsdom lays nothing out: the column that keeps long names in the alert
      expect(
        getComputedStyle(screen.getByRole('list')).gridTemplateColumns
      ).toBe('minmax(0, 1fr)')
      // A Drive that reports no progress leaves the bars without a value
      expect(notes).not.toHaveAttribute('aria-valuenow')
      expect(plan).not.toHaveAttribute('aria-valuenow')

      upload.progress(0, 30, 120)
      expect(notes).toHaveAttribute('aria-valuenow', '25')
      expect(plan).toHaveAttribute('aria-valuenow', '0')

      upload.progress(1, 10, 20)
      expect(notes).toHaveAttribute('aria-valuenow', '100')
      expect(plan).toHaveAttribute('aria-valuenow', '50')

      // An empty file has no share to show
      upload.progress(1, 0, 0)
      expect(plan).not.toHaveAttribute('aria-valuenow')

      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
      expect(
        screen.getByRole('menuitem', { name: 'Upload files' })
      ).toHaveAttribute('aria-disabled', 'true')
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

      upload.finish()
      await waitFor(() => {
        expect(screen.queryByRole('progressbar')).toBeNull()
      })
      expect(
        screen.queryByText('Your files could not be added to the Drive.')
      ).toBeNull()
    })

    it('stops the upload on cancel, without calling it a failure', async () => {
      await uploadFiles([new File(['a'], 'notes.txt')])

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      await waitFor(() => {
        expect(screen.queryByRole('progressbar')).toBeNull()
      })
      expect(
        screen.queryByText('Your files could not be added to the Drive.')
      ).toBeNull()
    })

    it('says who requested it, and lets an approver approve once', async () => {
      const { feed } = renderFeed([
        request([
          approver('u-me', 'Alice Martin'),
          approver('u-carol', 'Carol Diaz', 'approved', 'Clear')
        ])
      ])
      const card = await screen.findByRole('group', { name: 'Ship the copy?' })
      expect(screen.getByText('requested approval')).toBeInTheDocument()
      expect(screen.getByText('1 of 2 approved · Open')).toBeInTheDocument()
      const you = within(card).getByRole('listitem', { name: 'You: Pending' })
      expect(you).toBeInTheDocument()
      expect(
        within(card).getByRole('listitem', { name: 'Carol Diaz: Approved' })
      ).toBeInTheDocument()
      expect(within(card).getByText('Clear')).toBeInTheDocument()
      expect(within(card).queryByRole('textbox')).not.toBeInTheDocument()

      fireEvent.click(within(card).getByRole('button', { name: 'Approve' }))

      expect(
        await screen.findByText('2 of 2 approved · Approved')
      ).toBeInTheDocument()
      expect(feed.decide).toHaveBeenCalledWith('a1', 'post-1', 'approved', '')
      const decided = screen.getByRole('group', { name: 'Ship the copy?' })
      expect(within(decided).getAllByText('Approved')).toHaveLength(2)
      expect(
        within(decided).queryByRole('button', { name: 'Approve' })
      ).not.toBeInTheDocument()
    })

    it('shows the first two of a long list of approvers until asked', async () => {
      renderFeed([
        request(
          ['Bob', 'Carol', 'Dave', 'Erin', 'Fred'].map(name =>
            approver(`u-${name}`, name)
          )
        )
      ])
      const card = await screen.findByRole('group', { name: 'Ship the copy?' })
      expect(within(card).getAllByRole('listitem')).toHaveLength(2)

      fireEvent.click(
        within(card).getByRole('button', { name: 'Show all 5 approvers' })
      )
      expect(within(card).getAllByRole('listitem')).toHaveLength(5)

      fireEvent.click(within(card).getByRole('button', { name: 'Show less' }))
      expect(within(card).getAllByRole('listitem')).toHaveLength(2)
    })

    it('shows three approvers without a toggle', async () => {
      renderFeed([
        request(
          ['Bob', 'Carol', 'Dave'].map(name => approver(`u-${name}`, name))
        )
      ])
      const card = await screen.findByRole('group', { name: 'Ship the copy?' })

      expect(within(card).getAllByRole('listitem')).toHaveLength(3)
      expect(within(card).queryByRole('button')).not.toBeInTheDocument()
    })

    it('is rejected by one, and offers nothing to decide to the others', async () => {
      renderFeed([
        request([
          approver('u-bob', 'Bob Durand', 'rejected', 'Not yet'),
          approver('u-carol', 'Carol Diaz')
        ])
      ])
      const card = await screen.findByRole('group', { name: 'Ship the copy?' })

      expect(within(card).getByText('Rejected')).toBeInTheDocument()
      expect(screen.getByText('0 of 2 approved · Rejected')).toBeInTheDocument()
      expect(within(card).getByText('Not yet')).toBeInTheDocument()
      expect(
        within(card).queryByRole('button', { name: 'Reject' })
      ).not.toBeInTheDocument()
    })

    it('lets its author delete it, not edit it', async () => {
      renderFeed([
        request([approver('u-bob', 'Bob Durand')], {
          author: { type: 'user', id: 'u-me', name: 'Alice Martin' }
        })
      ])
      fireEvent.click(
        await screen.findByRole('button', { name: 'More actions' })
      )

      expect(
        screen.getAllByRole('menuitem').map(item => item.textContent)
      ).toEqual(['Delete'])
    })

    it('lets its author close it', async () => {
      const { feed } = renderFeed([
        request([approver('u-bob', 'Bob Durand')], {
          author: { type: 'user', id: 'u-me', name: 'Alice Martin' }
        })
      ])
      await screen.findByRole('group', { name: 'Ship the copy?' })

      fireEvent.click(screen.getByRole('button', { name: 'Close request' }))

      expect(
        await screen.findByText('0 of 1 approved · Closed')
      ).toBeInTheDocument()
      expect(feed.closePoll).toHaveBeenCalledWith('a1', 'post-1')
      const card = screen.getByRole('group', { name: 'Ship the copy?' })
      expect(within(card).queryByText('Pending')).not.toBeInTheDocument()
      expect(within(card).getByText('No decision')).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Close request' })
      ).not.toBeInTheDocument()
    })

    it('offers its author nothing to close once decided', async () => {
      renderFeed([
        request([approver('u-bob', 'Bob Durand', 'approved')], {
          author: { type: 'user', id: 'u-me', name: 'Alice Martin' }
        })
      ])

      expect(
        await screen.findByText('1 of 1 approved · Approved')
      ).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Close request' })
      ).not.toBeInTheDocument()
    })

    it('stops waiting on the others once one rejects', async () => {
      renderFeed([
        request([
          approver('u-bob', 'Bob Durand', 'rejected'),
          approver('u-me', 'Alice Martin')
        ])
      ])
      const card = await screen.findByRole('group', { name: 'Ship the copy?' })

      expect(within(card).queryByText('Pending')).not.toBeInTheDocument()
      expect(within(card).getByText('No decision')).toBeInTheDocument()
      expect(
        within(card).queryByRole('button', { name: 'Approve' })
      ).not.toBeInTheDocument()
    })

    it('stops waiting on an approver who left the space', async () => {
      renderFeed([
        request([
          approver('u-bob', 'Bob Durand'),
          { ...approver('u-gone', 'Gone'), name: null }
        ])
      ])
      const card = await screen.findByRole('group', { name: 'Ship the copy?' })

      expect(within(card).getAllByText('Pending')).toHaveLength(1)
      expect(within(card).getByText('No decision')).toBeInTheDocument()
    })
  })

  describe('an announcement', () => {
    const pinnedStrip = () =>
      screen.findByRole('region', { name: 'Pinned announcements' })
    const announcement = (
      overrides: Partial<Announcement> = {}
    ): Announcement => ({
      title: null,
      color: null,
      pinnedAt: null,
      acknowledgedBy: [],
      ...overrides
    })
    const openDialog = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Announcement' }))
      return screen.getByRole('dialog', { name: 'New announcement' })
    }

    it('is published pinned on its banner, headline first', async () => {
      const { feed } = renderFeed([post(0)])
      const dialog = await openDialog()

      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Headline' }),
        { target: { value: ' Long weekend ' } }
      )
      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Message' }),
        {
          target: { value: ' Office closed Friday ' }
        }
      )
      fireEvent.click(
        within(dialog).getByRole('switch', {
          name: 'Pin to the top of the feed'
        })
      )
      fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))

      const strip = await pinnedStrip()
      expect(feed.post).toHaveBeenCalledWith('a1', 'Office closed Friday', [], {
        announcement: { title: 'Long weekend', color: '#99aff3', pinned: true }
      })
      expect(
        within(strip).getByRole('button', {
          name: 'Show the announcement: Long weekend'
        })
      ).toBeInTheDocument()
      expect(screen.getByText('Announcement · Pinned')).toBeInTheDocument()
      // In the strip, then on the banner.
      expect(screen.getAllByText('Long weekend')).toHaveLength(2)
    })

    it('is published unpinned unless asked', async () => {
      const { feed } = renderFeed([post(0)])
      const dialog = await openDialog()

      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Message' }),
        { target: { value: 'Office closed Friday' } }
      )
      fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))

      expect(await screen.findByText('Announcement')).toBeInTheDocument()
      expect(feed.post).toHaveBeenCalledWith('a1', 'Office closed Friday', [], {
        announcement: { color: '#99aff3', pinned: false }
      })
      expect(
        screen.queryByRole('region', { name: 'Pinned announcements' })
      ).not.toBeInTheDocument()
    })

    it('goes without a banner when its colour is taken off', async () => {
      const { feed } = renderFeed([post(0)])
      const dialog = await openDialog()

      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Banner color' })
      )
      fireEvent.click(screen.getByRole('radio', { name: 'No banner' }))
      fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'Escape' })
      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Message' }),
        {
          target: { value: 'Office closed Friday' }
        }
      )
      fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))

      await waitFor(() => {
        expect(feed.post).toHaveBeenCalledWith(
          'a1',
          'Office closed Friday',
          [],
          { announcement: { pinned: false } }
        )
      })
    })

    it('opens the colour picker from the custom swatch', async () => {
      renderFeed([post(0)])
      const dialog = await openDialog()
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Banner color' })
      )
      const picker = document.querySelector('input[type="color"]')
      if (!(picker instanceof HTMLInputElement)) throw new Error('no picker')
      const click = vi.spyOn(picker, 'click')

      fireEvent.click(screen.getByRole('radio', { name: 'Custom color' }))
      fireEvent.change(picker, { target: { value: '#123ABC' } })

      expect(click).toHaveBeenCalled()
      expect(
        screen.getByRole('radio', { name: 'Custom color' })
      ).toHaveAttribute('aria-checked', 'true')
    })

    it('is acknowledged by a member, once', async () => {
      const { feed } = renderFeed([
        post(1, {
          announcement: announcement({ acknowledgedBy: ['u-carol'] })
        })
      ])
      expect(await screen.findByText('1 acknowledged')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))

      expect(
        await screen.findByRole('button', { name: 'Acknowledged' })
      ).toBeDisabled()
      expect(feed.acknowledge).toHaveBeenCalledWith('a1', 'post-1')
      expect(screen.getByText('2 acknowledged')).toBeInTheDocument()
    })

    it('asks no acknowledgement of its author', async () => {
      renderFeed([
        post(1, {
          author: { type: 'user', id: 'u-me', name: 'Alice Martin' },
          announcement: announcement()
        })
      ])
      expect(await screen.findByText('0 acknowledged')).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Acknowledge' })
      ).not.toBeInTheDocument()
    })

    it('is unpinned by its author, and stays in the feed', async () => {
      const { feed } = renderFeed([
        post(1, {
          body: 'Office closed Friday',
          author: { type: 'user', id: 'u-me', name: 'Alice Martin' },
          announcement: announcement({ pinnedAt: at(1) })
        })
      ])
      const strip = await pinnedStrip()

      fireEvent.click(within(strip).getByRole('button', { name: 'Unpin' }))

      await waitFor(() => {
        expect(
          screen.queryByRole('region', { name: 'Pinned announcements' })
        ).not.toBeInTheDocument()
      })
      expect(feed.pin).toHaveBeenCalledWith('a1', 'post-1', false)
      expect(screen.getByText('Announcement')).toBeInTheDocument()
      expect(screen.getByText('Office closed Friday')).toBeInTheDocument()
    })

    it('is pinned again from its menu', async () => {
      const { feed } = renderFeed([
        post(1, {
          author: { type: 'user', id: 'u-me', name: 'Alice Martin' },
          announcement: announcement()
        })
      ])
      fireEvent.click(
        await screen.findByRole('button', { name: 'More actions' })
      )
      fireEvent.click(screen.getByRole('menuitem', { name: 'Pin to the top' }))

      expect(await pinnedStrip()).toBeInTheDocument()
      expect(feed.pin).toHaveBeenCalledWith('a1', 'post-1', true)
    })

    it('tells the newest failure, not an older one', async () => {
      const { feed } = renderFeed([
        post(1, {
          author: { type: 'user', id: 'u-me', name: 'Alice Martin' },
          announcement: announcement()
        })
      ])
      vi.mocked(feed.remove).mockRejectedValueOnce(new Error('offline'))
      vi.mocked(feed.pin).mockRejectedValueOnce(
        Object.assign(new Error('rate_limited'), {
          status: 429,
          code: 'rate_limited'
        })
      )
      fireEvent.click(
        await screen.findByRole('button', { name: 'More actions' })
      )
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
      expect(
        await screen.findByText('Could not change the message.')
      ).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Pin to the top' }))

      expect(
        await screen.findByText(
          "You're going too fast. Wait a moment and try again."
        )
      ).toBeInTheDocument()
    })

    it('offers no one else to unpin it', async () => {
      renderFeed([post(1, { announcement: announcement({ pinnedAt: at(1) }) })])
      const strip = await pinnedStrip()
      expect(
        within(strip).queryByRole('button', { name: 'Unpin' })
      ).not.toBeInTheDocument()
    })

    describe('when several are pinned', () => {
      const mine = { type: 'user' as const, id: 'u-me', name: 'Alice Martin' }
      const pinnedThree = () =>
        renderFeed([
          post(1, {
            body: 'Office closed Friday',
            author: mine,
            announcement: announcement({ pinnedAt: at(1) })
          }),
          post(2, {
            body: 'New coffee machine',
            announcement: announcement({ pinnedAt: at(2) })
          }),
          post(3, {
            body: 'Release on Monday',
            author: mine,
            announcement: announcement({ pinnedAt: at(3) })
          })
        ])
      const openList = async () => {
        const strip = await pinnedStrip()
        fireEvent.click(
          within(strip).getByRole('button', { name: 'All pinned messages' })
        )
        return screen.findByRole('dialog', { name: 'All pinned messages' })
      }

      it('shows one banner with the latest and its place', async () => {
        pinnedThree()
        const strip = await pinnedStrip()

        expect(
          within(strip).getByText('Pinned message 1 of 3')
        ).toBeInTheDocument()
        expect(within(strip).getAllByRole('button')).toHaveLength(2)
        expect(
          within(strip).getByRole('button', {
            name: 'Show the announcement: Release on Monday'
          })
        ).toBeInTheDocument()
      })

      it('moves to the next one once shown', async () => {
        pinnedThree()
        const strip = await pinnedStrip()

        fireEvent.click(
          within(strip).getByRole('button', {
            name: 'Show the announcement: Release on Monday'
          })
        )

        expect(
          within(strip).getByText('Pinned message 2 of 3')
        ).toBeInTheDocument()
        expect(
          within(strip).getByRole('button', {
            name: 'Show the announcement: New coffee machine'
          })
        ).toBeInTheDocument()
      })

      it('lists them all, each mine unpinned on its own', async () => {
        const { feed } = pinnedThree()
        const list = await openList()

        expect(within(list).getAllByRole('listitem')).toHaveLength(3)
        const [first, ...rest] = within(list).getAllByRole('button', {
          name: 'Unpin'
        })
        expect(rest).toHaveLength(1)
        if (!first) throw new Error('no unpin button')
        fireEvent.click(first)

        await waitFor(() => {
          expect(feed.pin).toHaveBeenCalledWith('a1', 'post-3', false)
        })
        expect(
          await screen.findByText('Pinned message 1 of 2')
        ).toBeInTheDocument()
      })

      it('unpins all of mine at once', async () => {
        const { feed } = pinnedThree()
        const list = await openList()

        fireEvent.click(
          within(list).getByRole('button', { name: 'Unpin all messages' })
        )

        await waitFor(() => {
          expect(feed.pin).toHaveBeenCalledTimes(2)
        })
        expect(feed.pin).toHaveBeenCalledWith('a1', 'post-1', false)
        expect(feed.pin).toHaveBeenCalledWith('a1', 'post-3', false)
        const strip = await pinnedStrip()
        await waitFor(() => {
          expect(
            within(strip).getByRole('button', {
              name: 'Show the announcement: New coffee machine'
            })
          ).toBeInTheDocument()
        })
        expect(
          within(strip).queryByText(/Pinned message/)
        ).not.toBeInTheDocument()
      })
    })
  })

  describe('a feedback request', () => {
    const feedback = {
      count: 0,
      anonymous: false,
      average: null,
      mine: null,
      myRating: null,
      answers: null,
      closedAt: null
    }
    const request = (overrides: Partial<FeedPost> = {}) =>
      post(1, { body: 'How was the offsite?', feedback, ...overrides })
    const answers = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        userId: `u-${String(i)}`,
        name: `Member ${String(i)}`,
        rating: 4,
        text: `Comment ${String(i)}`,
        answeredAt: at(2)
      }))

    it('is published from the + menu, anonymous if asked', async () => {
      const { feed } = renderFeed([post(0)])
      fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Feedback' }))
      const dialog = screen.getByRole('dialog', { name: 'Feedback' })
      const ask = within(dialog).getByRole('button', {
        name: 'Ask for feedback'
      })
      expect(ask).toBeDisabled()

      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Question' }),
        { target: { value: 'How was the offsite?' } }
      )
      fireEvent.click(
        within(dialog).getByRole('checkbox', { name: 'Anonymous responses' })
      )
      fireEvent.click(ask)

      expect(
        await screen.findByRole('group', { name: 'How was the offsite?' })
      ).toBeInTheDocument()
      expect(feed.post).toHaveBeenCalledWith('a1', 'How was the offsite?', [], {
        feedback: { anonymous: true }
      })
    })

    it('takes a member’s rating and comment, then shows the average and their comment', async () => {
      const { feed } = renderFeed([request()], {
        space: { ...roadmap, role: 'viewer' }
      })
      const card = await screen.findByRole('group', {
        name: 'How was the offsite?'
      })
      expect(within(card).getByText('0 responses · Open')).toBeInTheDocument()
      const send = within(card).getByRole('button', { name: 'Send feedback' })
      expect(send).toBeDisabled()

      fireEvent.click(within(card).getByRole('radio', { name: '4 stars' }))
      fireEvent.change(
        within(card).getByRole('textbox', { name: 'Add a comment (optional)' }),
        { target: { value: ' Great talks ' } }
      )
      fireEvent.click(send)

      expect(
        await within(card).findByText('1 response · Open')
      ).toBeInTheDocument()
      expect(feed.answer).toHaveBeenCalledWith('a1', 'post-1', {
        rating: 4,
        text: 'Great talks'
      })
      expect(
        within(card).getByRole('img', { name: 'Average rating: 4.0 out of 5' })
      ).toBeInTheDocument()
      expect(within(card).getByText('Great talks')).toBeInTheDocument()
      expect(within(card).getByText('You:')).toBeInTheDocument()
      expect(within(card).getByRole('button', { name: 'Edit' })).toBeVisible()
    })

    it('shows its author every comment, folded past two, and lets them close it', async () => {
      const { feed } = renderFeed([
        request({
          author: { type: 'user', id: 'u-me', name: 'Alice Martin' },
          feedback: { ...feedback, count: 3, average: 4, answers: answers(3) }
        })
      ])
      const card = await screen.findByRole('group', {
        name: 'How was the offsite?'
      })
      expect(within(card).getByText('Member 0:')).toBeInTheDocument()
      expect(within(card).queryByText('Comment 2')).not.toBeInTheDocument()
      expect(
        within(card).queryByRole('radio', { name: '4 stars' })
      ).not.toBeInTheDocument()

      fireEvent.click(
        within(card).getByRole('button', { name: 'Show all 3 comments' })
      )
      expect(within(card).getByText('Comment 2')).toBeInTheDocument()
      fireEvent.click(within(card).getByRole('button', { name: 'Show less' }))
      expect(within(card).queryByText('Comment 2')).not.toBeInTheDocument()

      fireEvent.click(
        within(card).getByRole('button', { name: 'Close feedback' })
      )

      expect(
        await screen.findByText('3 responses · Closed')
      ).toBeInTheDocument()
      expect(feed.closePoll).toHaveBeenCalledWith('a1', 'post-1')
    })

    it('names no one beside the comments of an anonymous request', async () => {
      renderFeed([
        request({
          author: { type: 'user', id: 'u-me', name: 'Alice Martin' },
          feedback: {
            ...feedback,
            anonymous: true,
            count: 1,
            average: 2,
            answers: [
              {
                userId: null,
                name: null,
                rating: 2,
                text: 'Too long',
                answeredAt: at(2)
              }
            ]
          }
        })
      ])
      const card = await screen.findByRole('group', {
        name: 'How was the offsite?'
      })

      expect(within(card).getByText('Too long')).toBeInTheDocument()
      expect(within(card).queryByText(/:$/)).not.toBeInTheDocument()
    })
  })

  describe('a form', () => {
    const form: Form = {
      fields: [
        { label: 'Name on your badge', kind: 'text', options: null },
        { label: 'Lunch', kind: 'choice', options: ['Meat', 'Veggie'] }
      ],
      anonymous: false,
      count: 0,
      mine: null,
      responses: null,
      closedAt: null
    }
    const signUp = (overrides: Partial<FeedPost> = {}) =>
      post(1, { body: 'Offsite sign-up', form, ...overrides })

    it('is published from the + menu with text and choice questions', async () => {
      const { feed } = renderFeed([post(0)])
      fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Form' }))
      const dialog = screen.getByRole('dialog', { name: 'New form' })
      const send = within(dialog).getByRole('button', { name: 'Send form' })
      expect(send).toBeDisabled()

      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), {
        target: { value: 'Offsite sign-up' }
      })
      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Question 1' }),
        { target: { value: 'Name on your badge' } }
      )
      fireEvent.click(
        within(dialog).getByRole('button', { name: 'Choice question' })
      )
      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Question 2' }),
        { target: { value: 'Lunch' } }
      )
      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Question 2, option 1' }),
        { target: { value: 'Meat' } }
      )
      expect(send).toBeDisabled()
      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Question 2, option 2' }),
        { target: { value: 'Veggie' } }
      )
      fireEvent.click(send)

      expect(
        await screen.findByRole('group', { name: 'Offsite sign-up' })
      ).toBeInTheDocument()
      expect(feed.post).toHaveBeenCalledWith('a1', 'Offsite sign-up', [], {
        form: {
          fields: [
            { label: 'Name on your badge', kind: 'text' },
            { label: 'Lunch', kind: 'choice', options: ['Meat', 'Veggie'] }
          ],
          anonymous: false
        }
      })
    })

    it('takes a member’s answer to every question, then shows it', async () => {
      const { feed } = renderFeed([signUp()], {
        space: { ...roadmap, role: 'viewer' }
      })
      const card = await screen.findByRole('group', { name: 'Offsite sign-up' })
      expect(within(card).getByText('0 responses · Open')).toBeInTheDocument()
      const send = within(card).getByRole('button', {
        name: 'Send my response'
      })

      fireEvent.change(
        within(card).getByRole('textbox', { name: 'Name on your badge' }),
        { target: { value: ' Bobby ' } }
      )
      expect(send).toBeDisabled()
      fireEvent.click(within(card).getByRole('radio', { name: 'Veggie' }))
      fireEvent.click(send)

      expect(
        await within(card).findByText('1 response · Open')
      ).toBeInTheDocument()
      expect(feed.respond).toHaveBeenCalledWith('a1', 'post-1', ['Bobby', 1])
      expect(within(card).getByText('Bobby')).toBeInTheDocument()
      expect(within(card).getByText('Veggie')).toBeInTheDocument()
      expect(within(card).queryByRole('radio')).not.toBeInTheDocument()
      expect(within(card).getByRole('button', { name: 'Edit' })).toBeVisible()
    })

    it('shows its author every response and lets them close it', async () => {
      const { feed } = renderFeed([
        signUp({
          author: { type: 'user', id: 'u-me', name: 'Alice Martin' },
          form: {
            ...form,
            count: 1,
            responses: [
              {
                userId: 'u-bob',
                name: 'Bob Durand',
                answers: ['Bobby', 0],
                answeredAt: at(2)
              }
            ]
          }
        })
      ])
      const card = await screen.findByRole('group', { name: 'Offsite sign-up' })
      expect(within(card).getByText('Bob Durand')).toBeInTheDocument()
      expect(within(card).getByText('Meat')).toBeInTheDocument()
      expect(
        within(card).queryByRole('button', { name: 'Send my response' })
      ).not.toBeInTheDocument()

      fireEvent.click(
        within(card).getByRole('button', { name: 'Close the form' })
      )

      expect(await screen.findByText('1 response · Closed')).toBeInTheDocument()
      expect(feed.closePoll).toHaveBeenCalledWith('a1', 'post-1')
    })
  })

  it('edits and deletes my own post only', async () => {
    const mine = post(2, {
      author: { type: 'user', id: 'u-me', name: 'Alice Martin' }
    })
    renderFeed([post(1), mine])
    const article = await screen.findByRole('article', { name: 'Alice Martin' })
    expect(
      within(screen.getByRole('article', { name: 'Bob Durand' })).queryByRole(
        'button',
        { name: 'More actions' }
      )
    ).not.toBeInTheDocument()

    fireEvent.click(
      within(article).getByRole('button', { name: 'More actions' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    fireEvent.change(within(article).getByRole('textbox', { name: 'Edit' }), {
      target: { value: 'Message 2, fixed' }
    })
    fireEvent.click(within(article).getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(within(article).queryByRole('textbox')).not.toBeInTheDocument()
    })
    expect(within(article).getByText('Message 2, fixed')).toBeInTheDocument()
    expect(within(article).getByText('edited')).toBeInTheDocument()

    fireEvent.click(
      within(article).getByRole('button', { name: 'More actions' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => {
      expect(screen.queryByText('Message 2, fixed')).not.toBeInTheDocument()
    })
  })

  it('lets me only delete my post once I am a viewer', async () => {
    renderFeed(
      [post(2, { author: { type: 'user', id: 'u-me', name: 'Alice Martin' } })],
      { space: { ...roadmap, role: 'viewer' } }
    )
    const article = await screen.findByRole('article', { name: 'Alice Martin' })

    fireEvent.click(
      within(article).getByRole('button', { name: 'More actions' })
    )

    expect(
      screen.queryByRole('menuitem', { name: 'Edit' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
  })

  it('follows the live changes of this space', async () => {
    const { feed, live } = renderFeed([post(1)])
    await screen.findByText('Message 1')

    vi.mocked(feed.item).mockResolvedValueOnce(post(2))
    act(() => {
      live.emit('feed', { spaceId: 'a1', itemId: 'post-2', change: 'added' })
    })
    expect(await screen.findByText('Message 2')).toBeInTheDocument()

    act(() => {
      live.emit('feed', {
        spaceId: 'other',
        itemId: 'post-1',
        change: 'removed'
      })
      live.emit('feed', { spaceId: 'a1', itemId: 'post-1', change: 'removed' })
    })
    await waitFor(() => {
      expect(screen.queryByText('Message 1')).not.toBeInTheDocument()
    })
  })

  it('leaves out a changed item it has not loaded, and keeps one it cannot reread', async () => {
    const { feed, live } = renderFeed([post(1)])
    await screen.findByText('Message 1')

    vi.mocked(feed.item)
      .mockResolvedValueOnce(post(0))
      .mockRejectedValueOnce(new Error('offline'))
    act(() => {
      live.emit('feed', { spaceId: 'a1', itemId: 'post-0', change: 'changed' })
      live.emit('feed', { spaceId: 'a1', itemId: 'post-1', change: 'changed' })
    })

    await waitFor(() => {
      expect(feed.item).toHaveBeenCalledTimes(2)
    })
    expect(screen.queryByText('Message 0')).not.toBeInTheDocument()
    expect(screen.getByText('Message 1')).toBeInTheDocument()
  })

  it('moves a changed item that is now the newest to the newest place', async () => {
    const { feed, live } = renderFeed([post(1), post(2)])
    await screen.findByText('Message 2')

    vi.mocked(feed.item).mockResolvedValueOnce(
      post(1, { time: at(3), body: 'Message 1 again' })
    )
    act(() => {
      live.emit('feed', { spaceId: 'a1', itemId: 'post-1', change: 'changed' })
    })

    await screen.findByText('Message 1 again')
    expect(screen.getAllByText(/^Message/).map(m => m.textContent)).toEqual([
      'Message 2',
      'Message 1 again'
    ])
  })

  it('moves a changed item to its place by its new time', async () => {
    const { feed, live } = renderFeed([post(1), post(2), post(5)])
    await screen.findByText('Message 5')

    vi.mocked(feed.item).mockResolvedValueOnce(
      post(1, { time: at(3), body: 'Message 1 again' })
    )
    act(() => {
      live.emit('feed', { spaceId: 'a1', itemId: 'post-1', change: 'changed' })
    })

    await screen.findByText('Message 1 again')
    expect(screen.getAllByText(/^Message/).map(m => m.textContent)).toEqual([
      'Message 2',
      'Message 1 again',
      'Message 5'
    ])
  })

  it('shows my own post once when its live echo arrives', async () => {
    const { feed, live } = renderFeed([])
    fireEvent.change(
      await screen.findByRole('textbox', { name: 'Text message' }),
      { target: { value: 'Hi' } }
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText('Hi')

    const [sent] = (await feed.list('a1', {})).items
    act(() => {
      live.emit('feed', { spaceId: 'a1', itemId: sent?.id, change: 'added' })
    })

    await waitFor(() => {
      expect(screen.getAllByText('Hi')).toHaveLength(1)
    })
  })

  it("previews a post's first link, opening it in a new tab", async () => {
    const { feed } = renderFeed([
      post(5, { body: 'Plan: https://example.com/plan. Thoughts?' }),
      post(6)
    ])
    vi.mocked(feed.linkPreview).mockResolvedValue({
      url: 'https://example.com/plan',
      title: 'The plan',
      description: 'What comes next',
      image: null,
      site: 'Example'
    })

    const link = await screen.findByRole('link', { name: /The plan/ })
    expect(link).toHaveAttribute('href', 'https://example.com/plan')
    expect(link).toHaveAttribute('target', '_blank')
    expect(within(link).getByText('What comes next')).toBeInTheDocument()
    expect(feed.linkPreview).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/plan'
    )
  })

  it('shows no preview whose address is not a web page', async () => {
    const { feed } = renderFeed([
      post(5, { body: 'Plan: https://example.com/plan' }),
      post(6)
    ])
    const preview = Promise.resolve({
      url: 'javascript:alert(1)',
      title: 'The plan',
      description: null,
      image: null,
      site: 'Example'
    })
    vi.mocked(feed.linkPreview).mockReturnValue(preview)

    await waitFor(() => {
      expect(feed.linkPreview).toHaveBeenCalled()
    })
    await act(() => preview)
    expect(screen.queryByText('The plan')).not.toBeInTheDocument()
  })
})
