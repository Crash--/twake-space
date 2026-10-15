import { describe, expect, it } from 'vitest'

import {
  EMBEDDED_APPS,
  embedUrl,
  parseEmbedPath,
  pathBelow,
  reconcile,
  reconcileHidden,
  spaceOfResource,
  type FrameState,
  type ShownApp
} from '@/application/embeddedApps'

const TASKS = 'https://tasks.test/'
const tasks = EMBEDDED_APPS.tasks

describe('pathBelow', () => {
  it('gives the path below the embed route', () => {
    expect(pathBelow('/embed/projects/p1', '/embed/projects/p1')).toBe('')
    expect(pathBelow('/embed/projects/p1', '/embed/projects/p1/b?x#y')).toBe(
      '/b?x#y'
    )
    expect(pathBelow('/embed/projects/p1', '/embed/projects/p1?x')).toBe('?x')
  })

  it('refuses another route', () => {
    expect(pathBelow('/embed/projects/p1', '/embed/projects/p12')).toBeNull()
    expect(pathBelow('/embed/projects/p1', '/other')).toBeNull()
  })
})

describe('embedUrl', () => {
  it('frames the resource at the path', () => {
    expect(embedUrl(TASKS, '/embed/projects/p1', '')).toBe(
      'https://tasks.test/embed/projects/p1'
    )
    expect(embedUrl(TASKS, '/embed/projects/p1', '/boards/b1?task=T-1')).toBe(
      'https://tasks.test/embed/projects/p1/boards/b1?task=T-1'
    )
  })

  it('refuses a path that leaves the route', () => {
    expect(embedUrl(TASKS, '/embed/projects/p1', 'x')).toBeNull()
    expect(embedUrl(TASKS, '/embed/projects/p1', '/../../admin')).toBeNull()
    expect(embedUrl(TASKS, '/embed/projects/p1', '//evil.test/x')).toBeNull()
    expect(embedUrl(TASKS, '/embed/projects/p1', '/%2e%2e/%2e%2e/x')).toBeNull()
  })
})

describe('parseEmbedPath', () => {
  it('reads the embed dialect', () => {
    expect(
      parseEmbedPath(
        {
          type: 'twake-embed:path',
          resourceId: 'p1',
          path: '/b',
          replace: false
        },
        '/embed/projects/p1'
      )
    ).toEqual({
      dialect: 'embed',
      resourceId: 'p1',
      path: '/b',
      replace: false
    })
    expect(
      parseEmbedPath(
        { type: 'twake-embed:path', resourceId: 'p1', path: 'b' },
        '/embed/projects/p1'
      )
    ).toBeNull()
  })

  it("reads Tasks' legacy message as a replace", () => {
    expect(
      parseEmbedPath(
        { type: 'twake-tasks:path', path: '/embed/projects/p1/b' },
        '/embed/projects/p1'
      )
    ).toEqual({
      dialect: 'legacy',
      resourceId: null,
      path: '/b',
      replace: true
    })
    expect(
      parseEmbedPath(
        { type: 'twake-tasks:path', path: '/embed/projects/p12' },
        '/embed/projects/p1'
      )
    ).toBeNull()
  })

  it('ignores anything else', () => {
    expect(parseEmbedPath(null, '/e')).toBeNull()
    expect(parseEmbedPath({ type: 'other' }, '/e')).toBeNull()
  })
})

