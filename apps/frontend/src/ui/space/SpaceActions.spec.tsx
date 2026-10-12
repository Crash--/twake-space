import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import type { Space } from '@/application/spaces'
import { fakeSpaces } from '@/testing/fakeSpaces'
import { renderWithProviders } from '@/testing/renderWithProviders'
import { SpaceActions } from '@/ui/space/SpaceActions'

const space: Space = {
  id: 'a1',
  name: 'Roadmap',
  role: 'admin',
  createdAt: '2026-10-01T08:00:00.000Z',
  color: null,
  description: '',
  pinnedAt: null,
  openedAt: null,
  manages: true,
  apps: [],
  chat: false,
  mail: false,
  homeserverUrl: null,
  banner: null,
  members: [],
  groups: [],
  resources: []
}

function Path() {
  return <output aria-label="path">{useLocation().pathname}</output>
}

function renderActions(target: Space, spaces = fakeSpaces()) {
  vi.mocked(spaces.get).mockResolvedValue(target)
  renderWithProviders(
    <>
      <Routes>
        <Route path="/spaces/a1" element={<SpaceActions space={target} />} />
        <Route path="/" element={null} />
      </Routes>
      <Path />
    </>,
    { spaces, path: '/spaces/a1' }
  )
  return spaces
}

const openMenu = async () => {
  fireEvent.click(
    await screen.findByRole('button', { name: 'More actions for Roadmap' })
  )
  return within(await screen.findByRole('menu'))
}

describe('SpaceActions', () => {
  it('lets a member who is not an admin share the link and see the members', async () => {
    renderActions({ ...space, role: 'editor', manages: false })

    expect(
      await screen.findByRole('button', { name: 'Share link' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Twake AI assistant' })
    ).toHaveAttribute('aria-pressed', 'false')
    expect(
      screen.queryByRole('button', { name: 'Invite people' })
    ).not.toBeInTheDocument()
    const menu = await openMenu()
    expect(menu.getAllByRole('menuitem').map(item => item.textContent)).toEqual(
      ['Share link', 'Pin', 'Members']
    )
    fireEvent.click(menu.getByRole('menuitem', { name: 'Members' }))

    expect(
      await screen.findByRole('dialog', { name: 'Members of “Roadmap”' })
    ).toBeInTheDocument()
  })

  it('pins the space, whatever the role', async () => {
    const spaces = renderActions({ ...space, role: 'viewer' })

    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Pin' }))

    await waitFor(() => {
      expect(spaces.setPinned).toHaveBeenCalledWith('a1', true)
    })
  })

  it('unpins a pinned space', async () => {
    const spaces = renderActions({
      ...space,
      pinnedAt: '2026-10-02T08:00:00.000Z'
    })

    fireEvent.click((await openMenu()).getByRole('menuitem', { name: 'Unpin' }))

    await waitFor(() => {
      expect(spaces.setPinned).toHaveBeenCalledWith('a1', false)
    })
  })

  it('copies the link of the space and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })
    renderActions(space)

    fireEvent.click(await screen.findByRole('button', { name: 'Share link' }))

    expect(await screen.findByText('Link copied')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(
      `${window.location.origin}/spaces/a1`
    )
  })

  it('invites people from the header', async () => {
    renderActions(space)

    fireEvent.click(
      await screen.findByRole('button', { name: 'Invite people' })
    )

    expect(
      await screen.findByRole('dialog', {
        name: 'Invite members to “Roadmap”'
      })
    ).toBeInTheDocument()
  })

  it('leaves editing the space to its settings page', async () => {
    renderActions(space)

    const menu = await openMenu()
    expect(menu.getAllByRole('menuitem').map(item => item.textContent)).toEqual(
      [
        'Share link',
        'Pin',
        'Manage people',
        'Manage space',
        'Archive',
        'Delete space'
      ]
    )
  })

  it.each([
    [
      'Delete space',
      'Move Roadmap to the Bin?',
      'Move it to the Bin. You can restore it from there.',
      'Move to Bin',
      'trashed'
    ],
    [
      'Archive',
      'Archive Roadmap?',
      'Hide it from the lists of every member. You can restore it from Archives.',
      'Archive',
      'archived'
    ]
  ])(
    'moves the space out with %s once confirmed, and goes to the space list',
    async (entry, title, hint, confirm, state) => {
      const spaces = renderActions(space)

      fireEvent.click((await openMenu()).getByRole('menuitem', { name: entry }))
      const dialog = await screen.findByRole('dialog', { name: title })
      expect(within(dialog).getByText(hint)).toBeInTheDocument()
      expect(spaces.setState).not.toHaveBeenCalled()
      fireEvent.click(within(dialog).getByRole('button', { name: confirm }))

      await waitFor(() => {
        expect(screen.getByLabelText('path')).toHaveTextContent(/^\/$/)
      })
      expect(spaces.setState).toHaveBeenCalledWith('a1', state)
      expect(spaces.remove).not.toHaveBeenCalled()
    }
  )

  it('keeps the space when the user cancels', async () => {
    const spaces = renderActions(space)

    fireEvent.click(
      (await openMenu()).getByRole('menuitem', { name: 'Delete space' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Move Roadmap to the Bin?'
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(spaces.setState).not.toHaveBeenCalled()
    expect(screen.getByLabelText('path')).toHaveTextContent('/spaces/a1')
  })

  it('leaves archiving and deleting to the people who manage the space', async () => {
    renderActions({ ...space, manages: false })

    const menu = await openMenu()

    expect(menu.queryByRole('menuitem', { name: 'Archive' })).toBe(null)
    expect(menu.queryByRole('menuitem', { name: 'Delete space' })).toBe(null)
  })
})
