import { Icon, Trash } from '@linagora/twake-icons'
import { Menu } from '@linagora/twake-mui'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MenuEntry } from '@/ds/Menu'
import { renderWithProviders } from '@/testing/renderWithProviders'

function renderEntry(danger: boolean): void {
  renderWithProviders(
    <Menu open anchorEl={document.body}>
      <MenuEntry
        icon={<Icon icon={Trash} data-testid="icon" />}
        onClick={() => undefined}
        danger={danger}
      >
        Delete space
      </MenuEntry>
    </Menu>
  )
}

describe('MenuEntry', () => {
  it('paints the icon of a danger entry like its label', async () => {
    renderEntry(true)

    const icon = await screen.findByTestId('icon')
    const label = await screen.findByRole('menuitem')
    expect(getComputedStyle(label).color).toBe(
      'var(--twake-palette-error-main)'
    )
    expect(getComputedStyle(icon).color).toBe(getComputedStyle(label).color)
  })
})
