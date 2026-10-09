import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MemberAvatars } from '@/ds/Card'
import { renderWithProviders } from '@/testing/renderWithProviders'

const people = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: String(index),
    name: `Member ${String(index)}`,
    src: null
  }))

describe('MemberAvatars', () => {
  it('shows every member that fits', async () => {
    renderWithProviders(<MemberAvatars members={people(5)} />)

    expect(await screen.findAllByLabelText(/^Member \d$/)).toHaveLength(5)
    expect(screen.queryByText(/^\+/)).toBe(null)
  })

  it('keeps a place for the count of the members it leaves out', async () => {
    renderWithProviders(<MemberAvatars members={people(7)} />)

    expect(await screen.findAllByLabelText(/^Member \d$/)).toHaveLength(4)
    expect(screen.getByText('+3')).toBeInTheDocument()
  })

  it('names a member in a tooltip on hover, at the size it is given', async () => {
    renderWithProviders(<MemberAvatars members={people(2)} size="m" />)
    const avatar = await screen.findByLabelText('Member 1')
    expect(avatar).toHaveClass('size-m')

    fireEvent.mouseOver(avatar)

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Member 1')
  })

  it('lists the members it leaves out on hover', async () => {
    renderWithProviders(<MemberAvatars members={people(7)} />)

    fireEvent.mouseOver(
      await screen.findByLabelText('Member 4, Member 5, Member 6')
    )

    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Member 4Member 5Member 6'
    )
  })
})
