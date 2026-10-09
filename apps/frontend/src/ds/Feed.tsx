import { Down, Icon, Send, type IconProps } from '@linagora/twake-icons'
import {
  Avatar,
  Box,
  Button,
  Checkbox,
  IconButton,
  InputBase,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography
} from '@linagora/twake-mui'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'

import {
  AddReactionIcon,
  ChevronDownIcon,
  EmojiIcon,
  MoreVertIcon,
  SidePanelIcon,
  Videocam
} from '@/ds/icons'
import type { SpaceTokens } from '@/ds/theme'

// How close to the newest item still counts as being there, and how close to
// the oldest one asks for older items.
const AT_END = 32
const NEAR_TOP = 200
// The height of the fade at the top of the list.
const FADE = 32
// The width of a bubble, the avatar beside it left out.
const BUBBLE_WIDTH = 600

const RevealContext = createContext<(row: HTMLElement) => void>(() => undefined)

// The feed reads like a chat: the oldest item on top, the newest right above
// the composer. `placeKey` is null while the list loads; on each new one, the
// list opens on the `FeedNewMark`, or else on the newest item. It follows the
// newest items while the person is there, and otherwise keeps the rows in view
// still while rows come in above or below.
export function FeedLayout({
  toolbar,
  children,
  composer,
  placeKey,
  latestLabel,
  onAtEndChange,
  onNearTop
}: {
  toolbar: ReactNode
  children: ReactNode
  composer: ReactNode
  placeKey: string | null
  latestLabel: string
  onAtEndChange?: (atEnd: boolean) => void
  onNearTop?: () => void
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const [behind, setBehind] = useState(false)
  // The first row in view, and where it sits on the screen: when the list
  // grows above or shrinks, the rows hold still under the eye.
  const anchor = useRef<{ row: Element; top: number } | null>(null)
  // A scroll this layout made itself is not the person scrolling.
  const ownScroll = useRef(false)

  const reportAtEnd = useEffectEvent((value: boolean) => {
    onAtEndChange?.(value)
  })
  // Read from the ref: on the render that places the list, `behind` is still
  // the one from before the placement.
  useEffect(() => {
    if (placeKey !== null) reportAtEnd(atEnd.current)
  }, [placeKey, behind])

  const scrollTo = (top: number) => {
    const list = scroller.current
    if (!list) return
    const before = list.scrollTop
    list.scrollTop = top
    if (list.scrollTop !== before) ownScroll.current = true
  }
  const measure = (keepAnchor = false) => {
    const list = scroller.current
    if (!list) return
    atEnd.current =
      list.scrollHeight - list.scrollTop - list.clientHeight <= AT_END
    setBehind(!atEnd.current)
    if (keepAnchor) return
    const top = list.getBoundingClientRect().top
    const row = Array.from(list.querySelectorAll('article')).find(
      item => item.getBoundingClientRect().bottom > top
    )
    anchor.current = row ? { row, top: row.getBoundingClientRect().top } : null
  }
  const keepPlace = useEffectEvent((rowsChanged: boolean) => {
    const list = scroller.current
    if (!list) return
    const kept = anchor.current
    if (atEnd.current) {
      scrollTo(list.scrollHeight)
    } else if (
      kept?.row.isConnected &&
      // At the very top, the list resizing pushes the first rows down like a
      // page, instead of hiding them.
      (rowsChanged || list.scrollTop > 0)
    ) {
      scrollTo(list.scrollTop + kept.row.getBoundingClientRect().top - kept.top)
    }
    measure()
  })
  // At once, not smoothly: the list resizing on the way would stop a smooth
  // scroll short of the end.
  const toEnd = () => {
    atEnd.current = true
    scrollTo(scroller.current?.scrollHeight ?? 0)
    measure()
  }
  const reveal = useCallback((row: HTMLElement) => {
    const list = scroller.current
    if (!list) return
    const top = list.getBoundingClientRect().top
    const box = row.getBoundingClientRect()
    scrollTo(
      list.scrollTop + box.top - top - (list.clientHeight - box.height) / 2
    )
    measure()
  }, [])

  useLayoutEffect(() => {
    const list = scroller.current
    const rows = content.current
    if (!list || !rows || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      keepPlace(entries.some(entry => entry.target === rows))
    })
    observer.observe(list)
    observer.observe(rows)
    return () => {
      observer.disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    const list = scroller.current
    if (placeKey === null || !list) return
    const mark = list.querySelector('[data-feed-new]')
    scrollTo(
      mark
        ? list.scrollTop +
            mark.getBoundingClientRect().top -
            list.getBoundingClientRect().top
        : list.scrollHeight
    )
    measure()
  }, [placeKey])

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        minHeight: 0
      }}
    >
      <Box
        sx={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          flex: '1 1 auto',
          minHeight: 0
        }}
      >
        {/* Over the list, so that no row of its own sits above the first card. */}
        <Box
          sx={{
            position: 'absolute',
            top: 8,
            right: { xs: 0, md: 24 },
            zIndex: 1
          }}
        >
          {toolbar}
        </Box>
        <Box
          ref={scroller}
          sx={{
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            // The cards fade out under the top edge instead of being cut.
            maskImage: `linear-gradient(to bottom, transparent 0, #000 ${String(FADE)}px)`,
            // The layout keeps its rows in place itself, the same everywhere.
            overflowAnchor: 'none'
          }}
          onScroll={event => {
            const own = ownScroll.current
            ownScroll.current = false
            // The event of a scroll the layout made lands a frame late, when
            // the rows may have moved again: the anchor it set still holds.
            measure(own)
            if (event.currentTarget.scrollTop < NEAR_TOP) onNearTop?.()
          }}
        >
          <Box
            ref={content}
            sx={{
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              pt: 5,
              pb: 2
            }}
          >
            <RevealContext value={reveal}>{children}</RevealContext>
          </Box>
        </Box>
        {behind && (
          <Button
            size="small"
            startIcon={<Icon icon={Down} size={16} />}
            onClick={toEnd}
            sx={{
              position: 'absolute',
              bottom: 16,
              left: '50%',
              transform: 'translateX(-50%)',
              borderRadius: 100,
              boxShadow: 2
            }}
          >
            {latestLabel}
          </Button>
        )}
      </Box>
      {/* Sending a message brings the person back to the newest items. */}
      <Box onSubmitCapture={toEnd}>{composer}</Box>
    </Box>
  )
}

