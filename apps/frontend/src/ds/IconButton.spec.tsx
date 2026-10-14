import { Icon, Link } from '@linagora/twake-icons'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { IconButton } from '@/ds/IconButton'
import { renderWithProviders } from '@/testing/renderWithProviders'

describe('IconButton', () => {
  it('shows its label in a tooltip on hover, the same as its accessible name', async () => {
    renderWithProviders(
      <IconButton label="Copy the link">
        <Icon icon={Link} />
      </IconButton>
    )
    const button = await screen.findByRole('button', { name: 'Copy the link' })
    expect(button).toHaveAttribute('aria-label', 'Copy the link')
    expect(screen.queryByRole('tooltip')).toBe(null)

    fireEvent.mouseOver(button)

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Copy the link'
    )
  })
})
