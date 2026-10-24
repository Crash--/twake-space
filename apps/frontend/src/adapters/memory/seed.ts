import type { MemoryOrganization } from '@/adapters/memory/memoryDirectory'
import type { Suggestion } from '@/application/suggestions'
import type {
  FeedCard,
  FeedItem,
  FeedObject,
  FeedPost
} from '@/application/feed'
import type { User } from '@/application/session'
import type {
  Member,
  ShelfState,
  Space,
  SpaceApp,
  SpaceRole
} from '@/application/spaces'
import type { ApiToken, TokenOwner } from '@/application/tokens'

// The same organization, people and roles as the local SSO stack, so moving
// from the mock to the real backend changes nothing on screen.
const DOMAIN = 'acme.twake.local'
const HOMESERVER = `https://matrix.${DOMAIN}`

const person = (username: string, displayName: string) => ({
  id: `uuid-${username}`,
  username,
  email: `${username}@${DOMAIN}`,
  displayName
})

export const seedOrganization: MemoryOrganization = {
  people: [
    person('alice', 'Alice Martin'),
    person('bob', 'Bob Durand'),
    person('carol', 'Carol Petit'),
    person('dave', 'Dave Moreau')
  ],
  groups: [{ id: 'uuid-designers', name: 'Designers' }]
}

export const seedUser: User = {
  id: 'uuid-alice',
  name: 'Alice Martin',
  email: `alice@${DOMAIN}`,
  workplaceFqdn: null,
  idToken: null
}

const member = (username: string, role: SpaceRole): Member => ({
  id: `uuid-${username}`,
  username,
  email: `${username}@${DOMAIN}`,
  displayName:
    seedOrganization.people.find(p => p.username === username)?.displayName ??
    null,
  workplaceFqdn: null,
  role
})
const designers = (role: SpaceRole) => ({
  id: 'uuid-designers',
  name: 'Designers',
  role
})

const ROADMAP_ROOM = `!roadmap:${DOMAIN}`
const DESIGN_ROOM = `!design-sprint:${DOMAIN}`
const SHOWCASE_ROOM = `!showcase:${DOMAIN}`

const ALL_APPS: SpaceApp[] = ['chat', 'tasks', 'drive', 'mail', 'calendar']

