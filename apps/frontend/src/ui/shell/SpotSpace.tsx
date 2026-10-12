import { Box } from '@linagora/twake-mui'
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router'

import { badgeLabel } from '@/application/badges'
import { cardApp, type FeedItem } from '@/application/feed'
import { rankSpaces, type SpaceSummary } from '@/application/spaces'
import { itemPlace } from '@/application/spaceTabs'
import { NameAvatar } from '@/ds/AppFrame'
import { AppAvatar } from '@/ds/Feed'
import { Spotlight, SpotlightEmpty, SpotlightOption } from '@/ds/Spotlight'
import { useI18n } from '@/ui/i18n/useI18n'
import { useSpaceTotals } from '@/ui/space/Badges'
import { APPS, isApp, useActorName } from '@/ui/space/FeedPanel'
import { useFeedSearchAll } from '@/ui/space/feedQueries'
import {
  DEBOUNCE_MS,
  itemText,
  MIN_LENGTH,
  RESULTS
} from '@/ui/space/FeedSearch'
import { useFetchSpace, useSpaceList } from '@/ui/spaces/queries'
import { useDebounced } from '@/ui/useDebounced'

type Option =
  | { kind: 'space'; space: SpaceSummary }
  | { kind: 'item'; space: SpaceSummary; item: FeedItem }

// SpotSpace: Ctrl+K (⌘K on a Mac) anywhere, again to close it. The spaces
// with news first, then the last opened; then what the feeds of all the
// spaces hold. Enter opens the space, or the item where it lives. In the frame
// of an app, the key goes to the app (Chat opens its own Spotchat).
export function SpotSpace(): ReactElement | null {
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    const toggle = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setIsOpen(open => !open)
      }
    }
    document.addEventListener('keydown', toggle)
    return () => {
      document.removeEventListener('keydown', toggle)
    }
  }, [])

  return isOpen ? (
    <Palette
      onClose={() => {
        setIsOpen(false)
      }}
    />
  ) : null
}

function Palette({ onClose }: { onClose: () => void }): ReactElement {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const spaces = useSpaceList().data ?? []
  const totals = useSpaceTotals(spaces)
  const typed = query.trim()
  const q = useDebounced(typed.length >= MIN_LENGTH ? typed : '', DEBOUNCE_MS)
  const results = useFeedSearchAll(
    spaces.map(space => space.id),
    q,
    RESULTS
  )
  // Results for an older query would be picked by Enter.
  const stale = q !== typed
  const found = stale ? [] : results.items
  const byId = new Map(spaces.map(space => [space.id, space]))
  const fetchSpace = useFetchSpace()
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const options: Option[] = [
    ...rankSpaces(spaces, totals, query).map(space => ({
      kind: 'space' as const,
      space
    })),
    ...found.flatMap(({ spaceId, item }) => {
      const space = byId.get(spaceId)
      return space ? [{ kind: 'item' as const, space, item }] : []
    })
  ]
  const current = Math.min(active, options.length - 1)
  const optionId = (index: number): string => `${listId}-${String(index)}`
  const searching = typed.length >= MIN_LENGTH && (stale || results.isFetching)

  // Stays up while the space loads; closed meanwhile, nothing opens.
  const open = async (option: Option): Promise<void> => {
    if (option.kind === 'space') {
      onClose()
      await navigate(`/spaces/${option.space.id}`)
      return
    }
    // The full space tells which tab a card opens in; without it, the feed.
    const space = await fetchSpace(option.space.id).catch(() => null)
    if (!mounted.current) return
    onClose()
    const place = space
      ? itemPlace(space, option.item)
      : {
          path: `/spaces/${option.space.id}/feed`,
          feedItem: option.item.id
        }
    await navigate(
      place.path,
      place.feedItem ? { state: { feedItem: place.feedItem } } : {}
    )
  }

  return (
    <Spotlight
      label={t('spotSpace.title')}
      placeholder={t('spotSpace.placeholder')}
      value={query}
      inputProps={{
        role: 'combobox',
        'aria-expanded': options.length > 0,
        'aria-controls': listId,
        'aria-activedescendant':
          options.length > 0 ? optionId(current) : undefined
      }}
      hints={[
        { keys: '↑↓', label: t('spotSpace.move') },
        { keys: '↵', label: t('spotSpace.open') },
        { keys: 'Esc', label: t('common.close') }
      ]}
      onClose={onClose}
      onChange={value => {
        setQuery(value)
        setActive(0)
      }}
      onKeyDown={event => {
        if (
          (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
          options.length > 0
        ) {
          event.preventDefault()
          const step = event.key === 'ArrowDown' ? 1 : -1
          setActive((current + step + options.length) % options.length)
        }
        const chosen = options[current]
        if (event.key === 'Enter' && chosen) {
          event.preventDefault()
          void open(chosen)
        }
      }}
    >
      <Box id={listId} role="listbox" aria-label={t('spotSpace.title')}>
        {options.map((option, index) =>
          option.kind === 'space' ? (
            <SpaceOption
              key={option.space.id}
              id={optionId(index)}
              selected={index === current}
              space={option.space}
              total={totals.get(option.space.id) ?? 0}
              onClick={() => {
                void open(option)
              }}
            />
          ) : (
            <ItemOption
              key={`${option.space.id}/${option.item.id}`}
              id={optionId(index)}
              selected={index === current}
              space={option.space}
              item={option.item}
              onClick={() => {
                void open(option)
              }}
            />
          )
        )}
      </Box>
      {searching ? (
        <SpotlightEmpty text={t('search.searching')} />
      ) : (
        options.length === 0 && (
          <SpotlightEmpty
            text={
              typed.length >= MIN_LENGTH
                ? t('search.noResults')
                : t('shell.noSpaceFound')
            }
          />
        )
      )}
    </Spotlight>
  )
}

function SpaceOption({
  id,
  selected,
  space,
  total,
  onClick
}: {
  id: string
  selected: boolean
  space: SpaceSummary
  total: number
  onClick: () => void
}): ReactElement {
  const { t } = useI18n()
  return (
    <SpotlightOption
      id={id}
      selected={selected}
      label={
        total > 0
          ? t('shell.spaceWithCount', { name: space.name, smart_count: total })
          : undefined
      }
      avatar={<NameAvatar name={space.name} color={space.color} size="s" />}
      primary={space.name}
      secondary={space.description || undefined}
      count={badgeLabel(total)}
      onClick={onClick}
    />
  )
}

function ItemOption({
  id,
  selected,
  space,
  item,
  onClick
}: {
  id: string
  selected: boolean
  space: SpaceSummary
  item: FeedItem
  onClick: () => void
}): ReactElement {
  const { t } = useI18n()
  const actor = useActorName(item.kind === 'post' ? item.author : item.actor)
  const app = item.kind === 'card' ? cardApp(item) : null
  const appName = isApp(app) ? t(`feed.apps.${app}`) : null
  const by = appName ?? actor
  return (
    <SpotlightOption
      id={id}
      selected={selected}
      avatar={
        isApp(app) ? (
          <AppAvatar icon={APPS[app].icon} app={app} label={appName ?? ''} />
        ) : (
          <NameAvatar name={actor ?? '?'} size="m" />
        )
      }
      primary={itemText(item)}
      secondary={by ? `${space.name} · ${by}` : space.name}
      count={null}
      onClick={onClick}
    />
  )
}
