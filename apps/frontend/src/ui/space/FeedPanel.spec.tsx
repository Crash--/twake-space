import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  approvalState,
  type Approver,
  type Decision,
  type FeedCard,
  type FeedItem,
  type FeedPost
} from '@/application/feed'
import type { Space } from '@/application/spaces'
import { fakeFeed } from '@/testing/fakeFeed'
import { fakeLive } from '@/testing/fakeLive'
import { renderWithProviders } from '@/testing/renderWithProviders'
import { CallWindow } from '@/ui/call/CallWindow'
import { useLiveUpdates } from '@/ui/live/useLiveUpdates'
import { FeedPanel } from '@/ui/space/FeedPanel'

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
          options: [
            { label: 'Tuesday', userIds: ['u-bob'] },
            { label: 'Friday', userIds: [] }
          ],
          closedAt
        },
        ...overrides
      })

    it('publishes a question and its options from the composer', async () => {
      const { feed } = renderFeed([post(0)])
      fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Poll' }))
      const dialog = screen.getByRole('dialog', { name: 'New poll' })
      const publish = within(dialog).getByRole('button', { name: 'Publish' })

      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Ask a question' }),
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
        within(dialog).getByRole('button', { name: 'Add an option' })
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
      fireEvent.click(publish)

      expect(
        await screen.findByRole('group', { name: 'Which day?' })
      ).toBeInTheDocument()
      expect(feed.post).toHaveBeenCalledWith('a1', 'Which day?', [], {
        poll: { options: ['Tuesday', 'Friday'] }
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('votes, changes the vote and takes it back', async () => {
      const { feed } = renderFeed([lunch()])
      const poll = await screen.findByRole('group', { name: 'Which day?' })

      fireEvent.click(
        within(poll).getByRole('button', { name: 'Friday: 0 votes' })
      )
      expect(
        await within(poll).findByRole('button', {
          name: 'Friday: 1 vote',
          pressed: true
        })
      ).toBeInTheDocument()
      expect(feed.vote).toHaveBeenCalledWith('a1', 'post-1', 1)

      fireEvent.click(
        await within(poll).findByRole('button', {
          name: 'Tuesday: 1 vote',
          pressed: false
        })
      )
      expect(
        await within(poll).findByRole('button', {
          name: 'Tuesday: 2 votes',
          pressed: true
        })
      ).toBeInTheDocument()
      expect(feed.vote).toHaveBeenLastCalledWith('a1', 'post-1', 0)

      fireEvent.click(
        await within(poll).findByRole('button', { name: 'Tuesday: 2 votes' })
      )
      expect(
        await within(poll).findByRole('button', {
          name: 'Tuesday: 1 vote',
          pressed: false
        })
      ).toBeInTheDocument()
      expect(feed.unvote).toHaveBeenCalledWith('a1', 'post-1')
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
        within(poll).getByRole('button', { name: 'Friday: 0 votes' })
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
        within(poll).getByRole('button', { name: 'Friday: 0 votes' })
      )

      expect(await screen.findByText('1 vote · Closed')).toBeInTheDocument()
      expect(
        within(poll).getByRole('button', { name: 'Friday: 0 votes' })
      ).toBeDisabled()
      expect(screen.getByText('Could not save your vote.')).toBeInTheDocument()
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
        within(poll).getByRole('button', { name: 'Friday: 0 votes' })
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
      within(dialog).getByRole('textbox', { name: 'Ask a question' }),
      { target: { value: 'Keep the demo?' } }
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))

    const poll = await screen.findByRole('group', { name: 'Keep the demo?' })
    expect(feed.post).toHaveBeenCalledWith('a1', 'Keep the demo?', [], {
      poll: { kind: 'yes_no' }
    })
    fireEvent.click(within(poll).getByRole('button', { name: 'No: 0 votes' }))
    expect(
      await within(poll).findByRole('button', {
        name: 'No: 1 vote',
        pressed: true
      })
    ).toBeInTheDocument()
    expect(
      within(poll).getByRole('button', { name: 'Yes: 0 votes' })
    ).toBeInTheDocument()
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

    it('asks the members picked to approve', async () => {
      const { feed } = renderFeed([post(0)], {
        space: { ...roadmap, members: [bob] }
      })
      fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Approval request' })
      )
      const dialog = screen.getByRole('dialog', {
        name: 'New approval request'
      })
      const send = within(dialog).getByRole('button', { name: 'Send' })

      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'What needs approval?' }),
        { target: { value: ' Ship the copy? ' } }
      )
      expect(send).toBeDisabled()
      fireEvent.keyDown(
        within(dialog).getByRole('combobox', { name: 'Approvers' }),
        { key: 'ArrowDown' }
      )
      fireEvent.click(await screen.findByRole('option', { name: /Bob Durand/ }))
      fireEvent.click(send)

      expect(
        await screen.findByRole('group', { name: 'Ship the copy?' })
      ).toBeInTheDocument()
      expect(feed.post).toHaveBeenCalledWith('a1', 'Ship the copy?', [], {
        approval: { approvers: ['u-bob'] }
      })
    })

    it('offers no approval request without another member', async () => {
      renderFeed([post(0)])
      fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
      expect(
        screen.getAllByRole('menuitem').map(item => item.textContent)
      ).toEqual(['Poll', 'Yes/no question', 'Announcement', 'Feedback'])
    })

    it('lets an approver approve once, with a comment', async () => {
      const { feed } = renderFeed([
        request([
          approver('u-me', 'Alice Martin'),
          approver('u-carol', 'Carol Diaz', 'approved', 'Clear')
        ])
      ])
      const card = await screen.findByRole('group', { name: 'Ship the copy?' })
      expect(within(card).getByText('Pending')).toBeInTheDocument()
      expect(
        within(card).getByText('Waiting for a decision')
      ).toBeInTheDocument()
      expect(within(card).getByText('Clear')).toBeInTheDocument()

      fireEvent.change(
        within(card).getByRole('textbox', { name: 'Comment (optional)' }),
        { target: { value: ' Looks good ' } }
      )
      fireEvent.click(within(card).getByRole('button', { name: 'Approve' }))

      expect(await screen.findByText('2 of 2 approved')).toBeInTheDocument()
      expect(feed.decide).toHaveBeenCalledWith(
        'a1',
        'post-1',
        'approved',
        'Looks good'
      )
      const decided = screen.getByRole('group', { name: 'Ship the copy?' })
      expect(within(decided).getByText('Looks good')).toBeInTheDocument()
      expect(within(decided).getAllByText('Approved')).toHaveLength(3)
      expect(
        within(decided).queryByRole('button', { name: 'Approve' })
      ).not.toBeInTheDocument()
    })

    it('is rejected by one, and offers nothing to decide to the others', async () => {
      renderFeed([
        request([
          approver('u-bob', 'Bob Durand', 'rejected', 'Not yet'),
          approver('u-carol', 'Carol Diaz')
        ])
      ])
      const card = await screen.findByRole('group', { name: 'Ship the copy?' })

      expect(within(card).getAllByText('Rejected')).toHaveLength(2)
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

      fireEvent.click(screen.getByRole('button', { name: 'Close the request' }))

      expect(
        await screen.findByText('0 of 1 approved · Closed')
      ).toBeInTheDocument()
      expect(feed.closePoll).toHaveBeenCalledWith('a1', 'post-1')
    })
  })

  describe('an announcement', () => {
    const pinnedStrip = () =>
      screen.findByRole('region', { name: 'Pinned announcements' })

    it('is published pinned, above the feed', async () => {
      const { feed } = renderFeed([post(0)])
      fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Announcement' }))
      const dialog = screen.getByRole('dialog', { name: 'New announcement' })

      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Announcement' }),
        { target: { value: ' Office closed Friday ' } }
      )
      fireEvent.click(within(dialog).getByRole('button', { name: 'Announce' }))

      const strip = await pinnedStrip()
      expect(feed.post).toHaveBeenCalledWith('a1', 'Office closed Friday', [], {
        announcement: true
      })
      expect(
        within(strip).getByRole('button', {
          name: 'Show the announcement: Office closed Friday'
        })
      ).toBeInTheDocument()
      expect(screen.getByText('Announcement · Pinned')).toBeInTheDocument()
    })

    it('is unpinned by its author, and stays in the feed', async () => {
      const { feed } = renderFeed([
        post(1, {
          body: 'Office closed Friday',
          author: { type: 'user', id: 'u-me', name: 'Alice Martin' },
          announcement: { pinnedAt: at(1) }
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
          announcement: { pinnedAt: null }
        })
      ])
      fireEvent.click(
        await screen.findByRole('button', { name: 'More actions' })
      )
      fireEvent.click(screen.getByRole('menuitem', { name: 'Pin to the top' }))

      expect(await pinnedStrip()).toBeInTheDocument()
      expect(feed.pin).toHaveBeenCalledWith('a1', 'post-1', true)
    })

    it('offers no one else to unpin it', async () => {
      renderFeed([post(1, { announcement: { pinnedAt: at(1) } })])
      const strip = await pinnedStrip()
      expect(
        within(strip).queryByRole('button', { name: 'Unpin' })
      ).not.toBeInTheDocument()
    })
  })

  describe('a feedback request', () => {
    const request = (overrides: Partial<FeedPost> = {}) =>
      post(1, {
        body: 'How was the offsite?',
        feedback: { count: 0, mine: null, answers: null, closedAt: null },
        ...overrides
      })

    it('is published from the + menu', async () => {
      const { feed } = renderFeed([post(0)])
      fireEvent.click(await screen.findByRole('button', { name: 'Add' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Feedback' }))
      const dialog = screen.getByRole('dialog', { name: 'Ask for feedback' })

      fireEvent.change(
        within(dialog).getByRole('textbox', { name: 'Question' }),
        { target: { value: 'How was the offsite?' } }
      )
      fireEvent.click(within(dialog).getByRole('button', { name: 'Ask' }))

      expect(
        await screen.findByRole('group', { name: 'How was the offsite?' })
      ).toBeInTheDocument()
      expect(feed.post).toHaveBeenCalledWith('a1', 'How was the offsite?', [], {
        feedback: true
      })
    })

    it('takes a viewer’s answer, and shows only its count', async () => {
      const { feed } = renderFeed([request()], {
        space: { ...roadmap, role: 'viewer' }
      })
      const card = await screen.findByRole('group', {
        name: 'How was the offsite?'
      })
      expect(within(card).getByText('0 answers')).toBeInTheDocument()

      fireEvent.change(
        within(card).getByRole('textbox', { name: 'Your answer' }),
        { target: { value: ' Great talks ' } }
      )
      fireEvent.click(within(card).getByRole('button', { name: 'Send' }))

      expect(await within(card).findByText('1 answer')).toBeInTheDocument()
      expect(feed.answer).toHaveBeenCalledWith('a1', 'post-1', 'Great talks')
      expect(within(card).getByText('Great talks')).toBeInTheDocument()
      expect(within(card).getByRole('button', { name: 'Edit' })).toBeVisible()
    })

    it('shows its author every answer, and lets them close it', async () => {
      const { feed } = renderFeed([
        request({
          author: { type: 'user', id: 'u-me', name: 'Alice Martin' },
          feedback: {
            count: 1,
            mine: null,
            answers: [
              {
                userId: 'u-bob',
                name: 'Bob Durand',
                text: 'Too long',
                answeredAt: at(2)
              }
            ],
            closedAt: null
          }
        })
      ])
      const card = await screen.findByRole('group', {
        name: 'How was the offsite?'
      })
      expect(within(card).getByText('Too long')).toBeInTheDocument()
      expect(within(card).getByText('Bob Durand')).toBeInTheDocument()
      expect(
        within(card).queryByRole('textbox', { name: 'Your answer' })
      ).not.toBeInTheDocument()

      fireEvent.click(
        within(card).getByRole('button', { name: 'Close the request' })
      )

      expect(await screen.findByText('1 answer · Closed')).toBeInTheDocument()
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
})