/** The feed, and a panel beside it that comes and goes. */
export function FeedWithSide({
  side,
  children
}: {
  side: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <Box
      sx={{
        position: 'relative',
        display: 'flex',
        flex: '1 1 auto',
        minHeight: 0
      }}
    >
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          flex: '1 1 auto',
          minWidth: 0
        }}
      >
        {children}
      </Box>
      {side}
    </Box>
  )
}

/** The button of the members panel, beside the filter. Gone while the panel
 * is open, which has its own close button; takes the focus back on close. */
export function FeedToolbar({
  panelLabel,
  panelOpen,
  onPanel,
  children
}: {
  panelLabel: string
  panelOpen: boolean
  onPanel: () => void
  children: ReactNode
}): ReactElement {
  const button = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(panelOpen)
  useEffect(() => {
    if (wasOpen.current && !panelOpen) button.current?.focus()
    wasOpen.current = panelOpen
  }, [panelOpen])
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      {!panelOpen && (
        <IconButton
          ref={button}
          size="small"
          aria-label={panelLabel}
          onClick={onPanel}
          sx={{
            width: 34,
            height: 32,
            borderRadius: 100,
            color: 'text.primary'
          }}
        >
          <Icon icon={SidePanelIcon} size={20} />
        </IconButton>
      )}
      {children}
    </Box>
  )
}

