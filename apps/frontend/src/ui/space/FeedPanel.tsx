import {
  Calendar,
  CheckCircle,
  CheckList,
  Comment,
  Icon,
  Copy,
  Pin,
  Mail,
  Pen,
  PersonAdd,
  Task,
  Trash,
  Upload,
  Drive,
  FileTypeFolder,
  getFileTypeIcon,
  type IconProps
} from '@linagora/twake-icons'
import { Alert, Button, IconButton, Menu } from '@linagora/twake-mui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useRef, useState, type ReactElement } from 'react'
import { Link as RouterLink, useLocation, useNavigate } from 'react-router'

import {
  cardAction,
  cardApp,
  FEED_CATEGORIES,
  fileExtension,
  firstLink,
  firstUnread,
  mentionsIn,
  splitMentions,
  toEventState,
  type Actor,
  type Approval,
  type Decision,
  FEEDBACK_ANSWER,
  type Feedback,
  type FeedCard,
  type FeedFilter,
  type FeedItem,
  type FileCounts,
  type FeedPost,
  type Poll,
  withReaction,
  withVote
} from '@/application/feed'
import { avatarUrl } from '@/application/avatar'
import { meetRoomUrl } from '@/application/meet'
import type { ResourceKind, Space } from '@/application/spaces'
import { itemPlace } from '@/application/spaceTabs'
import { NameAvatar } from '@/ds/AppFrame'
import {
  AppAvatar,
  AppBadge,
  DateTile,
  EventSummary,
  FeedAction,
  FeedAttachment,
  FeedBody,
  FeedMention,
  FeedCentered,
  FeedAnnouncement,
  FeedApproval,
  FeedComposer,
  FeedComposerMenu,
  FeedDetail,
  FeedEditForm,
  FeedFeedback,
  FeedFilterMenu,
  FeedFile,
  FeedFooter,
  FeedHeader,
  FeedLayout,
  FeedLinkPreview,
  FeedMoreButton,
  FeedNewMark,
  FeedPinned,
  FeedPoll,
  FeedRow,
  FeedTitle,
  FeedToolbar,
  FeedWithSide,
  JoinButton,
  type MentionablePerson,
  ReactionChip,
  ReactionPicker,
  VisioChip
} from '@/ds/Feed'
import {
  CalendarIcon,
  CampaignIcon,
  FolderIcon,
  OpenInNewIcon,
  PollIcon,
  ThumbsUpDownIcon
} from '@/ds/icons'
import { MembersPanel } from '@/ds/MembersPanel'
import { MenuEntry } from '@/ds/Menu'
import { LoadingRows, SetupPrompt } from '@/ds/Page'
import { useCall } from '@/ui/call/CallContext'
import { ConnectionDetailsDialog } from '@/ui/call/ConnectionDetailsDialog'
import { useI18n, type TranslationKey } from '@/ui/i18n/useI18n'
import { useServices } from '@/ui/services/Services'
import { useSession } from '@/ui/session/SessionGate'
import {
  FEED_NEWS,
  useFeed,
  useFeedCache,
  useFeedReadAt,
  usePinned
} from '@/ui/space/feedQueries'
import { ApprovalDialog } from '@/ui/space/ApprovalDialog'
import { PeopleDialog } from '@/ui/space/PeopleDialog'
import { PollDialog } from '@/ui/space/PollDialog'
import { TextPostDialog } from '@/ui/space/TextPostDialog'

const FILTERS: FeedFilter[] = ['all', ...FEED_CATEGORIES]

