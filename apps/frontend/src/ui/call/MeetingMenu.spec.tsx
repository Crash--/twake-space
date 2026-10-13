import { fireEvent, screen, within } from '@testing-library/react'
import { useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MeetingsService } from '@/application/meetings'
import type { Space } from '@/application/spaces'
import { renderWithProviders } from '@/testing/renderWithProviders'
import { CallWindow } from '@/ui/call/CallWindow'
import { MeetingMenu } from '@/ui/call/MeetingMenu'

const space: Space = {
  id: 'a1',
  name: 'Roadmap',
  role: 'editor',
  createdAt: '2026-10-01T08:00:00.000Z',
  color: null,
  description: '',
  pinnedAt: null,
  openedAt: null,
  manages: false,
  apps: ['chat'],
  chat: true,
  mail: false,
  homeserverUrl: 'https://matrix.test',
  banner: null,
  members: [],
  groups: [],
  resources: [{ kind: 'matrix_space', id: '!s:acme' }]
}

const withCalendar: Space = {
  ...space,
  apps: ['chat', 'calendar'],
  resources: [...space.resources, { kind: 'calendar', id: 'cal-1' }]
}

function Address() {
  const { pathname, search } = useLocation()
  return <output aria-label="address">{pathname + search}</output>
}

function renderMenu(
  meetUrl: string | null = 'https://meet.test',
  target: Space = space
) {
  renderWithProviders(
    <>
      <MeetingMenu space={target} />
      <CallWindow />
      <Address />
    </>,
    { meetUrl, path: '/spaces/a1' }
  )
}

async function choose(entry: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Video meeting' }))
  fireEvent.click(
    within(screen.getByRole('menu')).getByRole('menuitem', { name: entry })
  )
}

async function join(link: string) {
  await choose('Join a meeting')
  const dialog = screen.getByRole('dialog', { name: 'Join a meeting' })
  fireEvent.change(within(dialog).getByLabelText('Meeting link'), {
    target: { value: link }
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Join meeting' }))
}

const meeting = () => screen.getByRole('region', { name: 'Video meeting' })

describe('MeetingMenu', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('is not shown without Meet nor a conversation', () => {
    renderMenu(null, { ...space, chat: false })

    expect(
      screen.queryByRole('button', { name: 'Video meeting' })
    ).not.toBeInTheDocument()
  })

  it("starts a call in the space's conversation", async () => {
    renderMenu()

    await choose('Start an instant meeting')

    expect(screen.getByRole('status', { name: 'address' })).toHaveTextContent(
      '/spaces/a1/chat?call=start'
    )
  })

  it("leaves the Meet room for the conversation's call", async () => {
    renderMenu()
    await join('abcdefghij')

    await choose('Start an instant meeting')

    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })

  it('offers the conversation call alone without Meet', async () => {
    renderMenu(null)

    fireEvent.click(
      await screen.findByRole('button', { name: 'Video meeting' })
    )

    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map(item => item.textContent)
    ).toEqual(['Start an instant meeting'])
  })

  it('opens a pasted room in the call window', async () => {
    renderMenu()

    await join('https://meet.test/abc-defg-hij')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // Maximized: Meet's join screen fits a wide room only
    expect(
      within(meeting()).getByRole('button', { name: 'Restore' })
    ).toBeInTheDocument()
    const frame = within(meeting()).getByTitle('Video meeting')
    expect(frame).toHaveAttribute('src', 'https://meet.test/abc-defg-hij')
    expect(frame).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads'
    )
    expect(frame).toHaveAttribute(
      'allow',
      'camera; microphone; display-capture; autoplay; fullscreen; clipboard-write'
    )
  })

  it('refuses a link to another site', async () => {
    renderMenu()

    await join('https://evil.test/abc-defg-hij')

    expect(
      screen.getByText('This is not a Twake Meet link or code.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })

  it('schedules a meeting in the space, retrying with the same UID', async () => {
    const schedule = vi
      .fn<MeetingsService['schedule']>()
      .mockRejectedValueOnce({ status: 503, code: 'unavailable' })
      .mockResolvedValueOnce(undefined)
    renderWithProviders(<MeetingMenu space={withCalendar} />, {
      meetings: { schedule },
      path: '/spaces/a1'
    })

    await choose('Schedule a meeting')
    const dialog = screen.getByRole('dialog', { name: 'Schedule a meeting' })
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Roadmap')
    fireEvent.change(within(dialog).getByLabelText('Date'), {
      target: { value: '2026-10-14' }
    })
    fireEvent.change(within(dialog).getByLabelText('Start time'), {
      target: { value: '10:00' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }))

    expect(
      await within(dialog).findByText(
        'The calendar cannot be reached. Try again in a moment.'
      )
    ).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule' }))

    expect(
      await screen.findByText(
        'Meeting scheduled. It shows in the feed once the calendar has created it.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const [first, second] = schedule.mock.calls
    expect(first?.[0]).toBe('a1')
    expect(first?.[1].title).toBe('Roadmap')
    expect(first?.[1].start).toMatch(/^2026-10-14T10:00:00[+-]\d\d:\d\d$/)
    expect(first?.[1].end).toMatch(/^2026-10-14T10:30:00[+-]\d\d:\d\d$/)
    expect(second?.[1].uid).toBe(first?.[1].uid)
  })

  it('offers scheduling to editors and admins only', async () => {
    renderMenu(null, { ...withCalendar, role: 'viewer' })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Video meeting' })
    )

    expect(
      within(screen.getByRole('menu')).queryByRole('menuitem', {
        name: 'Schedule a meeting'
      })
    ).not.toBeInTheDocument()
  })

  it('keeps the room loaded while minimized, and leaves it on close', async () => {
    renderMenu()
    await join('abcdefghij')
    const frame = within(meeting()).getByTitle('Video meeting')

    fireEvent.click(within(meeting()).getByRole('button', { name: 'Minimize' }))
    expect(within(meeting()).getByTitle('Video meeting')).toBe(frame)
    fireEvent.click(within(meeting()).getByRole('button', { name: 'Restore' }))
    fireEvent.click(within(meeting()).getByRole('button', { name: 'Maximize' }))
    expect(within(meeting()).getByTitle('Video meeting')).toBe(frame)

    fireEvent.click(
      within(meeting()).getByRole('button', { name: 'Leave the meeting' })
    )
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
})