describe('reconcile', () => {
  const shown = (over: Partial<ShownApp> = {}): ShownApp => ({
    app: 'tasks',
    spaceId: 'a1',
    resourceId: 'p1',
    path: '',
    ...over
  })
  const frame = (over: Partial<FrameState> = {}): FrameState => ({
    key: 1,
    src: 'https://tasks.test/embed/projects/p1',
    spaceId: 'a1',
    resourceId: 'p1',
    path: '',
    dialect: 'embed',
    pending: null,
    writtenFrom: null,
    ...over
  })

  it('creates the frame at the path shown', () => {
    expect(
      reconcile(
        null,
        shown({ path: '/b' }),
        tasks,
        TASKS,
        true,
        '/spaces/a1/tasks/b'
      )
    ).toEqual({
      kind: 'create',
      src: 'https://tasks.test/embed/projects/p1/b'
    })
  })

  it('falls back to the embed route for a path that leaves it', () => {
    expect(
      reconcile(
        null,
        shown({ path: '/../x' }),
        tasks,
        TASKS,
        false,
        '/spaces/a1/tasks/../x'
      )
    ).toEqual({ kind: 'adopt', to: '/spaces/a1/tasks' })
  })

  it('loads another resource in a frame that speaks embed', () => {
    expect(
      reconcile(
        frame(),
        shown({ resourceId: 'p2' }),
        tasks,
        TASKS,
        false,
        '/spaces/a1/tasks'
      )
    ).toEqual({ kind: 'load' })
  })

  it('replaces a frame that does not speak embed for another resource', () => {
    for (const dialect of ['legacy', null] as const) {
      expect(
        reconcile(
          frame({ dialect }),
          shown({ resourceId: 'p2', path: '/b' }),
          tasks,
          TASKS,
          false,
          '/spaces/a1/tasks/b'
        )
      ).toEqual({
        kind: 'replace',
        src: 'https://tasks.test/embed/projects/p2/b'
      })
    }
  })

  it('replaces the frame when the app moved to another origin', () => {
    expect(
      reconcile(
        frame({ path: '/b' }),
        shown({ path: '/b' }),
        tasks,
        'https://tasks-acme.test/',
        false,
        '/spaces/a1/tasks/b'
      )
    ).toEqual({
      kind: 'replace',
      src: 'https://tasks-acme.test/embed/projects/p1/b'
    })
  })

  it('leaves the frame alone until the address it wrote shows', () => {
    expect(
      reconcile(
        frame({ path: '/b', writtenFrom: '/spaces/a1/tasks' }),
        shown(),
        tasks,
        TASKS,
        true,
        '/spaces/a1/tasks'
      )
    ).toEqual({ kind: 'none' })
  })

  it('does nothing when the frame shows the path', () => {
    expect(
      reconcile(
        frame({ path: '/b' }),
        shown({ path: '/b' }),
        tasks,
        TASKS,
        true,
        '/spaces/a1/tasks/b'
      )
    ).toEqual({ kind: 'none' })
  })

  it('takes the path of the frame when its tab shows again', () => {
    expect(
      reconcile(
        frame({ path: '/b' }),
        shown(),
        tasks,
        TASKS,
        false,
        '/spaces/a1/tasks'
      )
    ).toEqual({ kind: 'adopt', to: '/spaces/a1/tasks/b' })
  })

  it('brings the frame back to the embed route on Back', () => {
    expect(
      reconcile(
        frame({ path: '/b' }),
        shown(),
        tasks,
        TASKS,
        true,
        '/spaces/a1/tasks'
      )
    ).toEqual({ kind: 'navigate' })
  })

  it('moves a frame that speaks embed to the path shown', () => {
    expect(
      reconcile(
        frame(),
        shown({ path: '/b' }),
        tasks,
        TASKS,
        true,
        '/spaces/a1/tasks/b'
      )
    ).toEqual({ kind: 'navigate' })
    expect(
      reconcile(
        frame({ dialect: 'legacy' }),
        shown({ path: '/b' }),
        tasks,
        TASKS,
        true,
        '/spaces/a1/tasks/b'
      )
    ).toEqual({ kind: 'none' })
  })
})

describe('reconcileHidden', () => {
  const frame = (over: Partial<FrameState> = {}): FrameState => ({
    key: 1,
    src: 'https://tasks.test/embed/projects/p1',
    spaceId: 'a1',
    resourceId: 'p1',
    path: '/kept',
    dialect: 'embed',
    pending: null,
    writtenFrom: null,
    ...over
  })

  it('creates the frame on the embed route, with no path', () => {
    expect(reconcileHidden(null, 'p1', tasks, TASKS)).toEqual({
      kind: 'create',
      src: 'https://tasks.test/embed/projects/p1'
    })
  })

  it('leaves a frame on its resource alone, whatever path it keeps', () => {
    expect(reconcileHidden(frame(), 'p1', tasks, TASKS)).toEqual({
      kind: 'none'
    })
  })

  it('loads another resource in a frame that speaks embed', () => {
    expect(reconcileHidden(frame(), 'p2', tasks, TASKS)).toEqual({
      kind: 'load'
    })
  })

  it('replaces the frame of an app that does not', () => {
    for (const dialect of ['legacy', null] as const) {
      expect(reconcileHidden(frame({ dialect }), 'p2', tasks, TASKS)).toEqual({
        kind: 'replace',
        src: 'https://tasks.test/embed/projects/p2'
      })
    }
  })

  it('replaces the frame when the app moved to another origin', () => {
    expect(
      reconcileHidden(frame(), 'p1', tasks, 'https://tasks-acme.test/')
    ).toEqual({
      kind: 'replace',
      src: 'https://tasks-acme.test/embed/projects/p1'
    })
  })

  it('never asks to navigate or to adopt an address', () => {
    const kinds = [
      reconcileHidden(null, 'p1', tasks, TASKS),
      reconcileHidden(frame(), 'p1', tasks, TASKS),
      reconcileHidden(frame(), 'p2', tasks, TASKS),
      reconcileHidden(frame({ dialect: 'legacy' }), 'p2', tasks, TASKS)
    ].map(next => next.kind)
    expect(kinds).not.toContain('navigate')
    expect(kinds).not.toContain('adopt')
  })
})

describe('the Calendar tab', () => {
  it('frames the team calendar of the space', () => {
    const calendar = EMBEDDED_APPS.calendar
    expect(calendar.resource).toBe('calendar')
    expect(
      embedUrl('https://calendar.test/', calendar.embedPath('6ac4ce5f'), '')
    ).toBe('https://calendar.test/embed/calendars/6ac4ce5f')
    expect(calendar.overlayPath).toBe('/embed/overlay.html')
  })
})

describe('spaceOfResource', () => {
  const spaces = [
    { id: 'a1', resources: [{ kind: 'mailbox' as const, id: 'team@acme' }] },
    { id: 'b2', resources: [{ kind: 'mailbox' as const, id: 'other@acme' }] }
  ]

  it('finds the space whose resource for the app it is', () => {
    expect(spaceOfResource(spaces, 'mail', 'other@acme')).toBe('b2')
  })

  it('finds none for an unknown resource, or another app', () => {
    expect(spaceOfResource(spaces, 'mail', 'nobody@acme')).toBeNull()
    expect(spaceOfResource(spaces, 'chat', 'team@acme')).toBeNull()
  })
})