/** The feed item a link opens at, from the history state it carries. */
function feedItemOf(state: unknown): string | null {
  return typeof state === 'object' &&
    state !== null &&
    'feedItem' in state &&
    typeof state.feedItem === 'string'
    ? state.feedItem
    : null
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🙏']

const COMPOSER_EMOJIS = [
  '😀',
  '😂',
  '🙂',
  '😉',
  '😍',
  '🥳',
  '😎',
  '🤔',
  '😅',
  '😢',
  '😮',
  '🙏',
  '👍',
  '👏',
  '🙌',
  '💪',
  '👀',
  '🎉',
  '❤️',
  '🔥',
  '✅',
  '🚀',
  '💡',
  '☕'
]

// How many pages the feed loads back to the first new item, before it opens
// on the oldest one it has.
const MARK_PAGES = 5

export function FeedPanel({ space }: { space: Space }): ReactElement {
  const { t } = useI18n()
  const location = useLocation()
  const target = feedItemOf(location.state)
  const [filter, setFilter] = useState<FeedFilter>('all')
  // A search result shows in the whole feed, whatever the filter was.
  const [targetSeen, setTargetSeen] = useState(location.key)
  if (target && targetSeen !== location.key) {
    setTargetSeen(location.key)
    setFilter('all')
  }
  const feed = useFeed(space.id, filter)
  const readAt = useFeedReadAt(space.id)
  const { feed: feedService } = useServices()
  const queryClient = useQueryClient()
  const { mutate: markRead } = useMutation({
    mutationFn: (time: string) => feedService.markRead(space.id, time),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: FEED_NEWS })
  })
  const myId = useSession().user.id
  // Held here: the setup prompt goes away with the feed's first item.
  const [inviting, setInviting] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)

  const items = feed.data?.pages.flatMap(page => page.items).toReversed() ?? []
  // Once the filter changes, the target may never show: stop looking.
  const targetMissing =
    target !== null &&
    filter === 'all' &&
    !items.some(item => item.id === target)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed
  const pages = feed.data?.pages.length ?? 0
  const since = readAt.data ?? null
  const oldest = items[0]
  // The feed opens on the first new item: load back to it, within reason.
  const reachingMark =
    since !== null &&
    oldest !== undefined &&
    Date.parse(oldest.time) > Date.parse(since) &&
    hasNextPage &&
    !feed.isFetchNextPageError &&
    pages < MARK_PAGES
  // An older target is on a page not loaded yet. Each page that comes in
  // asks for the next: a quick answer never shows a page as fetching.
  useEffect(() => {
    if ((targetMissing || reachingMark) && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage()
    }
  }, [
    targetMissing,
    reachingMark,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    pages
  ])

  const ready = feed.isSuccess && !readAt.isPending && !reachingMark
  // Placed once per load: the items that come in later are not marked new.
  const [mark, setMark] = useState<{
    filter: FeedFilter
    id: string | null
  } | null>(null)
  if (ready && mark?.filter !== filter) {
    setMark({ filter, id: firstUnread(items, since)?.id ?? null })
  }
  const markId = ready && mark?.filter === filter ? mark.id : null

  // Seen once the person reaches the newest item. A filter leaves other
  // categories unseen.
  const [atEnd, setAtEnd] = useState(false)
  const newest = items.at(-1)?.time
  const marked = useRef<string | null>(null)
  useEffect(() => {
    if (!ready || !atEnd || filter !== 'all' || newest === undefined) return
    if (marked.current && Date.parse(marked.current) >= Date.parse(newest)) {
      return
    }
    marked.current = newest
    markRead(newest, {
      onError: () => {
        marked.current = null
      }
    })
  }, [ready, atEnd, filter, newest, markRead])

  const members = space.members.map(member => ({
    id: member.id,
    name: member.displayName ?? member.username,
    avatar: avatarUrl(member.workplaceFqdn)
  }))

  return (
    <FeedWithSide
      side={
        membersOpen && (
          <MembersPanel
            title={t('feed.members.title')}
            count={t('feed.members.count', { smart_count: members.length })}
            searchLabel={t('feed.members.search')}
            noneLabel={t('feed.members.none')}
            members={members}
            addLabel={t('feed.members.add')}
            onAdd={
              space.role === 'admin'
                ? () => {
                    setInviting(true)
                  }
                : undefined
            }
            closeLabel={t('feed.members.hide')}
            onClose={() => {
              setMembersOpen(false)
            }}
          />
        )
      }
    >
      <FeedLayout
        toolbar={
          <FeedToolbar
            panelLabel={t('feed.members.show')}
            panelOpen={membersOpen}
            onPanel={() => {
              setMembersOpen(true)
            }}
          >
            {/* Nothing to filter in a feed with nothing in it. */}
            {(!ready || items.length > 0 || filter !== 'all') && (
              <FilterMenu filter={filter} onChange={setFilter} />
            )}
          </FeedToolbar>
        }
        pinned={<Pinned space={space} myId={myId} />}
        composer={space.role !== 'viewer' && <Composer space={space} />}
        placeKey={ready ? filter : null}
        latestLabel={t('feed.latest')}
        onAtEndChange={setAtEnd}
        onNearTop={() => {
          if (ready && hasNextPage && !isFetchingNextPage) void fetchNextPage()
        }}
      >
        {!ready && !feed.isError && (
          <LoadingRows count={3} label={t('feed.loading')} />
        )}
        {feed.isError && !feed.isFetchNextPageError && (
          <Alert severity="error">{t('feed.loadFailed')}</Alert>
        )}
        {feed.hasNextPage && (
          <FeedCentered>
            <Button
              variant="text"
              disabled={feed.isFetchingNextPage}
              onClick={() => {
                void feed.fetchNextPage()
              }}
            >
              {t('feed.loadOlder')}
            </Button>
          </FeedCentered>
        )}
        {feed.isFetchNextPageError && (
          <Alert severity="error">{t('feed.loadOlderFailed')}</Alert>
        )}
        {ready &&
          items.length === 0 &&
          (filter === 'all' ? (
            <Setup
              space={space}
              onInvite={() => {
                setInviting(true)
              }}
            />
          ) : (
            <Alert severity="info">{t('feed.empty')}</Alert>
          ))}
        {ready &&
          items.map(item => (
            <Fragment key={item.id}>
              {item.id === markId && <FeedNewMark label={t('feed.new')} />}
              <Item
                // Mounted again on every visit, to take the focus again.
                key={item.id === target ? location.key : undefined}
                item={item}
                space={space}
                myId={myId}
                focused={item.id === target}
              />
            </Fragment>
          ))}
        {inviting && (
          <PeopleDialog
            space={space}
            onClose={() => {
              setInviting(false)
            }}
          />
        )}
      </FeedLayout>
    </FeedWithSide>
  )
}