/** Above the first item the person has not seen, where the feed opens. */
export function FeedNewMark({ label }: { label: string }): ReactElement {
  return (
    <Box
      data-feed-new
      role="separator"
      aria-label={label}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        color: 'error.main',
        '&::before, &::after': {
          content: '""',
          flex: '1 1 auto',
          borderTop: 1,
          borderColor: 'currentColor'
        }
      }}
    >
      <Typography variant="caption" sx={{ fontWeight: 600 }} aria-hidden>
        {label}
      </Typography>
    </Box>
  )
}

// A `focused` row takes the focus once, and the feed brings it into view. It
// stands out while it keeps the focus. The bubble's tail points at the avatar.
export function FeedRow({
  avatar,
  label,
  focused = false,
  children
}: {
  avatar: ReactNode
  label: string
  focused?: boolean
  children: ReactNode
}): ReactElement {
  const ref = useRef<HTMLElement>(null)
  const reveal = useContext(RevealContext)
  useEffect(() => {
    const row = ref.current
    if (!focused || !row) return
    row.focus({ preventScroll: true })
    reveal(row)
  }, [focused, reveal])

  return (
    <Box
      ref={ref}
      component="article"
      aria-label={label}
      tabIndex={focused ? -1 : undefined}
      sx={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 1,
        maxWidth: BUBBLE_WIDTH + 44,
        outline: 'none',
        '&:focus > :last-child': { bgcolor: 'action.selected' },
        // A reaction button with no reaction beside it appears on hover or
        // focus, and stays on a screen with no hover.
        '& [data-quiet]': { opacity: 0 },
        '&:hover [data-quiet], &:focus-within [data-quiet]': { opacity: 1 },
        '@media (hover: none)': { '& [data-quiet]': { opacity: 1 } }
      }}
    >
      <Box sx={{ flex: '0 0 36px', display: 'flex' }}>{avatar}</Box>
      <Box
        sx={{
          position: 'relative',
          flex: '1 1 auto',
          minWidth: 0,
          bgcolor: 'background.default',
          borderRadius: '16px',
          px: 2,
          py: 1,
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        <BubbleTail />
        {children}
      </Box>
    </Box>
  )
}

// The mockup's bubble tail, mirrored: its point is at the bottom left.
function BubbleTail(): ReactElement {
  return (
    <Box
      component="svg"
      aria-hidden
      viewBox="0 0 14.676 18.3449"
      sx={{
        position: 'absolute',
        left: -7,
        bottom: 0,
        width: 14.676,
        height: 18.3449,
        transform: 'scaleX(-1)',
        fill: 'inherit',
        color: 'background.default',
        pointerEvents: 'none'
      }}
    >
      <path
        fill="currentColor"
        d="M14.676 18.3449C8.56098 12.23 7.33798 7.33798 7.33798 0L0 14.676C4.40279 18.1003 11.007 18.3449 14.676 18.3449Z"
      />
    </Box>
  )
}

/** A 36px round tile with an app's icon, for cards an app sends. */
export function AppAvatar({
  icon,
  label,
  app
}: {
  icon: IconProps['icon']
  label: string
  app: keyof SpaceTokens['appColors']
}): ReactElement {
  return (
    <Avatar
      size="m"
      aria-label={label}
      title={label}
      sx={theme => ({
        bgcolor: theme.space.appColors[app],
        color: 'common.white'
      })}
    >
      <Icon icon={icon} size={18} />
    </Avatar>
  )
}

/** Who acted, in blue, and what they did; the menu sits at the end. */
export function FeedHeader({
  who,
  what,
  menu
}: {
  who: ReactNode
  what: ReactNode
  menu?: ReactNode
}): ReactElement {
  return (
    <Box
      sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 16 }}
    >
      <Typography
        variant="caption"
        sx={theme => ({
          // The mockup's blue on both pages: the dark scheme greys secondary.
          color: theme.palette.secondary.main,
          ...theme.applyStyles('dark', { color: theme.palette.primary.light }),
          fontWeight: 500,
          lineHeight: '16px',
          letterSpacing: 0.5
        })}
        noWrap
      >
        {who}
      </Typography>
      <Typography
        variant="caption"
        color="textSecondary"
        sx={{
          fontSize: 11,
          fontWeight: 500,
          lineHeight: '16px',
          letterSpacing: 0.5,
          flex: '1 1 auto',
          minWidth: 0
        }}
        noWrap
      >
        {what}
      </Typography>
      {menu}
    </Box>
  )
}

