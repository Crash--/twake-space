import {
  Alert,
  Autocomplete,
  Button,
  Chip,
  ListItemText,
  MenuItem,
  Stack,
  TextField
} from '@linagora/twake-mui'
import { useId, useState, type ReactElement } from 'react'

import { SPACE_ROLES, type SpaceRole } from '@/application/spaces'
import {
  agentBrief,
  allowedLifetimes,
  accessLevels,
  curlExample,
  scopesOf,
  tokenResources,
  type AccessLevel,
  type CreatedToken,
  type TokenAccess,
  type TokenLifetime,
  type TokenOwner
} from '@/application/tokens'
import {
  AccessRow,
  AccessTable,
  ChoiceCard,
  FieldGroup,
  FormColumns,
  Labelled
} from '@/ds/Panel'
import { useI18n } from '@/ui/i18n/useI18n'
import { useServices } from '@/ui/services/Services'
import { useSpaceList } from '@/ui/spaces/queries'
import { ReferenceLink, Snippet } from '@/ui/tokens/ApiUsage'
import {
  useCreateToken,
  useOrganizationSpaces,
  useTokenPolicy
} from '@/ui/tokens/queries'
import { TokenDialog, TokenError } from '@/ui/tokens/TokenDialogs'

const LEVELS: AccessLevel[] = ['none', 'read', 'write']
const NEVER = 'never'
const DAY_MS = 24 * 60 * 60 * 1000