// Opening one takes the feed to it, as a search result does.
function Pinned({
  space,
  myId
}: {
  space: Space
  myId: string | null
}): ReactElement | null {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const pinned = usePinned(space.id)
  const unpin = usePin(space.id)
  const name = useActorNamer()
  return (
    <>
      <FeedPinned
        label={t('feed.announcement.pinned')}
        items={(pinned.data ?? []).map(post => ({
          id: post.id,
          author: name(post.author) ?? t('feed.someone'),
          text: post.body,
          openLabel: t('feed.announcement.open', { text: post.body }),
          onOpen: () => {
            void navigate(location.pathname, {
              state: { feedItem: post.id }
            })
          },
          unpin:
            post.author.type === 'user' && post.author.id === myId
              ? {
                  label: t('feed.announcement.unpin'),
                  onClick: () => {
                    unpin.mutate({ postId: post.id, pinned: false })
                  }
                }
              : null
        }))}
      />
      {unpin.isError && (
        <Alert severity="error">{t('feed.changeFailed')}</Alert>
      )}
    </>
  )
}

function usePin(spaceId: string) {
  const { feed } = useServices()
  const { replace } = useFeedCache(spaceId)
  return useMutation({
    mutationFn: ({ postId, pinned }: { postId: string; pinned: boolean }) =>
      feed.pin(spaceId, postId, pinned),
    onSuccess: replace
  })
}

function FilterMenu({
  filter,
  onChange
}: {
  filter: FeedFilter
  onChange: (filter: FeedFilter) => void
}): ReactElement {
  const { t } = useI18n()
  return (
    <FeedFilterMenu
      label={
        filter === 'all'
          ? t('feed.filter')
          : `${t('feed.filter')}: ${t(`feed.filters.${filter}`)}`
      }
      options={FILTERS.map(option => ({
        value: option,
        label: t(`feed.filters.${option}`)
      }))}
      value={filter}
      onChange={onChange}
    />
  )
}

// The other members, by the name a mention writes.
function useMentionable(space: Space): MentionablePerson[] {
  const myId = useSession().user.id
  return space.members
    .filter(member => member.id !== myId)
    .map(member => ({
      id: member.id,
      name: member.displayName ?? member.username,
      email: member.email,
      avatar: avatarUrl(member.workplaceFqdn)
    }))
}

function Composer({ space }: { space: Space }): ReactElement {
  const { t } = useI18n()
  const { feed } = useServices()
  const { add } = useFeedCache(space.id)
  const [body, setBody] = useState('')
  const [asking, setAsking] = useState<Ask | null>(null)
  const people = useMentionable(space)
  const stopAsking = () => {
    setAsking(null)
  }
  const published = (item: FeedItem) => {
    add(item)
    setAsking(null)
  }
  const send = useMutation({
    mutationFn: (text: string) =>
      feed.post(space.id, text, mentionsIn(text, people)),
    onSuccess: item => {
      add(item)
      setBody('')
    }
  })
  return (
    <>
      {send.isError && <Alert severity="error">{t('feed.postFailed')}</Alert>}
      <FeedComposer
        label={t('feed.composer')}
        sendLabel={t('feed.send')}
        emojiLabel={t('feed.emoji')}
        emojis={COMPOSER_EMOJIS}
        people={people}
        peopleLabel={t('feed.mention')}
        value={body}
        onChange={setBody}
        onSend={() => {
          send.mutate(body.trim())
        }}
        disabled={send.isPending}
        tools={
          <FeedComposerMenu
            label={t('feed.add')}
            items={ASKS.filter(
              ask => ask.kind !== 'approval' || people.length > 0
            ).map(ask => ({
              label: t(ask.label),
              icon: ask.icon,
              onClick: () => {
                setAsking(ask.kind)
              }
            }))}
          />
        }
      />
      {(asking === 'choice' || asking === 'yes_no') && (
        <PollDialog
          spaceId={space.id}
          kind={asking}
          onClose={stopAsking}
          onPublished={published}
        />
      )}
      {asking === 'approval' && (
        <ApprovalDialog
          spaceId={space.id}
          people={people}
          onClose={stopAsking}
          onPublished={published}
        />
      )}
      {(asking === 'announcement' || asking === 'feedback') && (
        <TextPostDialog
          spaceId={space.id}
          kind={asking}
          onClose={stopAsking}
          onPublished={published}
        />
      )}
    </>
  )
}

type Ask = Poll['kind'] | 'approval' | 'announcement' | 'feedback'

const ASKS: { kind: Ask; label: TranslationKey; icon: IconProps['icon'] }[] = [
  { kind: 'choice', label: 'feed.poll.menu', icon: PollIcon },
  { kind: 'yes_no', label: 'feed.yesNo.menu', icon: ThumbsUpDownIcon },
  { kind: 'approval', label: 'feed.approval.menu', icon: CheckCircle },
  { kind: 'announcement', label: 'feed.announcement.menu', icon: CampaignIcon },
  { kind: 'feedback', label: 'feed.feedback.menu', icon: Comment }
]