/**
 * The three dots at the end of a header: a 16px glyph in a 32px target, with
 * a negative margin so the header stays 16px tall.
 */
export function FeedMoreButton({
  label,
  onClick
}: {
  label: string
  onClick: (anchor: HTMLElement) => void
}): ReactElement {
  return (
    <IconButton
      aria-label={label}
      aria-haspopup="menu"
      onClick={event => {
        onClick(event.currentTarget)
      }}
      sx={{ width: 32, height: 32, m: '-8px', color: 'text.secondary' }}
    >
      <Icon icon={MoreVertIcon} size={16} />
    </IconButton>
  )
}

export function FeedTitle({
  children,
  large = false
}: {
  children: ReactNode
  large?: boolean
}): ReactElement {
  return (
    <Typography
      variant="body2"
      sx={{
        fontWeight: 600,
        fontSize: large ? 16 : undefined,
        lineHeight: large ? '24px' : '20px',
        letterSpacing: 0.25,
        overflowWrap: 'anywhere'
      }}
    >
      {children}
    </Typography>
  )
}

/** A file the card is about: its type icon, its name over two lines, a detail. */
export function FeedFile({
  icon,
  name,
  detail
}: {
  icon: IconProps['icon']
  name: string
  detail: ReactNode
}): ReactElement {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
      <Box sx={{ flex: '0 0 48px', display: 'flex' }}>
        <Icon icon={icon} size={48} />
      </Box>
      <Box sx={{ minWidth: 0, pt: 0.5 }}>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 600,
            lineHeight: '20px',
            letterSpacing: 0.25,
            maxHeight: 40,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflowWrap: 'anywhere'
          }}
        >
          {name}
        </Typography>
        {detail}
      </Box>
    </Box>
  )
}

/** A file as a card: the icon of its type over its name. */
export function FeedAttachment({
  icon,
  name,
  detail
}: {
  icon: IconProps['icon']
  name: string
  detail: ReactNode
}): ReactElement {
  return (
    <Box
      sx={{
        width: 183,
        maxWidth: '100%',
        mt: 0.5,
        border: 1,
        borderColor: 'border.disabled',
        borderRadius: '10px',
        overflow: 'hidden'
      }}
    >
      <Box
        sx={{
          height: 94,
          pt: '17px',
          display: 'flex',
          justifyContent: 'center',
          bgcolor: 'background.default',
          borderBottom: 1,
          borderColor: 'border.disabled'
        }}
      >
        <Icon icon={icon} size={60} />
      </Box>
      <Box sx={{ p: 1.5, bgcolor: 'background.paper' }}>
        <Typography
          variant="body2"
          noWrap
          title={name}
          sx={{ fontWeight: 500, lineHeight: '18.4px', letterSpacing: 0.25 }}
        >
          {name}
        </Typography>
        <Typography
          sx={theme => ({
            fontSize: 11,
            lineHeight: '16px',
            color: theme.space.fileMeta.light,
            ...theme.applyStyles('dark', { color: theme.space.fileMeta.dark })
          })}
        >
          {detail}
        </Typography>
      </Box>
    </Box>
  )
}

export function FeedDetail({
  children,
  large = false,
  oneLine = false
}: {
  children: ReactNode
  /** The line under an event's title: 14px, regular. */
  large?: boolean
  /** Cut with an ellipsis at the end of the first line, like a mail's text. */
  oneLine?: boolean
}): ReactElement {
  return (
    <Typography
      variant="caption"
      color="textSecondary"
      sx={{
        fontSize: large ? 14 : undefined,
        fontWeight: large ? 400 : 500,
        lineHeight: large ? '20px' : '16px',
        letterSpacing: large ? undefined : 0.4,
        pt: '5px'
      }}
      noWrap={oneLine}
    >
      {children}
    </Typography>
  )
}