export const seedSpaces: Space[] = [
  {
    id: 'roadmap',
    name: 'Roadmap',
    role: 'admin',
    createdAt: '2026-09-01T08:00:00.000Z',
    pinnedAt: '2026-09-02T08:00:00.000Z',
    openedAt: '2026-10-07T08:00:00.000Z',
    manages: true,
    color: '#46a2ff',
    description: 'What we ship this year, and when.',
    apps: ALL_APPS,
    chat: true,
    mail: true,
    homeserverUrl: HOMESERVER,
    chatUrl: null,
    banner: null,
    members: [
      member('alice', 'admin'),
      member('bob', 'editor'),
      member('dave', 'viewer')
    ],
    groups: [designers('viewer')],
    resources: [
      { kind: 'matrix_space', id: ROADMAP_ROOM },
      { kind: 'project', id: 'project-roadmap' },
      { kind: 'drive', id: 'drive-roadmap' },
      { kind: 'mailbox', id: `roadmap@${DOMAIN}` },
      { kind: 'calendar', id: 'calendar-roadmap' }
    ]
  },
  {
    id: 'design-sprint',
    name: 'Design Sprint',
    role: 'editor',
    createdAt: '2026-09-15T08:00:00.000Z',
    pinnedAt: null,
    openedAt: '2026-10-06T08:00:00.000Z',
    manages: false,
    color: null,
    description: '',
    apps: ['chat', 'tasks', 'drive', 'calendar'],
    chat: true,
    mail: false,
    homeserverUrl: HOMESERVER,
    chatUrl: null,
    banner: null,
    members: [member('carol', 'admin'), member('alice', 'editor')],
    groups: [designers('editor')],
    resources: [
      { kind: 'matrix_space', id: DESIGN_ROOM },
      { kind: 'project', id: 'project-design' },
      { kind: 'drive', id: null },
      { kind: 'mailbox', id: null },
      { kind: 'calendar', id: 'calendar-design' }
    ]
  },
  {
    id: 'showcase',
    name: 'B2B Admin Panel',
    role: 'admin',
    createdAt: '2026-09-02T08:00:00.000Z',
    color: '#f9a825',
    description: 'One feed item of every kind the contract allows.',
    banner: null,
    pinnedAt: null,
    openedAt: null,
    manages: true,
    apps: ALL_APPS,
    chat: true,
    mail: true,
    homeserverUrl: HOMESERVER,
    chatUrl: null,
    members: [
      member('alice', 'admin'),
      member('bob', 'editor'),
      member('carol', 'editor'),
      member('dave', 'viewer')
    ],
    groups: [],
    resources: [
      { kind: 'matrix_space', id: SHOWCASE_ROOM },
      { kind: 'project', id: 'project-showcase' },
      { kind: 'drive', id: 'drive-showcase' },
      { kind: 'mailbox', id: `showcase@${DOMAIN}` },
      { kind: 'calendar', id: 'calendar-showcase' }
    ]
  },
  {
    id: 'handover',
    name: 'Handover',
    role: 'viewer',
    createdAt: '2026-09-20T08:00:00.000Z',
    pinnedAt: null,
    openedAt: null,
    manages: false,
    color: null,
    description: '',
    apps: ALL_APPS,
    chat: false,
    mail: false,
    homeserverUrl: null,
    chatUrl: null,
    banner: null,
    members: [member('dave', 'admin'), member('alice', 'viewer')],
    groups: [],
    resources: [
      { kind: 'matrix_space', id: null },
      { kind: 'project', id: 'project-handover' },
      { kind: 'drive', id: 'drive-handover' },
      { kind: 'mailbox', id: null },
      { kind: 'calendar', id: null }
    ]
  },
  {
    id: 'launch-2025',
    name: 'Launch 2025',
    role: 'admin',
    createdAt: '2025-03-01T08:00:00.000Z',
    pinnedAt: null,
    openedAt: null,
    manages: true,
    color: '#ff9f43',
    description: 'Last year’s launch, done and kept.',
    apps: ALL_APPS,
    chat: false,
    mail: false,
    homeserverUrl: null,
    chatUrl: null,
    banner: null,
    members: [member('alice', 'admin'), member('bob', 'editor')],
    groups: [],
    resources: []
  },
  {
    id: 'offsite',
    name: 'Team Offsite',
    role: 'admin',
    createdAt: '2026-06-01T08:00:00.000Z',
    pinnedAt: null,
    openedAt: null,
    manages: true,
    color: null,
    description: 'Planning the June offsite.',
    apps: ALL_APPS,
    chat: false,
    mail: false,
    homeserverUrl: null,
    chatUrl: null,
    banner: null,
    members: [member('alice', 'admin')],
    groups: [],
    resources: []
  }
]

export const seedShelves: Record<string, ShelfState> = {
  'launch-2025': 'archived',
  offsite: 'trashed'
}

const START = Date.UTC(2026, 9, 1, 8)
const HOUR = 3_600_000
const PEOPLE = ['alice', 'bob', 'carol', 'dave']
const TASK_ACTIONS = ['created', 'assigned', 'moved', 'completed']

const iso = (ms: number) => new Date(ms).toISOString()
// A calendar day as the local date it falls on, `YYYY-MM-DD`.
const isoDate = (ms: number) =>
  new Date(ms - new Date(ms).getTimezoneOffset() * MINUTE)
    .toISOString()
    .slice(0, 10)