function Setup({
  space,
  onInvite
}: {
  space: Space
  onInvite: () => void
}): ReactElement {
  const { t } = useI18n()
  // Each action opens the tab of an app the space has, once it is ready.
  const has = (app: 'tasks' | 'drive' | 'calendar', kind: ResourceKind) =>
    space.apps.includes(app) &&
    space.resources.some(r => r.kind === kind && r.id)
  const open = (app: 'tasks' | 'drive' | 'calendar') => ({
    component: RouterLink,
    to: `/spaces/${space.id}/${app}`,
    variant: 'ghost' as const
  })
  return (
    <SetupPrompt
      title={t('feed.setup.title', { name: space.name })}
      text={t('feed.setup.text')}
      actions={
        <>
          {space.role === 'admin' && (
            <Button startIcon={<Icon icon={PersonAdd} />} onClick={onInvite}>
              {t('feed.setup.invite')}
            </Button>
          )}
          {has('drive', 'drive') && (
            <Button {...open('drive')} startIcon={<Icon icon={Upload} />}>
              {t('feed.setup.file')}
            </Button>
          )}
          {has('tasks', 'project') && (
            <Button {...open('tasks')} startIcon={<Icon icon={CheckList} />}>
              {t('feed.setup.task')}
            </Button>
          )}
          {has('calendar', 'calendar') && (
            <Button
              {...open('calendar')}
              startIcon={<Icon icon={CalendarIcon} />}
            >
              {t('feed.setup.event')}
            </Button>
          )}
        </>
      }
    />
  )
}

function useActorNamer(): (actor: Actor | null) => string | null {
  const { t } = useI18n()
  return actor => {
    switch (actor?.type) {
      case undefined:
        return null
      case 'token':
        return actor.name
      case 'deleted_user':
        return t('feed.deletedUser')
      case 'user':
        return actor.name ?? t('feed.someone')
    }
  }
}

export function useActorName(actor: Actor | null): string | null {
  return useActorNamer()(actor)
}

// Only a person still in the space has a known instance.
export function actorAvatar(space: Space, actor: Actor | null): string | null {
  if (actor?.type !== 'user' || !actor.id) return null
  const member = space.members.find(m => m.id === actor.id)
  return avatarUrl(member?.workplaceFqdn ?? null)
}

function useTime(): (iso: string) => string {
  const { lang } = useI18n()
  return iso => {
    const date = new Date(iso)
    const today = date.toDateString() === new Date().toDateString()
    return new Intl.DateTimeFormat(lang, {
      ...(!today && { day: 'numeric', month: 'short' }),
      hour: 'numeric',
      minute: '2-digit'
    }).format(date)
  }
}

function Item({
  item,
  space,
  myId,
  focused
}: {
  item: FeedItem
  space: Space
  myId: string | null
  focused: boolean
}): ReactElement {
  return item.kind === 'post' ? (
    <Post post={item} space={space} myId={myId} focused={focused} />
  ) : (
    <Card card={item} space={space} myId={myId} focused={focused} />
  )
}

function Post({
  post,
  space,
  myId,
  focused
}: {
  post: FeedPost
  space: Space
  myId: string | null
  focused: boolean
}): ReactElement {
  const { t } = useI18n()
  const { feed } = useServices()
  const { replace, drop } = useFeedCache(space.id)
  const time = useTime()
  const author = useActorName(post.author) ?? t('feed.someone')
  const mine = post.author.type === 'user' && post.author.id === myId
  // An author made a viewer since may only take the post down.
  const canChange = mine && space.role !== 'viewer'
  const [draft, setDraft] = useState<string | null>(null)
  const people = useMentionable(space)
  const edit = useMutation({
    mutationFn: (body: string) =>
      feed.edit(space.id, post.id, body, mentionsIn(body, people)),
    onSuccess: item => {
      replace(item)
      setDraft(null)
    }
  })
  const remove = useMutation({
    mutationFn: () => feed.remove(space.id, post.id),
    onSuccess: () => {
      drop(post.id)
    }
  })
  const close = useMutation({
    mutationFn: () => feed.closePoll(space.id, post.id),
    onSuccess: replace
  })
  const pin = usePin(space.id)
  const closing =
    mine && !close.isPending
      ? () => {
          close.mutate()
        }
      : null
  const text = (
    <>
      <FeedBody>
        {splitMentions(
          post.body,
          space.members.map(member => member.displayName ?? member.username)
        ).map((part, index) =>
          index % 2 === 1 ? <FeedMention key={index}>{part}</FeedMention> : part
        )}
      </FeedBody>
      <PostLink body={post.body} />
    </>
  )

  return (
    <FeedRow
      label={author}
      avatar={
        <NameAvatar
          name={author}
          size="m"
          src={actorAvatar(space, post.author)}
        />
      }
      focused={focused}
    >
      <FeedHeader
        who={author}
        what={post.editedAt && t('feed.edited')}
        menu={
          mine && (
            <ItemMenu
              onEdit={
                !canChange || post.approval || post.feedback
                  ? null
                  : () => {
                      setDraft(post.body)
                    }
              }
              onPin={
                post.announcement &&
                (canChange || post.announcement.pinnedAt !== null)
                  ? {
                      pinned: post.announcement.pinnedAt !== null,
                      onClick: () => {
                        pin.mutate({
                          postId: post.id,
                          pinned: post.announcement?.pinnedAt === null
                        })
                      }
                    }
                  : null
              }
              onDelete={() => {
                remove.mutate()
              }}
            />
          )
        }
      />
      {draft === null ? (
        post.poll ? (
          <PollVotes
            post={post}
            poll={post.poll}
            spaceId={space.id}
            myId={myId}
            onClose={post.poll.closedAt ? null : closing}
          />
        ) : post.approval ? (
          <ApprovalDecisions
            post={post}
            approval={post.approval}
            space={space}
            myId={myId}
            onClose={post.approval.closedAt ? null : closing}
          />
        ) : post.feedback ? (
          <FeedbackAnswers
            post={post}
            feedback={post.feedback}
            space={space}
            mine={mine}
            onClose={post.feedback.closedAt ? null : closing}
          />
        ) : post.announcement ? (
          <FeedAnnouncement
            label={
              post.announcement.pinnedAt
                ? `${t('feed.announcement.label')} · ${t('feed.announcement.pinnedLabel')}`
                : t('feed.announcement.label')
            }
          >
            {text}
          </FeedAnnouncement>
        ) : (
          text
        )
      ) : (
        <FeedEditForm
          label={t('feed.edit')}
          value={draft}
          onChange={setDraft}
          onSubmit={() => {
            if (draft.trim()) edit.mutate(draft.trim())
          }}
          actions={
            <>
              <Button
                variant="text"
                onClick={() => {
                  setDraft(null)
                }}
              >
                {t('feed.cancel')}
              </Button>
              <Button type="submit" disabled={!draft.trim() || edit.isPending}>
                {t('feed.save')}
              </Button>
            </>
          }
        />
      )}
      {(edit.isError || remove.isError || close.isError || pin.isError) && (
        <Alert severity="error">{t('feed.changeFailed')}</Alert>
      )}
      <FeedFooter time={time(post.time)}>
        <Reactions item={post} spaceId={space.id} myId={myId} />
      </FeedFooter>
    </FeedRow>
  )
}

