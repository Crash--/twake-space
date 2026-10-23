import { Icon, Plus } from '@linagora/twake-icons'
import { Alert, Button, Chip, Typography } from '@linagora/twake-mui'
import { useId, useState, type ReactElement } from 'react'
import { Link as RouterLink } from 'react-router'

import { avatarUrl } from '@/application/avatar'
import { pinnedAndRecent, type SpaceSummary } from '@/application/spaces'
import spaceTile from '@/assets/space.svg'
import { NameAvatar } from '@/ds/AppFrame'
import {
  CardGrid,
  CreateCard,
  MemberAvatars,
  NewsCard,
  SpaceCard
} from '@/ds/Card'
import { AddIcon } from '@/ds/icons'
import { LoadingRows, Page, TileEmpty } from '@/ds/Page'
import { CreateSpaceDialog } from '@/ui/home/CreateSpaceDialog'
import { Greeting } from '@/ui/home/Greeting'
import { useFeedNews } from '@/ui/space/feedQueries'
import { SpaceMenu } from '@/ui/space/SpaceMenu'
import { useI18n } from '@/ui/i18n/useI18n'
import { useSpaceList } from '@/ui/spaces/queries'
import { useDocumentTitle } from '@/ui/useDocumentTitle'

export function HomeScreen(): ReactElement {
  const { t } = useI18n()
  const spaces = useSpaceList()
  const [creating, setCreating] = useState(false)
  const { pinned } = pinnedAndRecent(spaces.data ?? [])
  const pinnedId = useId()
  const allId = useId()
  useDocumentTitle(null)
  const startCreating = (): void => {
    setCreating(true)
  }

  return (
    <Page>
      <Greeting title={t('app.name')} />
      {spaces.isPending && (
        <LoadingRows count={4} label={t('spaces.loading')} />
      )}
      {spaces.isError && (
        <Alert severity="error">{t('spaces.loadFailed')}</Alert>
      )}
      {spaces.data?.length === 0 && (
        <TileEmpty
          icon={<img src={spaceTile} alt="" />}
          title={t('spaces.none')}
          text={t('spaces.noneHint')}
          componentsProps={{ text: { variant: 'body2' } }}
        >
          <div className="u-mt-1-half">
            <Button
              variant="contained"
              startIcon={<Icon icon={Plus} />}
              onClick={startCreating}
            >
              {t('spaces.create')}
            </Button>
          </div>
          <Chip
            className="u-mt-2-half"
            label={
              <Typography variant="caption" color="textSecondary">
                {t('spaces.channelsHint')}
              </Typography>
            }
          />
        </TileEmpty>
      )}
      {spaces.data && spaces.data.length > 0 && (
        <SpaceNewsSection spaces={spaces.data} />
      )}
      {pinned.length > 0 && (
        <section aria-labelledby={pinnedId} className="u-mb-2">
          <Typography
            id={pinnedId}
            variant="subtitle1"
            component="h2"
            className="u-mb-1"
          >
            {t('spaces.pinned')}
          </Typography>
          <CardGrid maxColumns={4}>
            {pinned.map(space => (
              <SpaceItem key={space.id} space={space} pinned />
            ))}
          </CardGrid>
        </section>
      )}
      {spaces.data && spaces.data.length > 0 && (
        <section aria-labelledby={allId}>
          <Typography
            id={allId}
            variant="subtitle1"
            component="h2"
            className="u-mb-1"
          >
            {t('spaces.all')}
          </Typography>
          <CardGrid>
            <CreateCard
              icon={<Icon icon={AddIcon} size={24} />}
              title={t('spaces.createCard')}
              text={t('spaces.createHint')}
              onClick={startCreating}
            />
            {spaces.data.map(space => (
              <SpaceItem key={space.id} space={space} />
            ))}
          </CardGrid>
        </section>
      )}
      {creating && (
        <CreateSpaceDialog
          onClose={() => {
            setCreating(false)
          }}
        />
      )}
    </Page>
  )
}

// A failure leaves the section out: the spaces below still lead to every feed.
function SpaceNewsSection({
  spaces
}: {
  spaces: SpaceSummary[]
}): ReactElement | null {
  const { t } = useI18n()
  const news = useFeedNews()
  const id = useId()
  if (!news.data) return null
  const byId = new Map(spaces.map(space => [space.id, space]))
  const rows = news.data
    .flatMap(entry => {
      const space = byId.get(entry.spaceId)
      return space ? [{ ...entry, space }] : []
    })
    .sort((a, b) => b.mentions - a.mentions || b.items - a.items)
  return (
    <section aria-labelledby={id} className="u-mb-2">
      <Typography id={id} variant="subtitle1" component="h2" className="u-mb-1">
        {t('home.news')}
      </Typography>
      {rows.length === 0 ? (
        <Typography variant="body2" color="textSecondary">
          {t('home.noNews')}
        </Typography>
      ) : (
        <CardGrid maxColumns={4}>
          {rows.map(({ space, items, mentions }) => (
            <NewsCard
              key={space.id}
              avatar={
                <NameAvatar name={space.name} color={space.color} size="s" />
              }
              link={
                <RouterLink to={`/spaces/${space.id}`}>{space.name}</RouterLink>
              }
              news={[
                mentions > 0 && t('home.mentions', { smart_count: mentions }),
                items > 0 && t('home.newItems', { smart_count: items })
              ]
                .filter(Boolean)
                .join(', ')}
            />
          ))}
        </CardGrid>
      )}
    </section>
  )
}

function SpaceItem({
  space,
  pinned = false
}: {
  space: SpaceSummary
  pinned?: boolean
}): ReactElement {
  return (
    <SpaceCard
      pinned={pinned}
      avatar={<NameAvatar name={space.name} color={space.color} size="s" />}
      link={<RouterLink to={`/spaces/${space.id}`}>{space.name}</RouterLink>}
      description={space.description}
      members={
        space.members.length > 0 && (
          <MemberAvatars
            members={space.members.map(member => ({
              id: member.id,
              name: member.displayName ?? member.username,
              src: avatarUrl(member.workplaceFqdn)
            }))}
          />
        )
      }
      menu={<SpaceMenu space={space} />}
    />
  )
}
