import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Space } from '@/application/spaces'
import { fakeDirectory } from '@/testing/fakeDirectory'
import { fakeSpaces } from '@/testing/fakeSpaces'
import { renderWithProviders } from '@/testing/renderWithProviders'
import { PeopleDialog } from '@/ui/space/PeopleDialog'

const space: Space = {
  id: 'a1',
  name: 'Roadmap',
  role: 'viewer',
  createdAt: '2026-10-01T08:00:00.000Z',
  color: null,
  description: '',
  pinnedAt: null,
  openedAt: null,
  manages: false,
  apps: [],
  chat: false,
  mail: false,
  homeserverUrl: null,
  chatUrl: null,
  banner: null,
  members: [
    {
      id: 'u-1',
      username: 'carol',
      email: 'carol@acme.test',
      displayName: 'Carol DANVERS',
      workplaceFqdn: null,
      role: 'admin'
    },
    {
      id: 'u-2',
      username: 'alice',
      email: 'alice@acme.test',
      displayName: null,
      workplaceFqdn: null,
      role: 'editor'
    }
  ],
  groups: [{ id: 'g-1', name: 'Designers', role: 'viewer' }],
  resources: []
}

const admin: Space = { ...space, role: 'admin' }

const noop = () => undefined

async function type(text: string) {
  const field = await screen.findByRole('combobox', {
    name: 'Add people or groups'
  })
  field.focus()
  fireEvent.change(field, { target: { value: text } })
}