function PostLink({ body }: { body: string }): ReactElement | null {
  const { feed } = useServices()
  const link = firstLink(body)
  const { data } = useQuery({
    queryKey: ['link-preview', link],
    queryFn: () => (link ? feed.linkPreview(link) : null),
    enabled: link !== null,
    staleTime: Infinity,
    retry: false
  })
  if (!data) return null
  return (
    <FeedLinkPreview
      href={data.url}
      site={data.site}
      title={data.title}
      description={data.description}
      image={data.image}
    />
  )
}

function PollVotes({
  post,
  poll,
  spaceId,
  myId,
  onClose
}: {
  post: FeedPost
  poll: Poll
  spaceId: string
  myId: string | null
  onClose: (() => void) | null
}): ReactElement {
  const { t } = useI18n()
  const { feed } = useServices()
  const { replace } = useFeedCache(spaceId)
  // Shown at once; the live event that follows brings the stored votes.
  const vote = useMutation({
    mutationFn: (option: number | null) =>
      option === null
        ? feed.unvote(spaceId, post.id)
        : feed.vote(spaceId, post.id, option),
    onMutate: option => {
      if (myId) replace({ ...post, poll: withVote(poll, myId, option) })
      return post
    },
    // Rereads the post: it may have closed in the meantime.
    onError: (_error, _option, before) => {
      if (before) replace(before)
      feed.item(spaceId, post.id).then(replace, () => undefined)
    }
  })
  const mine =
    myId === null ? -1 : poll.options.findIndex(o => o.userIds.includes(myId))
  const total = poll.options.reduce((sum, o) => sum + o.userIds.length, 0)
  const votes = t('feed.poll.votes', { smart_count: total })
  return (
    <>
      <FeedPoll
        question={post.body}
        options={poll.options.map((option, index) => {
          const label =
            poll.kind === 'yes_no'
              ? t(index === 0 ? 'feed.yesNo.yes' : 'feed.yesNo.no')
              : option.label
          return {
            label,
            name: t('feed.poll.choice', {
              label,
              smart_count: option.userIds.length
            }),
            count: option.userIds.length,
            mine: index === mine
          }
        })}
        summary={poll.closedAt ? `${votes} · ${t('feed.poll.closed')}` : votes}
        disabled={poll.closedAt !== null || vote.isPending}
        onVote={index => {
          vote.mutate(index === mine ? null : index)
        }}
        close={onClose && { label: t('feed.poll.close'), onClick: onClose }}
      />
      {vote.isError && (
        <Alert severity="error">{t('feed.poll.voteFailed')}</Alert>
      )}
    </>
  )
}

function ApprovalDecisions({
  post,
  approval,
  space,
  myId,
  onClose
}: {
  post: FeedPost
  approval: Approval
  space: Space
  myId: string | null
  onClose: (() => void) | null
}): ReactElement {
  const { t } = useI18n()
  const { feed } = useServices()
  const { replace } = useFeedCache(space.id)
  const reread = () => feed.item(space.id, post.id).then(replace)
  // A decision is final: the post is reread from the server, failed or not.
  const decide = useMutation({
    mutationFn: ({
      decision,
      comment
    }: {
      decision: Decision
      comment: string
    }) => feed.decide(space.id, post.id, decision, comment),
    onSettled: () => reread().catch(() => undefined)
  })
  const mine = approval.approvers.find(approver => approver.id === myId)
  const approved = approval.approvers.filter(
    approver => approver.decision === 'approved'
  ).length
  const summary = t('feed.approval.summary', {
    approved,
    total: approval.approvers.length
  })
  return (
    <>
      <FeedApproval
        question={post.body}
        state={{
          tone: approval.state,
          label: t(`feed.approval.${approval.state}`)
        }}
        approvers={approval.approvers.map(approver => {
          const member = space.members.find(m => m.id === approver.id)
          return {
            id: approver.id,
            name: approver.name ?? t('feed.someone'),
            avatar: member ? avatarUrl(member.workplaceFqdn) : null,
            tone: approver.decision ?? 'pending',
            status: t(
              approver.decision
                ? `feed.approval.${approver.decision}`
                : 'feed.approval.waiting'
            ),
            comment: approver.comment
          }
        })}
        decide={
          mine?.decision === null && approval.closedAt === null
            ? {
                commentLabel: t('feed.approval.comment'),
                approveLabel: t('feed.approval.approve'),
                rejectLabel: t('feed.approval.reject'),
                disabled: decide.isPending,
                onDecide: (decision, comment) => {
                  decide.mutate({ decision, comment: comment.trim() })
                }
              }
            : null
        }
        summary={
          approval.closedAt
            ? `${summary} · ${t('feed.approval.closed')}`
            : summary
        }
        close={onClose && { label: t('feed.approval.close'), onClick: onClose }}
      />
      {decide.isError && (
        <Alert severity="error">{t('feed.approval.decideFailed')}</Alert>
      )}
    </>
  )
}