export function FeedBody({ children }: { children: ReactNode }): ReactElement {
  return (
    <Typography
      sx={{
        fontSize: 15,
        lineHeight: '20px',
        letterSpacing: -0.15,
        py: '2px',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere'
      }}
    >
      {children}
    </Typography>
  )
}

/** Reactions and actions on the left, the time on the right. */
export function FeedFooter({
  children,
  time
}: {
  children: ReactNode
  time: ReactNode
}): ReactElement {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        mt: 0.5
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 0.5,
          minWidth: 0
        }}
      >
        {children}
      </Box>
      <Typography
        variant="caption"
        color="textSecondary"
        sx={{
          flex: '0 0 auto',
          fontWeight: 500,
          lineHeight: '16px',
          letterSpacing: 0.4,
          pl: 1,
          py: 0.5,
          alignSelf: 'flex-end'
        }}
      >
        {time}
      </Typography>
    </Box>
  )
}

export function FeedAction({
  icon,
  children,
  ...action
}: {
  icon?: IconProps['icon']
  children: ReactNode
} & (
  { component: React.ElementType; to: string } | { onClick: () => void }
)): ReactElement {
  return (
    <Button
      size="small"
      variant="text"
      startIcon={icon && <Icon icon={icon} size={16} />}
      sx={{
        borderRadius: 100,
        px: 1,
        py: 0.5,
        minHeight: 0,
        fontSize: 11,
        fontWeight: 500,
        lineHeight: '16px',
        letterSpacing: 0.5,
        '& .MuiButton-startIcon': { mr: 0.5, ml: 0 }
      }}
      {...action}
    >
      {children}
    </Button>
  )
}

export function ReactionChip({
  emoji,
  count,
  mine,
  label,
  onClick
}: {
  emoji: string
  count: number
  mine: boolean
  label: string
  onClick: () => void
}): ReactElement {
  return (
    <Box
      component="button"
      type="button"
      aria-pressed={mine}
      aria-label={label}
      onClick={onClick}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        p: '4px 6px 4px 4px',
        border: 1,
        borderColor: mine ? 'primary.main' : 'divider',
        bgcolor: mine ? 'action.selected' : 'transparent',
        borderRadius: '16px',
        cursor: 'pointer',
        font: 'inherit'
      }}
    >
      <Box
        component="span"
        aria-hidden
        sx={{
          fontSize: 16,
          lineHeight: '20px',
          width: 20,
          textAlign: 'center'
        }}
      >
        {emoji}
      </Box>
      <Typography
        component="span"
        sx={theme => ({
          fontSize: 14,
          fontWeight: 500,
          lineHeight: '20px',
          letterSpacing: 0.25,
          color: theme.space.reactionCount.light,
          ...theme.applyStyles('dark', {
            color: theme.space.reactionCount.dark
          })
        })}
      >
        {count}
      </Typography>
    </Box>
  )
}

