import { cleanup, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { FeedbackService } from '@/application/feedback'
import type { Space } from '@/application/spaces'
import { fakeSpaces } from '@/testing/fakeSpaces'
import { renderRoute } from '@/testing/renderWithProviders'

function fakeFeedback(enabled = true): FeedbackService & {
  detach: ReturnType<typeof vi.fn>
} {
  const detach = vi.fn()
  return {
    enabled,
    attach: vi.fn(() => detach),
    setColorScheme: vi.fn(),
    setSpaceTab: vi.fn(),
    detach
  }
}

const space: Space = {
  id: 'a1',
  name: 'Roadmap',
  role: 'editor',
  createdAt: new Date().toISOString(),
  color: null,
  description: '',
  pinnedAt: null,
  openedAt: null,
  manages: false,
  apps: ['chat', 'tasks', 'drive', 'mail', 'calendar'],
  chat: false,
  mail: true,
  homeserverUrl: null,
  banner: null,
  members: [],
  groups: [],
  resources: []
}

describe('feedback button', () => {
  it('is shown by the shell, attached with translated labels, and detached with it', async () => {
    const feedback = fakeFeedback()
    renderRoute('/', { feedback, lang: 'fr' })
    await screen.findByRole('navigation')

    expect(
      await screen.findByTestId('twake-feedback-button')
    ).toBeInTheDocument()
    expect(feedback.setColorScheme).toHaveBeenCalled()
    await waitFor(() => {
      expect(feedback.attach).toHaveBeenLastCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining<Record<string, string>>({
          formTitle: 'Donner un avis'
        })
      )
    })

    cleanup()
    expect(feedback.detach).toHaveBeenCalled()
  })

  it('is outside the page an app dialog makes inert', async () => {
    const { container } = renderRoute('/', { feedback: fakeFeedback() })

    const button = await screen.findByTestId('twake-feedback-button')

    expect(container.contains(button)).toBe(false)
  })

  it('shows nothing without a feedback service', async () => {
    renderRoute('/')
    await screen.findByRole('navigation')

    expect(screen.queryByTestId('twake-feedback-button')).toBeNull()
  })

  it('shows nothing when feedback is off', async () => {
    const feedback = fakeFeedback(false)
    renderRoute('/', { feedback })
    await screen.findByRole('navigation')

    expect(screen.queryByTestId('twake-feedback-button')).toBeNull()
    expect(feedback.attach).not.toHaveBeenCalled()
  })

  it('tags the open space tab and clears it on leaving', async () => {
    const feedback = fakeFeedback()
    const spaces = fakeSpaces()
    vi.mocked(spaces.get).mockResolvedValue(space)
    const { unmount } = renderRoute('/spaces/a1/feed', { feedback, spaces })
    await screen.findByRole('tab', { name: 'Feed' })

    await waitFor(() => {
      expect(feedback.setSpaceTab).toHaveBeenCalledWith('feed')
    })

    unmount()
    expect(feedback.setSpaceTab).toHaveBeenLastCalledWith(null)
  })
})