function FeedbackAnswers({
  post,
  feedback,
  space,
  mine,
  onClose
}: {
  post: FeedPost
  feedback: Feedback
  space: Space
  mine: boolean
  onClose: (() => void) | null
}): ReactElement {
  const { t } = useI18n()
  const { feed } = useServices()
  const { replace } = useFeedCache(space.id)
  const answer = useMutation({
    mutationFn: (text: string) => feed.answer(space.id, post.id, text),
    // Saved: a failed reread is no failed answer, the live change follows.
    onSuccess: () =>
      feed
        .item(space.id, post.id)
        .then(replace)
        .catch(() => undefined)
  })
  const summary = t('feed.feedback.count', { smart_count: feedback.count })
  return (
    <>
      <FeedFeedback
        question={post.body}
        answers={
          feedback.answers?.map(item => {
            const member = space.members.find(m => m.id === item.userId)
            return {
              id: item.userId,
              name: item.name ?? t('feed.someone'),
              avatar: member ? avatarUrl(member.workplaceFqdn) : null,
              text: item.text
            }
          }) ?? null
        }
        emptyLabel={t('feed.feedback.none')}
        mine={
          feedback.mine === null
            ? null
            : { label: t('feed.feedback.answer'), text: feedback.mine }
        }
        answer={
          mine || feedback.closedAt !== null
            ? null
            : {
                label: t('feed.feedback.answer'),
                sendLabel: t('feed.send'),
                editLabel: t('feed.edit'),
                maxLength: FEEDBACK_ANSWER.max,
                disabled: answer.isPending,
                onAnswer: text => {
                  answer.mutate(text)
                }
              }
        }
        summary={
          feedback.closedAt
            ? `${summary} · ${t('feed.feedback.closed')}`
            : summary
        }
        close={onClose && { label: t('feed.feedback.close'), onClick: onClose }}
      />
      {answer.isError && (
        <Alert severity="error">{t('feed.feedback.answerFailed')}</Alert>
      )}
    </>
  )
}

function ItemMenu({
  onEdit,
  onPin = null,
  onDelete
}: {
  onEdit: (() => void) | null
  /** On an announcement, unpins it or pins it again. */
  onPin?: { pinned: boolean; onClick: () => void } | null
  onDelete: () => void
}): ReactElement {
  const { t } = useI18n()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const close = () => {
    setAnchor(null)
  }
  return (
    <>
      <FeedMoreButton label={t('feed.more')} onClick={setAnchor} />
      <Menu anchorEl={anchor} open={anchor !== null} onClose={close}>
        {onEdit && (
          <MenuEntry
            icon={<Icon icon={Pen} />}
            onClick={() => {
              close()
              onEdit()
            }}
          >
            {t('feed.edit')}
          </MenuEntry>
        )}
        {onPin && (
          <MenuEntry
            icon={<Icon icon={Pin} />}
            onClick={() => {
              close()
              onPin.onClick()
            }}
          >
            {t(
              onPin.pinned ? 'feed.announcement.unpin' : 'feed.announcement.pin'
            )}
          </MenuEntry>
        )}
        <MenuEntry
          danger
          icon={<Icon icon={Trash} />}
          onClick={() => {
            close()
            onDelete()
          }}
        >
          {t('feed.delete')}
        </MenuEntry>
      </Menu>
    </>
  )
}

function Reactions({
  item,
  spaceId,
  myId
}: {
  item: FeedItem
  spaceId: string
  myId: string | null
}): ReactElement {
  const { t } = useI18n()
  const { feed } = useServices()
  const { replace } = useFeedCache(spaceId)
  // Shown at once; the live event that follows brings the stored reactions.
  const toggle = useMutation({
    mutationFn: ({ key, mine }: { key: string; mine: boolean }) =>
      mine
        ? feed.unreact(spaceId, item.id, key)
        : feed.react(spaceId, item.id, key),
    onMutate: ({ key, mine }) => {
      if (myId) replace(withReaction(item, key, myId, !mine))
      return item
    },
    onError: (_error, _vars, before) => {
      if (before) replace(before)
    }
  })
  const isMine = (key: string) =>
    myId !== null &&
    (item.reactions.find(r => r.key === key)?.userIds.includes(myId) ?? false)
  const react = (key: string) => {
    if (!toggle.isPending) toggle.mutate({ key, mine: isMine(key) })
  }

  return (
    <>
      {item.reactions.map(reaction => (
        <ReactionChip
          key={reaction.key}
          emoji={reaction.key}
          count={reaction.userIds.length}
          mine={isMine(reaction.key)}
          label={t('feed.reaction', {
            emoji: reaction.key,
            count: reaction.userIds.length
          })}
          onClick={() => {
            react(reaction.key)
          }}
        />
      ))}
      <ReactionPicker
        label={t('feed.react')}
        emojis={QUICK_REACTIONS}
        onPick={react}
        quiet={item.reactions.length === 0}
      />
    </>
  )
}

