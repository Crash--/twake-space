import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ShelvedSpace } from '@/application/spaces'
import { fakeSpaces } from '@/testing/fakeSpaces'
import { renderRoute } from '@/testing/renderWithProviders'

const launch: ShelvedSpace = {
  id: 'launch',
  name: 'Launch 2025',
  role: null,
  color: null,
  description: 'Done and kept',
  pinnedAt: null,
  openedAt: null,
  manages: true,
  members: []
}

function renderShelf(path: '/archives' | '/bin', shelved = [launch]) {
  const spaces = fakeSpaces()
  vi.mocked(spaces.shelved).mockResolvedValue(shelved)
  renderRoute(path, { spaces })
  return spaces
}

const expectIconsHidden = () => {
  const icons = screen.getByRole('main').querySelectorAll('svg')
  expect(icons.length).toBeGreaterThan(0)
  icons.forEach(icon => {
    expect(icon.closest('[aria-hidden="true"]')).not.toBeNull()
  })
}

const openMenu = async () => {
  fireEvent.click(
    await screen.findByRole('button', { name: 'More actions for Launch 2025' })
  )
  return within(await screen.findByRole('menu'))
}

describe('ShelfScreen', () => {
  it('lists the archived spaces, without opening them', async () => {
    const spaces = renderShelf('/archives')

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Archives' })
    ).toBeInTheDocument()
    expect(await screen.findByText('Launch 2025')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Launch 2025' })).toBe(null)
    expect(spaces.shelved).toHaveBeenCalledWith('archived')
  })

  it.each([
    ['/archives', 'Restore', 'active'],
    ['/archives', 'Move to Bin', 'trashed'],
    ['/bin', 'Restore', 'active']
  ] as const)('on %s, %s moves the space', async (path, entry, state) => {
    const spaces = renderShelf(path)

    fireEvent.click((await openMenu()).getByRole('menuitem', { name: entry }))

    await waitFor(() => {
      expect(spaces.setState).toHaveBeenCalledWith('launch', state)
    })
  })

  it('says so when a space could not be moved', async () => {
    const spaces = fakeSpaces()
    vi.mocked(spaces.shelved).mockResolvedValue([launch])
    vi.mocked(spaces.setState).mockRejectedValue(new Error('refused'))
    renderRoute('/archives', { spaces })

    fireEvent.click(
      (await openMenu()).getByRole('menuitem', { name: 'Restore' })
    )

    expect(
      await screen.findByText('The space could not be moved.')
    ).toBeInTheDocument()
  })

  it('deletes a space in the Bin forever, once confirmed', async () => {
    const spaces = renderShelf('/bin')

    fireEvent.click(
      (await openMenu()).getByRole('menuitem', { name: 'Delete forever' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete Launch 2025 forever?'
    })
    expect(spaces.remove).not.toHaveBeenCalled()
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Delete forever' })
    )

    await waitFor(() => {
      expect(spaces.remove).toHaveBeenCalledWith('launch')
    })
  })

  it('empties the Bin, once confirmed', async () => {
    const spaces = renderShelf('/bin')

    fireEvent.click(
      await screen.findByRole('button', { name: 'Empty the Bin' })
    )
    const dialog = await screen.findByRole('dialog', { name: 'Empty the Bin?' })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Empty the Bin' })
    )

    await waitFor(() => {
      expect(spaces.emptyBin).toHaveBeenCalled()
    })
  })

  it('says so when the Bin is empty, with nothing to empty', async () => {
    renderShelf('/bin', [])

    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: 'Your Bin is empty'
      })
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Empty the Bin' })).toBe(null)
    expectIconsHidden()
  })

  it('says so when nothing is archived', async () => {
    renderShelf('/archives', [])

    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: 'No archived spaces'
      })
    ).toBeInTheDocument()
    expectIconsHidden()
  })
})
