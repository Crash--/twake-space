import { act, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ASSISTANT_INTENT } from '@/application/assistant'
import type { Space } from '@/application/spaces'
import { fakeFeed } from '@/testing/fakeFeed'
import { fakeSession, fakeUser } from '@/testing/fakeSession'
import { fakeSpaces } from '@/testing/fakeSpaces'
import { renderWithProviders } from '@/testing/renderWithProviders'
import { AssistantPanel } from '@/ui/assistant/AssistantPanel'

const { createIntent } = vi.hoisted(() => ({
  createIntent: vi.fn(() =>
    Promise.resolve({
      id: 'i1',
      action: 'OPEN',
      type: 'io.cozy.ai.chat.conversations',
      services: [
        { slug: 'assistant', href: 'https://assistant.test/intents/?intent=i1' }
      ]
    })
  )
}))

vi.mock('@linagora/twake-sdk', () => ({
  createSdk: () => ({
    platformURL: 'https://alice.twake.test',
    status: 'ready',
    onStatusChange: () => () => undefined,
    createIntent
  })
}))

const ORIGIN = 'https://assistant.test'

function renderPanel(
  idToken: string | null = 'id-token',
  role: Space['role'] = 'editor'
) {
  const feed = fakeFeed()
  const spaces = fakeSpaces()
  vi.mocked(spaces.get).mockResolvedValue({
    id: 'a1',
    name: 'Roadmap',
    role,
    createdAt: '2026-01-01T00:00:00.000Z',
    color: null,
    description: '',
    pinnedAt: null,
    openedAt: null,
    manages: role === 'admin',
    apps: [],
    chat: false,
    mail: false,
    homeserverUrl: null,
    chatUrl: null,
    banner: null,
    members: [],
    groups: [],
    resources: []
  })
  const onClose = vi.fn()
  renderWithProviders(<AssistantPanel spaceId="a1" onClose={onClose} />, {
    session: fakeSession(() => Promise.resolve(fakeUser(idToken))),
    feed,
    spaces
  })
  return { feed, onClose }
}

async function findFrame(): Promise<HTMLIFrameElement> {
  const frame = await screen.findByTitle('Ask Twake AI')
  if (!(frame instanceof HTMLIFrameElement)) throw new Error('no frame')
  return frame
}

function receive(data: unknown, origin = ORIGIN, source = frameWindow()): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }))
  })
}

function frameWindow(): Window | null {
  const frame = screen.queryByTitle('Ask Twake AI')
  return frame instanceof HTMLIFrameElement ? frame.contentWindow : null
}

describe('AssistantPanel', () => {
  it('frames the assistant intent and configures it when it is ready', async () => {
    renderPanel()

    const frame = await findFrame()
    expect(createIntent).toHaveBeenCalledWith(ASSISTANT_INTENT)
    expect(frame).toHaveAttribute(
      'src',
      'https://assistant.test/intents/?intent=i1'
    )
    const inside = frame.contentWindow
    if (!inside) throw new Error('no frame window')
    const postMessage = vi.spyOn(inside, 'postMessage')

    receive({ type: 'intent-i1:ready' }, 'https://elsewhere.test')
    expect(postMessage).not.toHaveBeenCalled()
    receive({ type: 'intent-i1:ready' })

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        answerActions: [{ name: 'post', label: 'Post in the feed' }]
      }),
      ORIGIN
    )
  })

  it('posts the answer the user picks in the feed of the space', async () => {
    const { feed } = renderPanel()
    await findFrame()

    receive({
      type: 'intent-i1:result',
      result: { answerAction: 'post', text: 'Hello all', format: 'markdown' }
    })

    await waitFor(() => {
      expect(feed.post).toHaveBeenCalledWith('a1', 'Hello all')
    })
    expect(await screen.findByText('Posted in the feed')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the feed' })).toHaveAttribute(
      'href',
      '/spaces/a1/feed'
    )
  })

  it('offers no post in the feed to a viewer', async () => {
    renderPanel('id-token', 'viewer')
    const frame = await findFrame()
    const inside = frame.contentWindow
    if (!inside) throw new Error('no frame window')
    const postMessage = vi.spyOn(inside, 'postMessage')

    // Once the space, and so the role, is loaded
    await waitFor(() => {
      receive({ type: 'intent-i1:ready' })
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ answerActions: [] }),
        ORIGIN
      )
    })
  })

  it('logs a message of the assistant it does not understand', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { feed } = renderPanel()
    await findFrame()

    receive({ type: 'intent-i1:result', result: { text: 'Hello all' } })

    // Not the answer, which would reach Sentry
    expect(warn).toHaveBeenCalledWith(
      'Assistant message ignored:',
      'intent-i1:result'
    )
    expect(feed.post).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('ignores another window of the assistant origin', async () => {
    const { feed, onClose } = renderPanel()
    await findFrame()

    receive(
      {
        type: 'intent-i1:result',
        result: { answerAction: 'post', text: 'Hello all', format: 'markdown' }
      },
      ORIGIN,
      window
    )
    receive({ type: 'intent-i1:cancel' }, ORIGIN, window)

    expect(feed.post).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('says when the answer could not be posted', async () => {
    const { feed } = renderPanel()
    vi.mocked(feed.post).mockRejectedValue(new Error('cannot_post'))
    await findFrame()

    receive({
      type: 'intent-i1:result',
      result: { answerAction: 'post', text: 'Hello all', format: 'markdown' }
    })

    expect(
      await screen.findByText('The answer could not be posted.')
    ).toBeInTheDocument()
  })

  it('closes when the user closes the scribe', async () => {
    const { onClose } = renderPanel()
    await findFrame()

    receive({ type: 'intent-i1:cancel' }, 'https://elsewhere.test')
    expect(onClose).not.toHaveBeenCalled()
    receive({ type: 'intent-i1:cancel' })

    expect(onClose).toHaveBeenCalled()
  })

  it('says when the user has no platform', async () => {
    renderPanel(null)

    expect(
      await screen.findByText('The assistant is not set up for TwakeSpace.')
    ).toBeInTheDocument()
    expect(createIntent).not.toHaveBeenCalled()
  })
})