export const APPS = {
  tasks: { icon: Task },
  mail: { icon: Mail },
  calendar: { icon: Calendar },
  drive: { icon: Drive }
} satisfies Record<string, { icon: IconProps['icon'] }>

type App = keyof typeof APPS

export function isApp(app: string | null): app is App {
  return app !== null && Object.hasOwn(APPS, app)
}

const OPEN: Record<string, TranslationKey> = {
  tasks: 'feed.open.tasks',
  mail: 'feed.open.mail',
  calendar: 'feed.open.calendar',
  drive: 'feed.open.drive',
  chat: 'feed.open.chat'
}

const VERBS: Record<string, TranslationKey> = {
  'tasks.created': 'feed.verbs.tasks.created',
  'tasks.updated': 'feed.verbs.tasks.updated',
  'tasks.assigned': 'feed.verbs.tasks.assigned',
  'tasks.unassigned': 'feed.verbs.tasks.unassigned',
  'tasks.moved': 'feed.verbs.tasks.moved',
  'tasks.completed': 'feed.verbs.tasks.completed',
  'tasks.reopened': 'feed.verbs.tasks.reopened',
  'tasks.deleted': 'feed.verbs.tasks.deleted',
  'tasks.restored': 'feed.verbs.tasks.restored',
  'mail.received': 'feed.verbs.mail.received',
  'mail.sent': 'feed.verbs.mail.sent',
  'calendar.created': 'feed.verbs.calendar.created',
  'calendar.updated': 'feed.verbs.calendar.updated',
  'calendar.rescheduled': 'feed.verbs.calendar.rescheduled',
  'calendar.accepted': 'feed.verbs.calendar.accepted',
  'calendar.declined': 'feed.verbs.calendar.declined',
  'calendar.proposed': 'feed.verbs.calendar.proposed',
  'drive.created': 'feed.verbs.drive.created',
  'drive.updated': 'feed.verbs.drive.updated'
}

function Card({
  card,
  space,
  myId,
  focused
}: {
  card: FeedCard
  space: Space
  myId: string | null
  focused: boolean
}): ReactElement {
  const { t } = useI18n()
  const time = useTime()
  const changes = useFileChanges()
  const app = cardApp(card)
  const actor = useActorName(card.actor)
  const verb = VERBS[`${app ?? ''}.${cardAction(card) ?? ''}`]
  const appName = isApp(app) ? t(`feed.apps.${app}`) : null
  // A card reaches the space's feed only when its container is one of the
  // space's resources, so the container's tab shows it.
  const place = itemPlace(space, card)
  const open = OPEN[place.tab]
  const label = [actor ?? appName, card.object.title].filter(Boolean).join(': ')
  const face = (
    <NameAvatar
      name={actor ?? '?'}
      size="m"
      src={actorAvatar(space, card.actor)}
    />
  )

  return (
    <FeedRow
      label={label}
      focused={focused}
      avatar={
        // The person who acted, with the app as a badge; an app or an
        // integration has its own.
        !isApp(app) ? (
          face
        ) : card.actor?.type === 'user' && card.actor.name ? (
          <AppBadge icon={APPS[app].icon} app={app} label={appName ?? ''}>
            {face}
          </AppBadge>
        ) : (
          <AppAvatar icon={APPS[app].icon} app={app} label={appName ?? ''} />
        )
      }
    >
      <FeedHeader
        who={actor ?? appName}
        what={
          (card.files && changes(card.files)) ??
          (verb ? t(verb) : t('feed.verbs.other'))
        }
      />
      {app === 'calendar' ? (
        <EventDetails card={card} />
      ) : card.files ? (
        <FeedFile
          icon={FileTypeFolder}
          name={card.object.title}
          detail={
            card.files.samples.length > 0 && (
              <FeedDetail>{card.files.samples.join(', ')}</FeedDetail>
            )
          }
        />
      ) : app === 'drive' ? (
        <FileDetails card={card} />
      ) : (
        <Summary card={card} />
      )}
      <FeedFooter time={time(card.time)}>
        <Reactions item={card} spaceId={space.id} myId={myId} />
        {open && (
          <FeedAction
            icon={app === 'drive' ? FolderIcon : OpenInNewIcon}
            component={RouterLink}
            to={place.path}
          >
            {t(open)}
          </FeedAction>
        )}
      </FeedFooter>
    </FeedRow>
  )
}

