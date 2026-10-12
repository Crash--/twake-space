import { fireEvent, screen } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import {
  FeedComposer,
  FeedFilterMenu,
  FeedLayout,
  FeedMoreButton,
  ReactionPicker
} from '@/ds/Feed'
import { renderWithProviders } from '@/testing/renderWithProviders'

const options = [
  { value: 'all', label: 'All' },
  { value: 'files', label: 'Files' }
]

describe('FeedFilterMenu', () => {
  it('offers the options as one choice, with the current one checked', async () => {
    renderWithProviders(
      <FeedFilterMenu
        label="Filter by"
        options={options}
        value="files"
        onChange={vi.fn()}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Filter by' }))

    expect(
      screen.getByRole('menuitemradio', { name: 'Files' })
    ).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: 'All' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })

  it('reports the option picked and closes', async () => {
    const onChange = vi.fn()
    renderWithProviders(
      <FeedFilterMenu
        label="Filter by"
        options={options}
        value="all"
        onChange={onChange}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Filter by' }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Files' }))

    expect(onChange).toHaveBeenCalledWith('files')
    expect(screen.queryByRole('menu')).toBe(null)
  })
})

describe('FeedLayout', () => {
  it('puts the toolbar in the list instead of a row above it', async () => {
    renderWithProviders(
      <FeedLayout
        toolbar={<button type="button">Toolbar</button>}
        composer={null}
        placeKey="all"
        latestLabel="Latest"
      >
        <article aria-label="First" />
      </FeedLayout>
    )

    const toolbar = await screen.findByRole('button', { name: 'Toolbar' })
    const list = screen.getByRole('article', { name: 'First' })
    expect(toolbar.parentElement?.parentElement).toContainElement(list)
  })
})

describe('FeedMoreButton', () => {
  it('leaves room for its 16px icon', async () => {
    renderWithProviders(<FeedMoreButton label="More" onClick={vi.fn()} />)
    const style = getComputedStyle(
      await screen.findByRole('button', { name: 'More' })
    )

    const room =
      parseFloat(style.width) -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight)
    expect(room).toBeGreaterThanOrEqual(16)
  })
})

describe('ReactionPicker', () => {
  it('names its button with a tooltip, and picks an emoji', async () => {
    const onPick = vi.fn()
    renderWithProviders(
      <ReactionPicker
        label="Add a reaction"
        emojis={['👍', '🎉']}
        onPick={onPick}
      />
    )
    const button = await screen.findByRole('button', { name: 'Add a reaction' })

    fireEvent.mouseOver(button)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Add a reaction'
    )

    fireEvent.click(button)
    fireEvent.click(await screen.findByRole('menuitem', { name: '🎉' }))
    expect(onPick).toHaveBeenCalledWith('🎉')
  })
})

function Composer({ onSend }: { onSend: () => void }): ReactElement {
  const [value, setValue] = useState('')
  return (
    <FeedComposer
      label="Text message"
      sendLabel="Send"
      emojiLabel="Add an emoji"
      emojis={['😍', '🎉']}
      value={value}
      onChange={setValue}
      onSend={onSend}
      disabled={false}
    />
  )
}

describe('FeedComposer', () => {
  it('puts the emoji picked after the text', async () => {
    renderWithProviders(<Composer onSend={vi.fn()} />)
    const field = await screen.findByRole('textbox', { name: 'Text message' })
    fireEvent.change(field, { target: { value: 'Well done ' } })

    fireEvent.click(screen.getByRole('button', { name: 'Add an emoji' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: '🎉' }))

    expect(field).toHaveValue('Well done 🎉')
  })

  it('sends only when there is something to send', async () => {
    const onSend = vi.fn()
    renderWithProviders(<Composer onSend={onSend} />)
    const send = await screen.findByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()

    fireEvent.change(screen.getByRole('textbox', { name: 'Text message' }), {
      target: { value: 'Hi' }
    })
    fireEvent.click(send)

    expect(onSend).toHaveBeenCalledTimes(1)
  })
})
