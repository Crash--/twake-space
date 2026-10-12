import {
  Autocomplete,
  Box,
  ListItemAvatar,
  ListItemText,
  SearchBar
} from '@linagora/twake-mui'
import { useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router'

import { cardApp, searchedText, type FeedItem } from '@/application/feed'
import type { Space } from '@/application/spaces'
import { itemPlace } from '@/application/spaceTabs'
import { NameAvatar } from '@/ds/AppFrame'
import { AppAvatar } from '@/ds/Feed'
import { PageSearch } from '@/ds/Page'
import { useI18n } from '@/ui/i18n/useI18n'
import { useFeedSearch } from '@/ui/space/feedQueries'
import { actorAvatar, APPS, isApp, useActorName } from '@/ui/space/FeedPanel'
import { useDebounced } from '@/ui/useDebounced'

export const MIN_LENGTH = 2
export const RESULTS = 8
export const DEBOUNCE_MS = 300

export const itemText = (item: FeedItem) => searchedText(item)[0] ?? ''

/** Searches the space's feed as one types; a result opens where it lives. */
export function FeedSearch({ space }: { space: Space }): ReactElement {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const [open, setOpen] = useState(false)
  const typed = input.trim()
  const q = useDebounced(typed.length >= MIN_LENGTH ? typed : '', DEBOUNCE_MS)
  const results = useFeedSearch(space.id, q, RESULTS)
  // Results for an older query would be picked by Enter.
  const stale = q === '' || q !== typed
  const options = stale ? [] : (results.data?.items ?? [])

  return (
    <PageSearch>
      <Autocomplete
        open={open && typed.length >= MIN_LENGTH}
        onOpen={() => {
          setOpen(true)
        }}
        onClose={() => {
          setOpen(false)
        }}
        options={options}
        // The backend matched them already.
        filterOptions={items => items}
        getOptionLabel={itemText}
        value={null}
        inputValue={input}
        onInputChange={(_event, value, reason) => {
          if (reason === 'input') setInput(value)
        }}
        onChange={(_event, item) => {
          if (!item) return
          setInput('')
          const place = itemPlace(space, item)
          void navigate(
            place.path,
            place.feedItem ? { state: { feedItem: place.feedItem } } : {}
          )
        }}
        autoHighlight
        blurOnSelect
        loading={stale || results.isFetching}
        loadingText={t('search.searching')}
        noOptionsText={t('search.noResults')}
        // Two items can share a title.
        getOptionKey={item => item.id}
        renderOption={({ key, ...props }, item) => (
          <Box component="li" key={key} {...props}>
            <Result space={space} item={item} />
          </Box>
        )}
        renderInput={params => (
          <SearchBar
            ref={params.slotProps.input.ref}
            elevation={0}
            placeholder={t('search.placeholder')}
            value={input}
            onClear={() => {
              setInput('')
            }}
            componentsProps={{
              inputBase: { inputProps: params.slotProps.htmlInput }
            }}
          />
        )}
      />
    </PageSearch>
  )
}

function Result({
  space,
  item
}: {
  space: Space
  item: FeedItem
}): ReactElement {
  const { t } = useI18n()
  const who = item.kind === 'post' ? item.author : item.actor
  const actor = useActorName(who)
  const avatar = actorAvatar(space, who)
  const app = item.kind === 'card' ? cardApp(item) : null
  const appName = isApp(app) ? t(`feed.apps.${app}`) : null
  const preview = item.kind === 'card' ? item.preview : null

  return (
    <>
      <ListItemAvatar>
        {item.kind === 'card' &&
        item.actor?.type === 'user' &&
        item.actor.name ? (
          <NameAvatar name={item.actor.name} size="m" src={avatar} />
        ) : isApp(app) ? (
          <AppAvatar icon={APPS[app].icon} app={app} label={appName ?? ''} />
        ) : (
          <NameAvatar name={actor ?? '?'} size="m" src={avatar} />
        )}
      </ListItemAvatar>
      <ListItemText
        primary={itemText(item)}
        secondary={preview ?? actor ?? appName}
        slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
      />
    </>
  )
}