function MeetingActions({ card }: { card: FeedCard }): ReactElement | null {
  const { t } = useI18n()
  const { meetUrl } = useServices()
  const { join } = useCall()
  const [sharing, setSharing] = useState(false)
  const room = toEventState(card.state)?.room
  const link = room && meetUrl ? meetRoomUrl(room, meetUrl) : null
  if (!link) return null
  return (
    <>
      <JoinButton
        label={t('feed.event.join')}
        name={t('call.joinAction')}
        onClick={() => {
          join({ url: link })
        }}
      />
      <IconButton
        aria-label={t('call.details')}
        onClick={() => {
          setSharing(true)
        }}
      >
        <Icon icon={Copy} />
      </IconButton>
      {sharing && (
        <ConnectionDetailsDialog
          link={link}
          onClose={() => {
            setSharing(false)
          }}
        />
      )}
    </>
  )
}

function Summary({ card }: { card: FeedCard }): ReactElement {
  return (
    <>
      <FeedTitle>{card.object.title}</FeedTitle>
      {card.preview && (
        <FeedDetail oneLine={cardApp(card) === 'mail'}>
          {card.preview}
        </FeedDetail>
      )}
    </>
  )
}

// A file just added has the card of the mockup's added files; one updated
// has the line of its shared files.
function FileDetails({ card }: { card: FeedCard }): ReactElement {
  const { t } = useI18n()
  const extension = fileExtension(card.object.title)
  const icon = getFileTypeIcon(card.object.title)
  return (
    <>
      {cardAction(card) === 'created' ? (
        <FeedAttachment
          icon={icon}
          name={card.object.title}
          detail={extension ?? t('feed.fromDrive')}
        />
      ) : (
        <FeedFile
          icon={icon}
          name={card.object.title}
          detail={
            <FeedDetail>
              {[extension, t('feed.fromDrive')].filter(Boolean).join(' · ')}
            </FeedDetail>
          }
        />
      )}
      {card.preview && <FeedDetail>{card.preview}</FeedDetail>}
    </>
  )
}

const FILE_CHANGES = ['created', 'updated', 'deleted'] as const

// "added 1,200 files and updated 3 files", null when every count is 0.
function useFileChanges(): (files: FileCounts) => string | null {
  const { t, lang } = useI18n()
  return files => {
    const parts = FILE_CHANGES.filter(change => files[change] > 0).map(change =>
      t(`feed.files.${change}`, {
        smart_count: files[change],
        count: new Intl.NumberFormat(lang).format(files[change])
      })
    )
    return parts.length > 0
      ? new Intl.ListFormat(lang, { type: 'conjunction' }).format(parts)
      : null
  }
}

// "1 hour", "30 minutes", "1 hour 30 minutes", in the language of the page.
function formatDuration(minutes: number, lang: string): string {
  const unit = (value: number, name: 'day' | 'hour' | 'minute') =>
    new Intl.NumberFormat(lang, {
      style: 'unit',
      unit: name,
      unitDisplay: 'long'
    }).format(value)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  return [
    days > 0 && unit(days, 'day'),
    hours > 0 && unit(hours, 'hour'),
    rest > 0 && unit(rest, 'minute')
  ]
    .filter(Boolean)
    .join(' ')
}

function EventDetails({ card }: { card: FeedCard }): ReactElement {
  const { t, lang } = useI18n()
  const event = toEventState(card.state)
  if (!event) return <Summary card={card} />

  // All-day times are plain dates: read them as such, not as UTC midnight.
  const date = (value: string) =>
    new Date(event.allDay ? `${value}T00:00:00` : value)
  const day = (value: string) =>
    new Intl.DateTimeFormat(lang, {
      weekday: 'short',
      day: 'numeric',
      month: 'short'
    }).format(date(value))
  const hour = (value: string) =>
    new Intl.DateTimeFormat(lang, {
      hour: 'numeric',
      minute: '2-digit'
    }).format(date(value))
  const when = (range: { start: string; end: string }) =>
    event.allDay
      ? `${day(range.start)} · ${t('feed.event.allDay')}`
      : `${day(range.start)} · ${hour(range.start)} – ${hour(range.end)}`
  const start = date(event.start)
  const minutes = Math.round(
    (date(event.end).getTime() - start.getTime()) / 60_000
  )
  // The tile gives the day: the line gives the hour and how long it lasts.
  const time = event.allDay
    ? t('feed.event.allDay')
    : [hour(event.start), formatDuration(minutes, lang)]
        .filter(Boolean)
        .join(' · ')

  return (
    <EventSummary
      aside={<MeetingActions card={card} />}
      tile={
        <DateTile
          month={new Intl.DateTimeFormat(lang, { month: 'short' }).format(
            start
          )}
          day={String(start.getDate())}
        />
      }
    >
      <FeedTitle large>{card.object.title}</FeedTitle>
      <FeedDetail large>
        {time}
        {event.location && ` · ${event.location}`}
        {event.room && <VisioChip label={t('feed.event.visio')} />}
      </FeedDetail>
      {event.previous && (
        <FeedDetail>
          {t('feed.event.movedFrom', { time: when(event.previous) })}
        </FeedDetail>
      )}
      {event.proposed && (
        <FeedDetail>
          {t('feed.event.proposed', {
            time: when(event.proposed),
            by: event.proposed.by
          })}
        </FeedDetail>
      )}
      {event.rsvp && Object.values(event.rsvp).some(count => count > 0) && (
        <FeedDetail>
          {t('feed.event.rsvp', {
            accepted: event.rsvp.accepted,
            tentative: event.rsvp.tentative,
            declined: event.rsvp.declined,
            pending: event.rsvp.pending
          })}
        </FeedDetail>
      )}
    </EventSummary>
  )
}