function roadmapFeed(): FeedItem[] {
  return Array.from({ length: 24 }, (_, i): FeedItem => {
    const time = iso(START + i * HOUR)
    const round = Math.floor(i / 4)
    const username = PEOPLE[round % PEOPLE.length] ?? 'alice'
    const actor = {
      type: 'user' as const,
      id: `uuid-${username}`,
      name: member(username, 'editor').displayName
    }
    const base = {
      id: `item-${String(i)}`,
      time,
      updatedAt: time,
      reactions:
        i % 5 === 0
          ? [
              { key: '👍', userIds: ['uuid-bob', 'uuid-alice'] },
              { key: '🎉', userIds: ['uuid-carol'] }
            ]
          : []
    }
    switch (i % 4) {
      case 0:
        return {
          ...base,
          kind: 'card',
          category: 'activities',
          type: `com.twake.tasks.task.${TASK_ACTIONS[round % 4] ?? 'created'}.v1`,
          actor,
          object: {
            type: 'task',
            id: `task-${String(i)}`,
            title: `Draft the Q${String((round % 4) + 1)} milestones`,
            container: { kind: 'project', id: 'project-roadmap' }
          },
          preview: null,
          state: {},
          files: null
        }
      case 1:
        return {
          ...base,
          kind: 'card',
          category: 'messages',
          type: `com.twake.mail.message.${round % 2 ? 'sent' : 'received'}.v1`,
          actor: null,
          object: {
            type: 'message',
            id: `message-${String(i)}`,
            title: 'Q4 roadmap: partner feedback',
            container: { kind: 'mailbox', id: `roadmap@${DOMAIN}` }
          },
          preview: null,
          state: {},
          files: null
        }
      case 2: {
        const start = Date.UTC(2026, 9, 9 + round, 9)
        return {
          ...base,
          kind: 'card',
          category: 'events',
          type: `com.twake.calendar.event.${round % 2 ? 'rescheduled' : 'created'}.v1`,
          actor,
          object: {
            type: 'event',
            id: `event-${String(i)}`,
            title: 'Roadmap review',
            container: { kind: 'calendar', id: 'calendar-roadmap' }
          },
          preview: null,
          files: null,
          state: {
            start: iso(start),
            end: iso(start + HOUR),
            allDay: false,
            location: 'Room 4',
            ...(round % 2 && {
              previous: { start: iso(start - HOUR), end: iso(start) }
            }),
            rsvp: { accepted: 2, declined: 0, tentative: 1, pending: 1 }
          }
        }
      }
      default:
        return {
          ...base,
          kind: 'post',
          category: 'messages',
          author: actor,
          body: `Update ${String(i)}: the release notes are ready for review.`,
          editedAt: null,
          poll: null,
          approval: null
        }
    }
  })
}

const MINUTE = 60_000

