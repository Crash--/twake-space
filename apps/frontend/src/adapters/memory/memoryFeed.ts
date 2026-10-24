import {
  approvalState,
  searchedText,
  shows,
  withVote,
  type FeedItem,
  type FeedPost,
  type FeedService
} from '@/application/feed'
import type { Refusal, SpaceRole } from '@/application/spaces'

const refuse = (status: number, code: string) =>
  Promise.reject(
    Object.assign(new Error(code), { status, code } satisfies Refusal)
  )

const newestFirst = (a: FeedItem, b: FeedItem) => b.time.localeCompare(a.time)

// Writes behave like the backend's: viewers cannot post, only the author edits
// or deletes a post or closes its poll, a closed poll takes no vote, and an
// approver decides once. Nothing arrives live.
export function memoryFeed(
  seed: Record<string, FeedItem[]>,
  {
    me,
    roles,
    names = {},
    readAt = {},
    mentions = {},
    pageSize = 10
  }: {
    me: { id: string; name: string | null }
    roles: Record<string, SpaceRole>
    /** By user id: the name an approver shows with. */
    names?: Record<string, string>
    /** By space id: the time of the newest item seen. */
    readAt?: Record<string, string>
    /** By space id: the unread mentions. */
    mentions?: Record<string, number>
    pageSize?: number
  }
): FeedService {
  const spaces = new Map(
    Object.entries(seed).map(([id, items]) => [id, structuredClone(items)])
  )
  const reads = new Map(Object.entries(readAt))
  const itemsOf = (spaceId: string) => {
    const items = spaces.get(spaceId) ?? []
    spaces.set(spaceId, items)
    return items
  }
  const find = (spaceId: string, itemId: string) =>
    itemsOf(spaceId).find(item => item.id === itemId)
  const myPost = (spaceId: string, postId: string) => {
    const post = find(spaceId, postId)
    if (post?.kind !== 'post') return refuse(404, 'not_found')
    if (post.author.type !== 'user' || post.author.id !== me.id) {
      return refuse(403, 'not_author')
    }
    return Promise.resolve(post)
  }
  const openPoll = (spaceId: string, postId: string) => {
    const post = find(spaceId, postId)
    if (post?.kind !== 'post' || !post.poll) return refuse(404, 'not_found')
    if (post.poll.closedAt) return refuse(409, 'poll_closed')
    return Promise.resolve(post)
  }

  return {
    list: (spaceId, { category, before, q, limit = pageSize }) => {
      const needle = q?.toLowerCase()
      const items = itemsOf(spaceId)
        .filter(item => shows(item, category ?? 'all'))
        .filter(
          item =>
            !needle ||
            searchedText(item).some(text => text.toLowerCase().includes(needle))
        )
        .sort(newestFirst)
      const start = before
        ? items.findIndex(i => i.id === before) + 1 || items.length
        : 0
      const page = items.slice(start, start + limit)
      return Promise.resolve({
        items: structuredClone(page),
        next: start + limit < items.length ? (page.at(-1)?.id ?? null) : null
      })
    },
    readAt: spaceId => Promise.resolve(reads.get(spaceId) ?? null),
    markRead: (spaceId, readAt) => {
      const stored = reads.get(spaceId)
      if (!stored || Date.parse(readAt) > Date.parse(stored)) {
        reads.set(spaceId, readAt)
      }
      return Promise.resolve()
    },
    news: () => {
      const ids = new Set([...spaces.keys(), ...Object.keys(mentions)])
      return Promise.resolve(
        [...ids]
          .map(spaceId => {
            const read = reads.get(spaceId)
            const items = read
              ? itemsOf(spaceId).filter(
                  item => Date.parse(item.time) > Date.parse(read)
                ).length
              : 0
            return { spaceId, items, mentions: mentions[spaceId] ?? 0 }
          })
          .filter(news => news.items > 0 || news.mentions > 0)
      )
    },
    item: (spaceId, itemId) => {
      const item = find(spaceId, itemId)
      return item
        ? Promise.resolve(structuredClone(item))
        : refuse(404, 'not_found')
    },
    post: (spaceId, body, _mentions, ask) => {
      if (roles[spaceId] === 'viewer') return refuse(403, 'cannot_post')
      const time = new Date().toISOString()
      const post: FeedPost = {
        id: crypto.randomUUID(),
        kind: 'post',
        category: 'messages',
        time,
        updatedAt: time,
        reactions: [],
        author: { type: 'user', ...me },
        body,
        editedAt: null,
        poll:
          ask && 'poll' in ask
            ? 'options' in ask.poll
              ? {
                  kind: 'choice',
                  options: ask.poll.options.map(label => ({
                    label,
                    userIds: []
                  })),
                  closedAt: null
                }
              : {
                  kind: 'yes_no',
                  options: [
                    { label: 'yes', userIds: [] },
                    { label: 'no', userIds: [] }
                  ],
                  closedAt: null
                }
            : null,
        approval:
          ask && 'approval' in ask
            ? {
                state: 'pending',
                approvers: ask.approval.approvers.map(id => ({
                  id,
                  name: names[id] ?? null,
                  decision: null,
                  comment: null,
                  decidedAt: null
                })),
                closedAt: null
              }
            : null
      }
      itemsOf(spaceId).push(post)
      return Promise.resolve(structuredClone(post))
    },
    edit: async (spaceId, postId, body) => {
      const post = await myPost(spaceId, postId)
      if (post.approval) return refuse(409, 'cannot_edit_approval')
      post.body = body
      post.editedAt = post.updatedAt = new Date().toISOString()
      return structuredClone(post)
    },
    remove: async (spaceId, postId) => {
      await myPost(spaceId, postId)
      spaces.set(
        spaceId,
        itemsOf(spaceId).filter(item => item.id !== postId)
      )
    },
    vote: async (spaceId, postId, option) => {
      const post = await openPoll(spaceId, postId)
      if (!post.poll?.options[option]) return refuse(400, 'invalid_request')
      post.poll = withVote(post.poll, me.id, option)
    },
    unvote: async (spaceId, postId) => {
      const post = await openPoll(spaceId, postId)
      if (post.poll) post.poll = withVote(post.poll, me.id, null)
    },
    closePoll: async (spaceId, postId) => {
      const post = await myPost(spaceId, postId)
      const closing = post.poll ?? post.approval
      if (!closing) return refuse(404, 'not_found')
      closing.closedAt ??= new Date().toISOString()
      return structuredClone(post)
    },
    decide: (spaceId, postId, decision, comment) => {
      const post = find(spaceId, postId)
      const approval = post?.kind === 'post' ? post.approval : null
      if (!approval) return refuse(404, 'not_found')
      if (approval.closedAt) return refuse(409, 'poll_closed')
      const approver = approval.approvers.find(a => a.id === me.id)
      if (!approver) return refuse(403, 'not_approver')
      if (approver.decision) return refuse(409, 'already_decided')
      Object.assign(approver, {
        decision,
        comment: comment.trim() || null,
        decidedAt: new Date().toISOString()
      })
      approval.state = approvalState(approval.approvers)
      return Promise.resolve()
    },
    react: (spaceId, itemId, key) => {
      const item = find(spaceId, itemId)
      if (!item) return refuse(404, 'not_found')
      const reaction = item.reactions.find(r => r.key === key)
      if (!reaction) item.reactions.push({ key, userIds: [me.id] })
      else if (!reaction.userIds.includes(me.id)) reaction.userIds.push(me.id)
      return Promise.resolve()
    },
    unreact: (spaceId, itemId, key) => {
      const item = find(spaceId, itemId)
      if (!item) return refuse(404, 'not_found')
      item.reactions = item.reactions
        .map(r =>
          r.key === key
            ? { key, userIds: r.userIds.filter(id => id !== me.id) }
            : r
        )
        .filter(r => r.userIds.length > 0)
      return Promise.resolve()
    },
    linkPreview: () => Promise.resolve(null)
  }
}
