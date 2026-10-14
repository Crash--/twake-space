import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { FeedItem } from '@/application/feed'
import type { Space, SpaceSummary } from '@/application/spaces'
import { fakeFeed } from '@/testing/fakeFeed'
import { fakeSpaces } from '@/testing/fakeSpaces'
import { renderRoute } from '@/testing/renderWithProviders'

const space = (
  id: string,
  name: string,
  openedAt: string | null
): SpaceSummary => ({
  id,
  name,
  role: 'viewer',
  color: null,
  description: '',
  pinnedAt: null,
  openedAt,
  manages: false,
  members: []
})

const spaces = () =>
  fakeSpaces([
    space('space-1', 'Design', '2026-10-01T08:00:00.000Z'),
    space('space-2', 'Launch', '2026-10-02T08:00:00.000Z'),
    space('space-3', 'Handover', null)
  ])

const pressCtrlK = () => {
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
}

describe('SpotSpace', () => {
  it('lists the spaces, the last opened first, and opens one with Enter', async () => {
    const { router } = renderRoute('/', { spaces: spaces() })
    await screen.findAllByRole('link', { name: 'Launch' })

    pressCtrlK()

    const dialog = screen.getByRole('dialog', { name: 'SpotSpace' })
    const field = within(dialog).getByRole('combobox', { name: 'SpotSpace' })
    expect(field).toHaveFocus()
    expect(within(dialog).getAllByRole('option')).toEqual(
      ['Launch', 'Design', 'Handover'].map(name =>
        within(dialog).getByRole('option', { name })
      )
    )

    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(
      within(dialog).getByRole('option', { name: 'Design' })
    ).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(field, { key: 'Enter' })

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/spaces/space-1')
    })
    expect(screen.queryByRole('dialog', { name: 'SpotSpace' })).toBe(null)
  })

  it('filters the spaces by name and opens one with a click', async () => {
    const { router } = renderRoute('/', { spaces: spaces() })
    await screen.findAllByRole('link', { name: 'Launch' })
    pressCtrlK()
    const dialog = screen.getByRole('dialog', { name: 'SpotSpace' })

    fireEvent.change(within(dialog).getByRole('combobox'), {
      target: { value: 'hand' }
    })
    expect(within(dialog).getAllByRole('option')).toHaveLength(1)
    fireEvent.click(within(dialog).getByRole('option', { name: 'Handover' }))

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/spaces/space-3')
    })
  })

  it('says when nothing matches, and closes on Ctrl+K again', async () => {
    renderRoute('/', { spaces: spaces() })
    await screen.findAllByRole('link', { name: 'Launch' })
    pressCtrlK()
    const dialog = screen.getByRole('dialog', { name: 'SpotSpace' })

    fireEvent.change(within(dialog).getByRole('combobox'), {
      target: { value: 'nothing' }
    })
    expect(await within(dialog).findByText('No results')).toBeInTheDocument()

    pressCtrlK()
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'SpotSpace' })).toBe(null)
    })
  })

  describe('the feeds', () => {
    const post: FeedItem = {
      id: 'post-1',
      kind: 'post',
      category: 'messages',
      time: '2026-10-07T09:00:00.000Z',
      updatedAt: '2026-10-07T09:00:00.000Z',
      reactions: [],
      author: { type: 'user', id: 'u-bob', name: 'Bob Durand' },
      body: 'The plan is ready',
      editedAt: null
    }
    const card: FeedItem = {
      id: 'card-1',
      kind: 'card',
      category: 'activities',
      time: '2026-10-07T10:00:00.000Z',
      updatedAt: '2026-10-07T10:00:00.000Z',
      reactions: [],
      type: 'com.twake.tasks.task.created.v1',
      actor: null,
      object: {
        type: 'task',
        id: 'T-1',
        title: 'Plan the launch',
        container: { kind: 'project', id: 'project-1' }
      },
      preview: null,
      state: {},
      files: null
    }
    const design: Space = {
      ...space('space-1', 'Design', null),
      createdAt: '2026-10-01T08:00:00.000Z',
      apps: ['tasks'],
      chat: false,
      mail: false,
      homeserverUrl: null,
      banner: null,
      members: [],
      groups: [],
      resources: [{ kind: 'project', id: 'project-1' }]
    }

    async function searchPlan() {
      const service = spaces()
      vi.mocked(service.get).mockImplementation(id =>
        id === design.id
          ? Promise.resolve(design)
          : Promise.reject(new Error('no space here'))
      )
      const rendered = renderRoute('/', {
        spaces: service,
        feed: fakeFeed({ 'space-1': [card], 'space-3': [post] })
      })
      await screen.findAllByRole('link', { name: 'Launch' })
      pressCtrlK()
      const dialog = screen.getByRole('dialog', { name: 'SpotSpace' })
      const field = within(dialog).getByRole('combobox')
      fireEvent.change(field, { target: { value: 'plan' } })
      await within(dialog).findByRole('option', { name: /The plan is ready/ })
      return { ...rendered, dialog, field }
    }

    it('lists the items of every space after the spaces, newest first', async () => {
      const { dialog } = await searchPlan()

      expect(
        within(dialog)
          .getAllByRole('option')
          .map(option => option.textContent)
      ).toEqual([
        'Plan the launchDesign · Tasks',
        'BDThe plan is readyHandover · Bob Durand'
      ])
    })

    it('opens a card in the tab of its app', async () => {
      const { router, field } = await searchPlan()

      fireEvent.keyDown(field, { key: 'Enter' })

      await waitFor(() => {
        expect(router.state.location.pathname).toBe('/spaces/space-1/tasks')
      })
    })

    it('opens a post in the feed of its space, at the post', async () => {
      const { router, dialog } = await searchPlan()

      fireEvent.click(
        within(dialog).getByRole('option', { name: /The plan is ready/ })
      )

      await waitFor(() => {
        expect(router.state.location.pathname).toBe('/spaces/space-3/feed')
      })
      expect(router.state.location.state).toEqual({ feedItem: 'post-1' })
    })
  })
})