// One item of every kind the activity contract allows, in the order the
// feed shows them (oldest first), the newest a minute ago, so each time
// reads as an hour of the day. Apps send no state beyond a calendar
// event's, so the other cards carry a title and a preview only.
export function showcaseFeed(now: number): FeedItem[] {
  const person = (username: string) => ({
    type: 'user' as const,
    id: `uuid-${username}`,
    name: member(username, 'editor').displayName
  })
  const heart = (n: number) => ({
    key: '😍',
    userIds: ['uuid-bob', 'uuid-carol', 'uuid-dave'].slice(0, n)
  })
  const card = (
    app: string,
    object: string,
    action: string,
    actor: FeedCard['actor'],
    title: string,
    container: FeedObject['container'],
    extra: Partial<
      Pick<FeedCard, 'preview' | 'state' | 'files' | 'reactions'>
    > = {}
  ): FeedCard => {
    const category = {
      tasks: 'activities',
      mail: 'messages',
      calendar: 'events',
      drive: 'files'
    }[app] as FeedCard['category']
    return {
      id: `${app}-${action}-${title.toLowerCase().replaceAll(/\W+/g, '-')}`,
      kind: 'card',
      category,
      time: '',
      updatedAt: '',
      reactions: [],
      type: `com.twake.${app}.${object}.${action}.v1`,
      actor,
      object: {
        type: object,
        id: `${object}-${title.toLowerCase().replaceAll(/\W+/g, '-')}`,
        title,
        container
      },
      preview: null,
      state: {},
      files: null,
      ...extra
    }
  }
  const project = { kind: 'project', id: 'project-showcase' } as const
  const drive = { kind: 'drive', id: 'drive-showcase' } as const
  const mailbox = { kind: 'mailbox', id: `showcase@${DOMAIN}` } as const
  const calendar = { kind: 'calendar', id: 'calendar-showcase' } as const
  // 9 o'clock, a number of days from now, in the time zone of the browser.
  const nine = (days: number) => {
    const date = new Date(now)
    date.setDate(date.getDate() + days)
    return date.setHours(9, 0, 0, 0)
  }
  const event = (
    start: number,
    state: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    start: iso(start),
    end: iso(start + 60 * MINUTE),
    allDay: false,
    location: null,
    ...state
  })
  const file = (action: string, title: string, actor: string, hearts = 0) =>
    card('drive', 'file', action, person(actor), title, drive, {
      reactions: hearts ? [heart(hearts)] : []
    })
  const task = (
    action: string,
    title: string,
    actor: FeedCard['actor'],
    preview: string | null = null
  ) => card('tasks', 'task', action, actor, title, project, { preview })
  const items: FeedItem[] = [
    file('created', 'Long_filename_2026_39399.pdf', 'bob', 2),
    file('updated', 'Waterfall_Krka.png', 'bob'),
    file('created', 'Budget_2027.xlsx', 'carol'),
    file(
      'created',
      'The Future of Technology: Trends, Challenges, and Opportunities.pptx',
      'carol',
      2
    ),
    file('updated', 'Project brief.docx', 'dave'),
    file('created', 'Kickoff_notes.txt', 'alice'),
    card('drive', 'folder', 'changed', person('carol'), 'Q4 assets', drive, {
      files: {
        created: 1200,
        updated: 3,
        deleted: 0,
        samples: [
          'logo.svg',
          'banner.png',
          'brief.pdf',
          'budget.xlsx',
          'notes.md'
        ]
      }
    }),
    task('created', 'Draft the launch plan', person('bob')),
    task('updated', 'Update landing page CTA', person('carol'), 'New wording'),
    task(
      'assigned',
      'Update landing page CTA',
      person('alice'),
      'Following the client feedback'
    ),
    task('unassigned', 'Review the pricing table', person('bob')),
    task('moved', 'Landing page view', person('carol'), 'In progress'),
    task('completed', 'Fix the sign-in redirect', person('dave')),
    task('reopened', 'Fix the sign-in redirect', person('dave')),
    task('deleted', 'Old onboarding survey', person('alice')),
    task('restored', 'Old onboarding survey', person('alice')),
    task('created', 'Sync the CRM contacts', {
      type: 'token',
      id: 'token-zapier',
      name: 'Zapier'
    }),
    task('completed', 'Archive the 2025 contracts', {
      type: 'deleted_user'
    }),
    task('assigned', 'Prepare the board slides', {
      type: 'user',
      id: null,
      name: null
    }),
    card(
      'mail',
      'message',
      'received',
      null,
      'Feedback on the landing page draft',
      mailbox,
      {
        preview:
          'This is looking great! A couple of small notes on the hero copy and pricing table before we send it to the client.'
      }
    ),
    card(
      'mail',
      'message',
      'sent',
      person('bob'),
      'Re: Feedback on the landing page draft',
      mailbox,
      { preview: 'Thanks, the notes are in. Sending the new version today.' }
    ),
    card(
      'calendar',
      'event',
      'created',
      person('carol'),
      'Design Sprint Planning',
      calendar,
      {
        state: event(nine(1), {
          location: 'Room 4',
          meeting: { room: 'abc-defg-hij' },
          rsvp: { accepted: 2, declined: 0, tentative: 1, pending: 1 }
        })
      }
    ),
    card(
      'calendar',
      'event',
      'updated',
      person('carol'),
      'Team lunch',
      calendar,
      { state: event(nine(2), { location: 'Le Petit Bistro' }) }
    ),
    card(
      'calendar',
      'event',
      'rescheduled',
      person('bob'),
      'Design review',
      calendar,
      {
        state: event(nine(1) + 60 * MINUTE, {
          previous: {
            start: iso(nine(1)),
            end: iso(nine(1) + 60 * MINUTE)
          }
        })
      }
    ),
    card(
      'calendar',
      'event',
      'accepted',
      person('dave'),
      'Roadmap review',
      calendar,
      {
        state: event(nine(3), {
          rsvp: { accepted: 3, declined: 0, tentative: 0, pending: 1 }
        })
      }
    ),
    card(
      'calendar',
      'event',
      'declined',
      person('alice'),
      'Budget meeting',
      calendar,
      {
        state: event(nine(4), {
          rsvp: { accepted: 1, declined: 2, tentative: 0, pending: 1 }
        })
      }
    ),
    card(
      'calendar',
      'event',
      'proposed',
      person('bob'),
      'Quarterly planning',
      calendar,
      {
        state: event(nine(5), {
          proposed: {
            start: iso(nine(5) + 120 * MINUTE),
            end: iso(nine(5) + 180 * MINUTE),
            by: 'Bob Durand'
          }
        })
      }
    ),
    card(
      'calendar',
      'event',
      'created',
      person('carol'),
      'Company offsite',
      calendar,
      {
        state: {
          start: isoDate(nine(20)),
          end: isoDate(nine(21)),
          allDay: true,
          location: 'Lyon'
        }
      }
    )
  ]
  const posts: FeedPost[] = [
    {
      id: 'post-plain',
      kind: 'post',
      category: 'messages',
      author: person('bob'),
      body: 'Update: the release notes are ready for review.',
      editedAt: null,
      poll: null,
      approval: null,
      reactions: [],
      time: '',
      updatedAt: ''
    },
    {
      id: 'post-edited',
      kind: 'post',
      category: 'messages',
      author: person('carol'),
      body: 'Standup moves to 10:15 from Monday.\nPlease update your calendars.',
      editedAt: iso(now - 10 * MINUTE),
      poll: null,
      approval: null,
      reactions: [
        { key: '👍', userIds: ['uuid-alice', 'uuid-bob'] },
        { key: '🎉', userIds: ['uuid-dave'] },
        { key: '👀', userIds: ['uuid-alice'] }
      ],
      time: '',
      updatedAt: ''
    },
    {
      id: 'post-mine',
      kind: 'post',
      category: 'messages',
      author: person('alice'),
      body: 'Thanks all, I am merging the landing page today. A long message follows so the bubble wraps on a narrow screen: the hero copy, the pricing table, the footer links and the cookie banner all changed.',
      editedAt: null,
      poll: null,
      approval: null,
      reactions: [],
      time: '',
      updatedAt: ''
    },
    {
      id: 'post-poll',
      kind: 'post',
      category: 'messages',
      author: person('bob'),
      body: 'Which day suits the team lunch?',
      editedAt: null,
      poll: {
        kind: 'choice',
        options: [
          { label: 'Tuesday', userIds: ['uuid-carol', 'uuid-dave'] },
          { label: 'Thursday', userIds: ['uuid-bob'] },
          { label: 'Friday', userIds: [] }
        ],
        closedAt: null
      },
      approval: null,
      reactions: [],
      time: '',
      updatedAt: ''
    },
    {
      id: 'post-yes-no',
      kind: 'post',
      category: 'messages',
      author: person('carol'),
      body: 'Do we keep the Friday demo?',
      editedAt: null,
      poll: {
        kind: 'yes_no',
        options: [
          { label: 'yes', userIds: ['uuid-bob', 'uuid-dave'] },
          { label: 'no', userIds: ['uuid-carol'] }
        ],
        closedAt: null
      },
      approval: null,
      reactions: [],
      time: '',
      updatedAt: ''
    },
    {
      id: 'post-approval',
      kind: 'post',
      category: 'messages',
      author: person('dave'),
      body: 'Approve the new landing page copy before Monday?',
      editedAt: null,
      poll: null,
      approval: {
        state: 'pending',
        approvers: [
          {
            id: 'uuid-carol',
            name: 'Carol Petit',
            decision: 'approved',
            comment: 'Clear and short, ship it.',
            decidedAt: iso(now - 5 * MINUTE)
          },
          {
            id: 'uuid-alice',
            name: seedUser.name,
            decision: null,
            comment: null,
            decidedAt: null
          }
        ],
        closedAt: null
      },
      reactions: [],
      time: '',
      updatedAt: ''
    }
  ]
  // Posts come last, among the cards, one after the other.
  const all = [
    ...items.slice(0, 6),
    posts[0],
    ...items.slice(6, 18),
    posts[1],
    ...items.slice(18),
    posts[3],
    posts[4],
    posts[5],
    posts[2]
  ].filter((item): item is FeedItem => item !== undefined)
  return all.map((item, i) => {
    const time = iso(now - (all.length - i) * MINUTE)
    return { ...item, time, updatedAt: time }
  })
}