export function CreateTokenDialog({
  owner,
  onClose,
  onCreated
}: {
  owner: TokenOwner
  onClose: () => void
  onCreated: (created: CreatedToken) => void
}): ReactElement {
  const { t, lang } = useI18n()
  const accessId = useId()
  const spacesId = useId()
  const create = useCreateToken(owner)
  const organization = owner === 'organization'
  // An organization token may cover spaces its admin is not a member of.
  const mySpaces = useSpaceList()
  const organizationSpaces = useOrganizationSpaces(organization)
  const spaceQuery = organization ? organizationSpaces : mySpaces
  const spaces = spaceQuery.data ?? []
  const policy = useTokenPolicy()
  const lifetimes = policy.data ? allowedLifetimes(policy.data) : []
  const [now] = useState(Date.now)
  const [name, setName] = useState('')
  const [access, setAccess] = useState<TokenAccess>({
    spaces: 'read',
    feed: 'none',
    members: 'none',
    notifications: 'none',
    tokens: 'none'
  })
  const scopes = scopesOf(access)
  const [allSpaces, setAllSpaces] = useState(true)
  const [picked, setPicked] = useState<string[]>([])
  const [role, setRole] = useState<SpaceRole>('viewer')
  const [chosen, setChosen] = useState<TokenLifetime | null>(30)
  // The policy loads after the first render and may refuse the default.
  const lifetime = lifetimes.includes(chosen) ? chosen : lifetimes.at(0)
  const trimmed = name.trim()
  const ready =
    trimmed !== '' &&
    scopes.length > 0 &&
    lifetime !== undefined &&
    (allSpaces || picked.length > 0)
  // Unmounting mid-request drops mutate's onSuccess, and with it the only
  // chance to show the secret.
  const close = () => {
    if (!create.isPending) onClose()
  }

  return (
    <TokenDialog
      size="large"
      title={t(`apiTokens.createTitle.${owner}`)}
      onClose={close}
      onSubmit={() => {
        if (lifetime === undefined) return
        create.mutate(
          {
            name: trimmed,
            scopes,
            spaces: allSpaces ? 'all' : picked,
            ...(organization && { role }),
            expiresInDays: lifetime
          },
          { onSuccess: onCreated }
        )
      }}
      actions={
        <>
          <Button variant="text" onClick={close} disabled={create.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={!ready || create.isPending}
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <TokenError error={create.error ?? policy.error ?? spaceQuery.error} />
      <FormColumns
        start={
          <>
            <TextField
              // A dialog moves focus to its first field (WAI-ARIA dialog pattern).
              // eslint-disable-next-line jsx-a11y-x/no-autofocus
              autoFocus
              required
              label={t('apiTokens.name')}
              helperText={t('apiTokens.nameHint')}
              value={name}
              onChange={event => {
                setName(event.target.value)
              }}
              slotProps={{ htmlInput: { maxLength: 100 } }}
            />
            <FieldGroup
              id={accessId}
              label={t('apiTokens.scopes')}
              hint={scopes.length === 0 && t('apiTokens.noScopes')}
            >
              <AccessTable
                labelledBy={accessId}
                levels={LEVELS.map(level => t(`apiTokens.access.${level}`))}
              >
                {tokenResources(owner).map(resource => (
                  <AccessRow
                    key={resource}
                    id={`${accessId}-${resource}`}
                    title={t(`apiTokens.resource.${resource}`)}
                    text={t(`apiTokens.resourceHint.${resource}`)}
                    options={LEVELS.map(level => ({
                      value: level,
                      label: t(`apiTokens.access.${level}`),
                      available: accessLevels(resource).includes(level)
                    }))}
                    value={access[resource]}
                    onChange={level => {
                      setAccess({ ...access, [resource]: level as AccessLevel })
                    }}
                    unavailableLabel={t('apiTokens.notAvailable')}
                  />
                ))}
              </AccessTable>
            </FieldGroup>
          </>
        }
        end={
          <>
            <FieldGroup id={spacesId} label={t('apiTokens.spaces')}>
              <Stack role="radiogroup" aria-labelledby={spacesId} spacing={1}>
                <ChoiceCard
                  title={t('apiTokens.allSpaces')}
                  text={t(
                    organization
                      ? 'apiTokens.futureSpaces'
                      : 'apiTokens.allSpacesOf.personal'
                  )}
                  checked={allSpaces}
                  onSelect={() => {
                    setAllSpaces(true)
                  }}
                />
                <ChoiceCard
                  title={t('apiTokens.pickSpaces')}
                  checked={!allSpaces}
                  onSelect={() => {
                    setAllSpaces(false)
                  }}
                >
                  {!allSpaces && (
                    <Autocomplete
                      multiple
                      disableCloseOnSelect
                      size="small"
                      loading={spaceQuery.isPending}
                      options={spaces}
                      getOptionLabel={space => space.name}
                      value={spaces.filter(space => picked.includes(space.id))}
                      onChange={(_event, value) => {
                        setPicked(value.map(space => space.id))
                      }}
                      renderValue={(value, getItemProps) =>
                        value.map((space, index) => (
                          <Chip
                            {...getItemProps({ index })}
                            key={space.id}
                            size="small"
                            label={space.name}
                          />
                        ))
                      }
                      renderInput={params => (
                        <TextField
                          {...params}
                          label={t('apiTokens.pickPlaceholder')}
                          helperText={
                            picked.length === 0 && t('apiTokens.noSpaces')
                          }
                        />
                      )}
                    />
                  )}
                </ChoiceCard>
              </Stack>
            </FieldGroup>
            {organization && (
              <Stack spacing={1}>
                <TextField
                  select
                  label={t('apiTokens.role')}
                  value={role}
                  onChange={event => {
                    setRole(event.target.value as SpaceRole)
                  }}
                  helperText={t('apiTokens.roleHelp')}
                  slotProps={{
                    select: {
                      renderValue: value => t(`roles.${value as SpaceRole}`)
                    }
                  }}
                >
                  {SPACE_ROLES.map(item => (
                    <MenuItem key={item} value={item}>
                      <ListItemText
                        primary={t(`roles.${item}`)}
                        secondary={t(`apiTokens.roleHint.${item}`)}
                        slotProps={{ secondary: { noWrap: false } }}
                      />
                    </MenuItem>
                  ))}
                </TextField>
                {role === 'admin' && (
                  <Alert severity="warning">
                    {t('apiTokens.adminWarning')}
                  </Alert>
                )}
              </Stack>
            )}
            <TextField
              select
              label={t('apiTokens.lifetime')}
              value={lifetime === undefined ? '' : String(lifetime ?? NEVER)}
              onChange={event => {
                const { value } = event.target
                setChosen(
                  value === NEVER ? null : (Number(value) as TokenLifetime)
                )
              }}
              helperText={
                lifetime === undefined
                  ? policy.data && t('apiTokens.noLifetime')
                  : lifetime === null
                    ? t('apiTokens.noExpiryHint')
                    : t('apiTokens.expiresOn', {
                        date: new Intl.DateTimeFormat(lang, {
                          dateStyle: 'long'
                        }).format(new Date(now + lifetime * DAY_MS))
                      })
              }
            >
              {lifetimes.map(days => (
                <MenuItem key={days ?? NEVER} value={String(days ?? NEVER)}>
                  {days === null
                    ? t('apiTokens.never')
                    : t('apiTokens.days', { smart_count: days })}
                </MenuItem>
              ))}
            </TextField>
          </>
        }
      />
    </TokenDialog>
  )
}

export function TokenSecretDialog({
  created,
  onClose
}: {
  created: CreatedToken
  onClose: () => void
}): ReactElement {
  const { t } = useI18n()
  const { apiUrl } = useServices()
  return (
    <TokenDialog
      size="medium"
      title={t('apiTokens.secretTitle', { name: created.name })}
      onClose={onClose}
      persistent
      onSubmit={onClose}
      actions={
        <Button type="submit" variant="contained">
          {t('apiTokens.done')}
        </Button>
      }
    >
      <Alert severity="warning">{t('apiTokens.secretHint')}</Alert>
      <Snippet
        label={t('apiTokens.secret')}
        value={created.token}
        copyText={t('apiTokens.copyButton')}
      />
      <Labelled label={t('apiTokens.usage.forPeople')}>
        <Snippet
          label={t('apiTokens.usage.forPeople')}
          value={curlExample(apiUrl, created.token)}
        />
      </Labelled>
      <Labelled label={t('apiTokens.usage.forAgents')}>
        <Snippet
          label={t('apiTokens.usage.forAgents')}
          value={agentBrief(apiUrl, created)}
          maxHeight={200}
        />
      </Labelled>
      <ReferenceLink />
    </TokenDialog>
  )
}