async function pickRole(button: string, role: string) {
  fireEvent.click(await screen.findByRole('button', { name: button }))
  fireEvent.click(await screen.findByRole('menuitem', { name: role }))
  await waitFor(() => {
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
}

describe('PeopleDialog', () => {
  it('lists the direct members with their roles', async () => {
    renderWithProviders(<PeopleDialog space={space} onClose={noop} />)

    const list = await screen.findByRole('list', { name: 'Members' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Carol DANVERS')
    expect(items[0]).toHaveTextContent('carol@acme.test')
    expect(items[0]).toHaveTextContent('Admin')
    expect(items[1]).toHaveTextContent('Editor')
  })

  it('names a member without a display name by their username', async () => {
    renderWithProviders(<PeopleDialog space={space} onClose={noop} />)

    const list = await screen.findByRole('list', { name: 'Members' })
    expect(within(list).getAllByRole('listitem')[1]).toHaveTextContent('alice')
  })

  it('lists the linked groups after the members, with their roles', async () => {
    renderWithProviders(<PeopleDialog space={space} onClose={noop} />)

    const list = await screen.findByRole('list', { name: 'Members' })
    const group = within(list).getAllByRole('listitem')[2]
    expect(group).toHaveTextContent('Designers')
    expect(group).toHaveTextContent('Group')
    expect(group).toHaveTextContent('Viewer')
  })

  it('shows a viewer no way to add or change anyone', async () => {
    renderWithProviders(<PeopleDialog space={space} onClose={noop} />)

    await screen.findByRole('dialog', { name: 'Members of “Roadmap”' })
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^(Remove|Unlink|Role of)/ })
    ).not.toBeInTheDocument()
  })

  it("lets an admin change a member's or a group's role", async () => {
    const spaces = fakeSpaces()
    renderWithProviders(<PeopleDialog space={admin} onClose={noop} />, {
      spaces
    })

    await pickRole('Role of alice', 'Viewer')
    await pickRole('Role of Designers', 'Admin')

    await waitFor(() => {
      expect(spaces.setMemberRole).toHaveBeenCalledWith('a1', 'u-2', 'viewer')
    })
    await waitFor(() => {
      expect(spaces.setGroupRole).toHaveBeenCalledWith('a1', 'g-1', 'admin')
    })
  })

  it('lets an admin remove a member and unlink a group', async () => {
    const spaces = fakeSpaces()
    renderWithProviders(<PeopleDialog space={admin} onClose={noop} />, {
      spaces
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Remove alice' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unlink Designers' }))

    await waitFor(() => {
      expect(spaces.removeMember).toHaveBeenCalledWith('a1', 'u-2')
    })
    await waitFor(() => {
      expect(spaces.unlinkGroup).toHaveBeenCalledWith('a1', 'g-1')
    })
  })

  it('lets an admin pick people and groups as they type, then add them with a role', async () => {
    const spaces = fakeSpaces()
    const directory = fakeDirectory(
      [
        { username: 'alice', email: 'alice@acme.test', displayName: 'Alice' },
        { username: 'bob', email: 'bob@acme.test', displayName: 'Bob' }
      ],
      [
        { id: 'g-1', name: 'Designers' },
        { id: 'g-2', name: 'Sales' }
      ]
    )
    renderWithProviders(<PeopleDialog space={admin} onClose={noop} />, {
      spaces,
      directory
    })

    await type('bo')
    await waitFor(() => {
      expect(directory.people).toHaveBeenLastCalledWith('bo', 1)
    })
    expect(directory.groups).toHaveBeenLastCalledWith('bo', 1)
    expect(
      screen.queryByRole('option', { name: /Alice/ })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: 'Designers' })
    ).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('option', { name: /Bob/ }))
    await type('sa')
    fireEvent.click(await screen.findByRole('option', { name: 'Sales' }))
    await pickRole('Role', 'Editor')
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))

    await waitFor(() => {
      expect(spaces.addMembers).toHaveBeenCalledWith('a1', ['bob'], 'editor')
    })
    await waitFor(() => {
      expect(spaces.linkGroups).toHaveBeenCalledWith('a1', ['g-2'], 'editor')
    })
  })

  it('keeps the keys of the role menu out of the search field', async () => {
    const directory = fakeDirectory(
      [{ username: 'bob', email: 'bob@acme.test', displayName: 'Bob' }],
      []
    )
    renderWithProviders(<PeopleDialog space={admin} onClose={noop} />, {
      directory
    })

    await type('bo')
    fireEvent.click(await screen.findByRole('option', { name: /Bob/ }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Role' }), {
      key: 'Backspace'
    })

    expect(screen.getByRole('button', { name: 'Bob' })).toBeInTheDocument()
  })

  it('says when a search matches no one', async () => {
    renderWithProviders(<PeopleDialog space={admin} onClose={noop} />, {
      directory: fakeDirectory()
    })

    await type('zzzz')

    expect(await screen.findByText('No one matches.')).toBeInTheDocument()
  })

  it('says when the organization could not be searched', async () => {
    const directory = fakeDirectory()
    vi.mocked(directory.people).mockRejectedValue(
      Object.assign(new Error('refused'), { status: 403, code: 'FORBIDDEN' })
    )
    renderWithProviders(<PeopleDialog space={admin} onClose={noop} />, {
      directory
    })

    expect(
      await screen.findByText('The organization could not be searched.')
    ).toBeInTheDocument()
  })

  it('says why removing the last admin was refused', async () => {
    const spaces = fakeSpaces()
    vi.mocked(spaces.removeMember).mockRejectedValue(
      Object.assign(new Error('refused'), { status: 409, code: 'LAST_ADMIN' })
    )
    renderWithProviders(<PeopleDialog space={admin} onClose={noop} />, {
      spaces
    })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove Carol DANVERS' })
    )

    expect(
      await screen.findByText(
        'A space needs at least one admin. Make someone else an admin first.'
      )
    ).toBeInTheDocument()
  })

  it('shows the code of a refusal it does not know', async () => {
    const spaces = fakeSpaces()
    vi.mocked(spaces.removeMember).mockRejectedValue(
      Object.assign(new Error('refused'), { status: 409, code: 'SOMETHING' })
    )
    renderWithProviders(<PeopleDialog space={admin} onClose={noop} />, {
      spaces
    })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove Carol DANVERS' })
    )

    expect(
      await screen.findByText('The change was refused (SOMETHING).')
    ).toBeInTheDocument()
  })

  it('says when no one has access', async () => {
    renderWithProviders(
      <PeopleDialog
        space={{ ...space, members: [], groups: [] }}
        onClose={noop}
      />
    )

    expect(
      await screen.findByText('No one has access yet.')
    ).toBeInTheDocument()
  })
})