export const seedFeed: Record<string, FeedItem[]> = {
  roadmap: roadmapFeed(),
  showcase: showcaseFeed(Date.now()),
  'design-sprint': []
}

// Alice last saw Roadmap before its last 8 items.
export const seedFeedReads: Record<string, string> = {
  roadmap: iso(START + 15 * HOUR)
}

export const seedTokens: Record<TokenOwner, ApiToken[]> = {
  personal: [
    {
      id: 'token-alice-assistant',
      name: 'My assistant',
      scopes: ['space:read', 'feed:read'],
      spaces: 'all',
      role: null,
      expiresAt: '2026-12-31T00:00:00.000Z',
      lastUsedAt: '2026-10-06T16:20:00.000Z',
      createdAt: '2026-10-01T09:00:00.000Z'
    }
  ],
  organization: [
    {
      id: 'token-org-digest',
      name: 'Weekly digest agent',
      scopes: ['space:read', 'feed:read'],
      spaces: ['roadmap', 'design-sprint'],
      role: 'viewer',
      expiresAt: null,
      lastUsedAt: null,
      createdAt: '2026-09-15T09:00:00.000Z'
    }
  ]
}

export const seedSuggestions: Suggestion[] = [
  {
    id: 'suggestion-1',
    text: 'You are free on Monday between 9:30 and 9:45. Do you want to plan the meeting?',
    pendingCallId: 'pending-call-1'
  }
]
