import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ApiToken } from '@/application/tokens'
import { fakeTokens } from '@/testing/fakeTokens'
import { renderRoute } from '@/testing/renderWithProviders'

const assistant: ApiToken = {
  id: 't-1',
  name: 'My assistant',
  scopes: ['space:read', 'feed:read'],
  spaces: 'all',
  role: null,
  expiresAt: '2026-12-31T00:00:00.000Z',
  lastUsedAt: null,
  createdAt: '2026-10-01T09:00:00.000Z'
}

const digest: ApiToken = {
  ...assistant,
  id: 't-2',
  name: 'Weekly digest',
  spaces: ['roadmap', 'design'],
  role: 'viewer',
  expiresAt: null
}

function choose(label: string, option: string | RegExp) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

const refusal = (status: number, reason: string) =>
  Object.assign(new Error('refused'), { status, code: 'forbidden', reason })

describe('ApiTokensScreen', () => {
  it('lists the personal tokens', async () => {
    renderRoute('/settings/api-tokens', {
      tokens: fakeTokens({ personal: [assistant] })
    })

    const list = await screen.findByRole('list', { name: 'Your tokens' })
    const item = within(list).getByRole('listitem')
    expect(item).toHaveTextContent('My assistant')
    expect(item).toHaveTextContent('Read spaces')
    expect(item).toHaveTextContent('Read feeds')
    expect(item).toHaveTextContent('All spaces')
    expect(within(item).getByTitle('December 31, 2026')).toHaveTextContent(
      /^Expires /
    )
    expect(item).toHaveTextContent('Never used')
    expect(document.title).toBe('API tokens - Twake Space')
  })

  it('leads back home by default', async () => {
    renderRoute('/settings/api-tokens')

    expect(await screen.findByRole('link', { name: 'Back' })).toHaveAttribute(
      'href',
      '/'
    )
  })

  it('leads back to the space settings that linked here', async () => {
    const { router } = renderRoute('/settings/api-tokens?space=a1')

    expect(await screen.findByRole('link', { name: 'Back' })).toHaveAttribute(
      'href',
      '/spaces/a1/settings'
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Organization' }))
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        '/settings/api-tokens/organization'
      )
    })
    expect(router.state.location.search).toBe('?space=a1')
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute(
      'href',
      '/spaces/a1/settings'
    )
  })

  it('lists the organization tokens with their role and spaces', async () => {
    renderRoute('/settings/api-tokens/organization', {
      tokens: fakeTokens({ organization: [digest] })
    })

    const list = await screen.findByRole('list', {
      name: 'Organization tokens'
    })
    const item = within(list).getByRole('listitem')
    expect(item).toHaveTextContent('2 spaces')
    expect(item).toHaveTextContent('Never expires')
    expect(item).toHaveTextContent('Viewer')
  })

  it('tells someone who is not an organization admin who manages its tokens', async () => {
    const tokens = fakeTokens()
    vi.mocked(tokens.list).mockRejectedValue(
      refusal(403, 'not an admin of the organization')
    )
    renderRoute('/settings/api-tokens/organization', { tokens })

    expect(
      await screen.findByText(
        "Only the organization's owners and admins manage its tokens."
      )
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Create a token' })
    ).not.toBeInTheDocument()
  })

  it('creates a personal token and shows its secret once', async () => {
    const tokens = fakeTokens()
    renderRoute('/settings/api-tokens', { tokens })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create a token' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'New personal token'
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: '  Backup script ' }
    })
    fireEvent.click(
      within(
        within(dialog).getByRole('radiogroup', { name: 'Activity feed' })
      ).getByRole('radio', { name: 'Read' })
    )
    fireEvent.click(
      within(
        within(dialog).getByRole('radiogroup', { name: 'Notifications' })
      ).getByRole('radio', { name: 'Read' })
    )
    choose('Expires in', '90 days')
    expect(
      within(dialog).queryByRole('combobox', { name: 'Acts in each space as' })
    ).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    const secret = await screen.findByRole('dialog', {
      name: 'Backup script is ready'
    })
    expect(within(secret).getByLabelText('Token')).toHaveTextContent(
      'tws_token-1'
    )
    expect(
      within(secret).getByLabelText('Try it in a terminal').textContent
    ).toBe(
      'curl -H "Authorization: Bearer tws_token-1" https://space.test/api/spaces'
    )
    const brief = within(secret).getByLabelText(
      'Brief for an AI agent'
    ).textContent
    expect(brief).toContain('Authorization: Bearer tws_token-1')
    expect(brief).toContain('- GET /spaces/:spaceId/feed\n')
    expect(brief).not.toContain('POST /spaces')
    expect(tokens.create).toHaveBeenCalledWith('personal', {
      name: 'Backup script',
      scopes: ['space:read', 'feed:read', 'notifications:read'],
      spaces: 'all',
      expiresInDays: 90
    })

    fireEvent.click(within(secret).getByRole('button', { name: 'Done' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(
      await screen.findByRole('list', { name: 'Your tokens' })
    ).toHaveTextContent('Backup script')
  })

  it('shows how to call the API', async () => {
    renderRoute('/settings/api-tokens')

    const usage = await screen.findByRole('region', { name: 'Quick start' })
    expect(within(usage).getByLabelText('Base URL')).toHaveTextContent(
      'https://space.test/api/'
    )
    expect(
      within(usage).getByRole('link', { name: 'API reference' })
    ).toHaveAttribute('href', expect.stringContaining('docs/api.md'))
  })

  it('offers only the lifetimes the policy allows', async () => {
    const tokens = fakeTokens(
      {},
      { policy: { allowNoExpiry: true, maxLifetimeDays: 30 } }
    )
    renderRoute('/settings/api-tokens', { tokens })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create a token' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'CI' }
    })
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Expires in' }))
    await waitFor(() => {
      expect(
        screen.getAllByRole('option').map(option => option.textContent)
      ).toEqual(['7 days', '30 days', 'Never'])
    })
    fireEvent.click(screen.getByRole('option', { name: 'Never' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(tokens.create).toHaveBeenCalledWith(
        'personal',
        expect.objectContaining({ expiresInDays: null })
      )
    })
  })

  it('creates an organization token for some spaces with a role', async () => {
    const tokens = fakeTokens({}, { spaces: [{ id: 'legal', name: 'Legal' }] })
    renderRoute('/settings/api-tokens/organization', { tokens })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create a token' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'New organization token'
    })
    expect(
      within(dialog).queryByRole('radiogroup', { name: 'Notifications' })
    ).not.toBeInTheDocument()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Digest' }
    })
    fireEvent.click(within(dialog).getByLabelText('Some spaces'))
    const create = within(dialog).getByRole('button', { name: 'Create' })
    expect(create).toBeDisabled()
    const picker = within(dialog).getByLabelText('Choose spaces')
    picker.focus()
    fireEvent.keyDown(picker, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Legal' }))
    choose('Acts in each space as', /^Admin/)
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'An admin token can delete spaces'
    )
    choose('Acts in each space as', /^Editor/)
    fireEvent.click(create)

    await screen.findByRole('dialog', { name: 'Digest is ready' })
    expect(tokens.create).toHaveBeenCalledWith('organization', {
      name: 'Digest',
      scopes: ['space:read'],
      spaces: ['legal'],
      role: 'editor',
      expiresInDays: 30
    })
  })

  it("shows the backend's reason when a token is refused", async () => {
    const tokens = fakeTokens()
    vi.mocked(tokens.create).mockRejectedValue(
      refusal(400, 'the policy caps tokens at 7 days')
    )
    renderRoute('/settings/api-tokens', { tokens })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Create a token' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'CI' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(
      await within(dialog).findByText(
        'Refused: the policy caps tokens at 7 days'
      )
    ).toBeInTheDocument()
  })

  it('renames a token', async () => {
    const tokens = fakeTokens({ personal: [assistant] })
    renderRoute('/settings/api-tokens', { tokens })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for My assistant' })
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Rename the token'
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Assistant' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(tokens.rename).toHaveBeenCalledWith('personal', 't-1', 'Assistant')
    })
  })

  it('revokes a token after confirming', async () => {
    const tokens = fakeTokens({ organization: [digest] })
    renderRoute('/settings/api-tokens/organization', { tokens })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for Weekly digest' })
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Revoke' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Revoke Weekly digest?'
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))

    await waitFor(() => {
      expect(tokens.revoke).toHaveBeenCalledWith('organization', 't-2')
    })
  })

  it('sends an unknown tab back to the personal tokens', async () => {
    renderRoute('/settings/api-tokens/elsewhere')

    expect(
      await screen.findByRole('tab', { name: 'Personal', selected: true })
    ).toBeInTheDocument()
  })
})