export function ReactionPicker({
  label,
  emojis,
  onPick,
  quiet = false
}: {
  label: string
  emojis: string[]
  onPick: (emoji: string) => void
  /** Shown on hover or focus only, while the item has no reaction. */
  quiet?: boolean
}): ReactElement {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <Tooltip title={label}>
        <IconButton
          size="small"
          aria-label={label}
          aria-haspopup="menu"
          data-quiet={quiet ? '' : undefined}
          onClick={event => {
            setAnchor(event.currentTarget)
          }}
          sx={{
            transition: 'opacity 0.15s',
            // After the actions, so that its place at rest does not push them.
            order: quiet ? 1 : 0,
            width: 28,
            height: 28,
            p: 0.5,
            border: 1,
            borderColor: 'divider',
            color: 'text.secondary'
          }}
        >
          <Icon icon={AddReactionIcon} size={20} />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null)
        }}
        sx={{ '& .MuiList-root': { display: 'flex' } }}
      >
        {emojis.map(emoji => (
          <MenuItem
            key={emoji}
            aria-label={emoji}
            onClick={() => {
              setAnchor(null)
              onPick(emoji)
            }}
            sx={{ fontSize: 20 }}
          >
            {emoji}
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}

export function FeedCentered({
  children
}: {
  children: ReactNode
}): ReactElement {
  return <Box sx={{ alignSelf: 'center' }}>{children}</Box>
}

export function FeedEditForm({
  label,
  value,
  onChange,
  onSubmit,
  actions
}: {
  label: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  actions: ReactNode
}): ReactElement {
  return (
    <Box
      component="form"
      onSubmit={event => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <TextField
        multiline
        fullWidth
        size="small"
        label={label}
        value={value}
        onChange={event => {
          onChange(event.target.value)
        }}
        slotProps={{ htmlInput: { maxLength: 4000 } }}
      />
      <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 1 }}>
        {actions}
      </Box>
    </Box>
  )
}

export function EventSummary({
  tile,
  children,
  aside
}: {
  tile: ReactNode
  children: ReactNode
  /** At the end of the row, centered: the meeting's buttons. */
  aside?: ReactNode
}): ReactElement {
  return (
    <Box
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center' }}
    >
      <Box
        sx={{
          display: 'flex',
          gap: 1.5,
          alignItems: 'flex-start',
          flex: '1 1 260px',
          minWidth: 0
        }}
      >
        {tile}
        <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {children}
        </Box>
      </Box>
      {aside}
    </Box>
  )
}

/** The video call of an event, as a small chip. */
export function VisioChip({ label }: { label: string }): ReactElement {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        px: 0.5,
        py: '3px',
        fontSize: 12,
        lineHeight: '16px',
        color: 'text.primary'
      }}
    >
      <Icon icon={Videocam} size={16} />
      {label}
    </Box>
  )
}

/** The call's button, in the calendar's orange. */
export function JoinButton({
  label,
  name,
  onClick
}: {
  label: string
  name: string
  onClick: () => void
}): ReactElement {
  return (
    <Button
      aria-label={name}
      startIcon={<Icon icon={Videocam} size={24} />}
      onClick={onClick}
      sx={theme => ({
        borderRadius: '4px',
        px: 1.5,
        py: 1,
        bgcolor: theme.space.appColors.calendar,
        color: 'common.white',
        fontSize: 14,
        fontWeight: 500,
        lineHeight: '20px',
        letterSpacing: 0.1,
        '&:hover': {
          bgcolor: theme.space.appColors.calendar,
          filter: 'brightness(0.92)'
        }
      })}
    >
      {label}
    </Button>
  )
}

/** A calendar day: the month on an orange band above the date. */
export function DateTile({
  month,
  day
}: {
  month: string
  day: string
}): ReactElement {
  return (
    <Box
      aria-hidden
      sx={{
        flex: '0 0 32px',
        width: 32,
        borderRadius: '6px',
        overflow: 'hidden',
        textAlign: 'center',
        bgcolor: 'background.paper',
        boxShadow: 1
      }}
    >
      <Box
        sx={theme => ({
          bgcolor: theme.space.appColors.calendar,
          color: 'common.white',
          fontSize: 7,
          lineHeight: '10px',
          textTransform: 'uppercase'
        })}
      >
        {month}
      </Box>
      <Box sx={{ fontSize: 15, lineHeight: '22px' }}>{day}</Box>
    </Box>
  )
}

export function FeedComposer({
  label,
  sendLabel,
  emojiLabel,
  emojis,
  value,
  onChange,
  onSend,
  disabled
}: {
  label: string
  sendLabel: string
  emojiLabel: string
  emojis: string[]
  value: string
  onChange: (value: string) => void
  onSend: () => void
  disabled: boolean
}): ReactElement {
  const empty = value.trim() === ''
  const field = useRef<HTMLTextAreaElement>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  // The emoji goes where the caret is, and the caret stays after it.
  const insert = (emoji: string) => {
    const input = field.current
    const start = input?.selectionStart ?? value.length
    const end = input?.selectionEnd ?? value.length
    onChange(value.slice(0, start) + emoji + value.slice(end))
    const caret = start + emoji.length
    requestAnimationFrame(() => {
      input?.focus()
      input?.setSelectionRange(caret, caret)
    })
  }
  return (
    <Box
      component="form"
      onSubmit={event => {
        event.preventDefault()
        if (!empty && !disabled) onSend()
      }}
      sx={{ display: 'flex', alignItems: 'flex-end', gap: 1, pt: 1 }}
    >
      <InputBase
        multiline
        maxRows={6}
        placeholder={label}
        inputRef={field}
        inputProps={{ 'aria-label': label, maxLength: 4000 }}
        value={value}
        onChange={event => {
          onChange(event.target.value)
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.closest('form')?.requestSubmit()
          }
        }}
        endAdornment={
          <IconButton
            size="small"
            aria-label={emojiLabel}
            aria-haspopup="menu"
            onClick={event => {
              setAnchor(event.currentTarget)
            }}
            sx={{
              alignSelf: 'flex-end',
              width: 28,
              height: 28,
              p: 0,
              // Taller than a line, the button must not stretch the field.
              m: '-2px 0 -2px 8px',
              color: 'text.secondary'
            }}
          >
            <Icon icon={EmojiIcon} size={20} />
          </IconButton>
        }
        sx={{
          flex: '1 1 auto',
          minHeight: 44,
          border: 1,
          borderColor: 'border.main',
          borderRadius: '22px',
          pl: 2,
          pr: '4px',
          py: '10px',
          fontSize: 17,
          lineHeight: '24px',
          letterSpacing: -0.15,
          '& textarea::placeholder': { color: 'text.secondary', opacity: 1 }
        }}
      />
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null)
        }}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        sx={{
          '& .MuiList-root': {
            display: 'grid',
            gridTemplateColumns: 'repeat(6, 44px)'
          },
          '& .MuiMenuItem-root': { minWidth: 0, px: 0 }
        }}
      >
        {emojis.map(emoji => (
          <MenuItem
            key={emoji}
            aria-label={emoji}
            onClick={() => {
              setAnchor(null)
              insert(emoji)
            }}
            sx={{ fontSize: 20, justifyContent: 'center' }}
          >
            {emoji}
          </MenuItem>
        ))}
      </Menu>
      <IconButton
        type="submit"
        aria-label={sendLabel}
        disabled={empty || disabled}
        sx={{
          width: 44,
          height: 44,
          bgcolor: 'primary.main',
          color: 'common.white',
          '&:hover': { bgcolor: 'primary.dark' },
          '&.Mui-disabled': { bgcolor: 'primary.light', color: 'common.white' }
        }}
      >
        <Icon icon={Send} />
      </IconButton>
    </Box>
  )
}

/** The filter as a chip over the list; one option holds at a time. */
export function FeedFilterMenu<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}): ReactElement {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <Button
        variant="text"
        size="small"
        endIcon={<Icon icon={ChevronDownIcon} size={16} />}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={event => {
          setAnchor(event.currentTarget)
        }}
        sx={{
          height: 32,
          px: 1.5,
          borderRadius: '8px',
          bgcolor: 'background.default',
          color: 'text.primary',
          fontSize: 12,
          fontWeight: 500,
          letterSpacing: 0.5,
          '&:hover': { bgcolor: 'action.hover' }
        }}
      >
        {label}
      </Button>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null)
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: theme => ({
              width: 256,
              borderRadius: '16px',
              boxShadow: theme.space.menuShadow
            })
          }
        }}
      >
        {options.map(option => (
          <MenuItem
            key={option.value}
            role="menuitemradio"
            aria-checked={option.value === value}
            selected={option.value === value}
            onClick={() => {
              onChange(option.value)
              setAnchor(null)
            }}
            sx={{ minHeight: 40, pl: 2, gap: 2, fontSize: 16 }}
          >
            <Checkbox
              size="small"
              checked={option.value === value}
              tabIndex={-1}
              disableRipple
              slotProps={{ input: { 'aria-hidden': true } }}
              sx={{ p: 0, pointerEvents: 'none' }}
            />
            <ListItemText>{option.label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}
