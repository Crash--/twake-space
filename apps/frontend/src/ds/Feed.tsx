import {
  Bottom,
  Check,
  ClockOutline,
  Cross,
  Down,
  Icon,
  ListMin,
  Send,
  Star,
  StarOutline,
  Top,
  type IconProps
} from '@linagora/twake-icons'
import {
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  ButtonBase,
  Checkbox,
  Divider,
  IconButton,
  InputBase,
  LinearProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Popover,
  Popper,
  Radio,
  Rating,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery
} from '@linagora/twake-mui'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
  type ReactNode
} from 'react'

import customRing from '@/assets/announcement-custom-ring.svg'
import megaphone from '@/assets/announcement-megaphone.svg'
import palette from '@/assets/announcement-palette.svg'
import {
  AddCircleIcon,
  AddReactionIcon,
  CampaignIcon,
  ChevronDownIcon,
  EmojiIcon,
  FormIcon,
  MoreVertIcon,
  SidePanelIcon,
  ThumbDownIcon,
  ThumbUpIcon,
  Videocam
} from '@/ds/icons'
import { NameAvatar, useNarrowScreen } from '@/ds/AppFrame'
import { PINNED_HEADER_HEIGHT } from '@/ds/Page'
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

// Where the rows scroll: the list itself, or the whole page below lg. `edge`
// is the top of the visible area on the screen: on the page, under the
// space's pinned header.
interface ScrollView {
  top: number
  height: number
  client: number
  edge: number
}

function scrollView(
  list: HTMLElement | null,
  page: boolean
): ScrollView | null {
  if (!list) return null
  return page
    ? {
        top: window.scrollY,
        height: document.documentElement.scrollHeight,
        client: window.innerHeight,
        edge: PINNED_HEADER_HEIGHT
      }
    : {
        top: list.scrollTop,
        height: list.scrollHeight,
        client: list.clientHeight,
        edge: list.getBoundingClientRect().top
      }
}

// The feed reads like a chat: the oldest item on top, the newest right above
// the composer. `placeKey` is null while the list loads; on each new one, the
// list opens on the `FeedNewMark`, or else on the newest item. It follows the
// newest items while the person is there, and otherwise keeps the rows in view
// still while rows come in above or below. Below lg the list scrolls with the
// page, so the space's header goes up and away with it.
export function FeedLayout({
  toolbar,
  pinned,
  children,
  composer,
  placeKey,
  latestLabel,
  topLabel,
  onAtEndChange,
  onNearTop
}: {
  toolbar: ReactNode
  /** Held over the list, out of its scroll on wide screens. */
  pinned?: ReactNode
  children: ReactNode
  composer: ReactNode
  placeKey: string | null
  latestLabel: string
  topLabel: string
  onAtEndChange?: (atEnd: boolean) => void
  onNearTop?: () => void
}): ReactElement {
  const pageScrolls = useNarrowScreen()
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const [behind, setBehind] = useState(false)
  const [down, setDown] = useState(false)
  // The first row in view, and where it sits on the screen: when the list
  // grows above or shrinks, the rows hold still under the eye.
  const anchor = useRef<{ row: Element; top: number } | null>(null)
  // A scroll this layout made itself is not the person scrolling.
  const ownScroll = useRef(false)
  // Back to top holds the page there while older rows come in above, until
  // the person scrolls.
  const atTop = useRef(false)

  const reportAtEnd = useEffectEvent((value: boolean) => {
    onAtEndChange?.(value)
  })
  // Read from the ref: on the render that places the list, `behind` is still
  // the one from before the placement.
  useEffect(() => {
    if (placeKey !== null) reportAtEnd(atEnd.current)
  }, [placeKey, behind])

  // Read by the handlers below: the media query as last rendered
  const onPage = useRef(pageScrolls)

  const view = () => scrollView(scroller.current, onPage.current)
  const scrollTo = (top: number) => {
    const list = scroller.current
    const before = scrollView(list, onPage.current)?.top
    if (!list || before === undefined) return
    if (onPage.current) window.scrollTo(0, top)
    else list.scrollTop = top
    if (scrollView(list, onPage.current)?.top !== before) {
      ownScroll.current = true
    }
  }
  const measure = (keepAnchor = false) => {
    const list = scroller.current
    const at = scrollView(list, onPage.current)
    if (!list || !at) return
    atEnd.current = at.height - at.top - at.client <= AT_END
    setBehind(!atEnd.current)
    if (keepAnchor) return
    const row = Array.from(list.querySelectorAll('article')).find(
      item => item.getBoundingClientRect().bottom > at.edge
    )
    anchor.current = row ? { row, top: row.getBoundingClientRect().top } : null
  }
  const keepPlace = useEffectEvent((rowsChanged: boolean) => {
    const at = view()
    if (!at) return
    const kept = anchor.current
    if (atEnd.current) {
      scrollTo(at.height)
    } else if (atTop.current) {
      scrollTo(0)
    } else if (
      kept?.row.isConnected &&
      // At the very top, the list resizing pushes the first rows down like a
      // page, instead of hiding them.
      (rowsChanged || at.top > 0)
    ) {
      scrollTo(at.top + kept.row.getBoundingClientRect().top - kept.top)
    }
    measure()
  })
  const scrolled = () => {
    const own = ownScroll.current
    ownScroll.current = false
    // The event of a scroll the layout made lands a frame late, when
    // the rows may have moved again: the anchor it set still holds.
    measure(own)
    const at = view()
    // Back to top waits for the person to scroll: the feed opens far down
    if (!own && at) {
      atTop.current = false
      setDown(at.top > at.client / 2)
    }
    const rows = content.current
    if (at && rows && at.edge - rows.getBoundingClientRect().top < NEAR_TOP) {
      onNearTop?.()
    }
  }
  const pageScrolled = useEffectEvent(scrolled)
  // Crossing lg (a tablet turned) moves the rows to the other scroller
  useLayoutEffect(() => {
    if (onPage.current === pageScrolls) return
    onPage.current = pageScrolls
    keepPlace(true)
  }, [pageScrolls])
  // At once, not smoothly: the list resizing on the way would stop a smooth
  // scroll short of the end.
  const toEnd = () => {
    atEnd.current = true
    atTop.current = false
    scrollTo(view()?.height ?? 0)
    measure()
  }
  const toTop = () => {
    atTop.current = true
    setDown(false)
    scrollTo(0)
    measure()
  }
  const reveal = useCallback((row: HTMLElement) => {
    const at = scrollView(scroller.current, onPage.current)
    if (!at) return
    atTop.current = false
    const box = row.getBoundingClientRect()
    scrollTo(at.top + box.top - at.edge - (at.client - box.height) / 2)
    measure()
  }, [])

  useLayoutEffect(() => {
    const whole = root.current
    const list = scroller.current
    const rows = content.current
    if (!whole || !list || !rows || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(entries => {
      keepPlace(entries.some(entry => entry.target === rows))
    })
    // The whole layout too: on the page, the pinned items above the list
    // move its rows without resizing them
    observer.observe(whole)
    observer.observe(list)
    observer.observe(rows)
    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!pageScrolls) return
    const listening = new AbortController()
    window.addEventListener(
      'scroll',
      () => {
        pageScrolled()
      },
      { signal: listening.signal }
    )
    return () => {
      listening.abort()
    }
  }, [pageScrolls])

  useLayoutEffect(() => {
    const list = scroller.current
    const at = scrollView(list, onPage.current)
    if (placeKey === null || !list || !at) return
    atTop.current = false
    const mark = list.querySelector('[data-feed-new]')
    scrollTo(
      mark ? at.top + mark.getBoundingClientRect().top - at.edge : at.height
    )
    measure()
  }, [placeKey])

  return (
    <Box
      ref={root}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        minHeight: 0
      }}
    >
      {pinned}
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
            // The layout keeps its rows in place itself, the same everywhere.
            overflowAnchor: 'none',
            ...(!pageScrolls && {
              overflowY: 'auto',
              // The cards fade out under the top edge instead of being cut.
              maskImage: `linear-gradient(to bottom, transparent 0, #000 ${String(FADE)}px)`
            })
          }}
          onScroll={pageScrolls ? undefined : scrolled}
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
      </Box>
      {/* Sending a message brings the person back to the newest items. */}
      <Box
        onSubmitCapture={toEnd}
        sx={
          pageScrolls
            ? {
                position: 'sticky',
                bottom: 'var(--sidebarHeight, 0px)',
                zIndex: 1,
                ...(composer ? { py: 1, bgcolor: 'background.paper' } : {})
              }
            : { position: 'relative' }
        }
      >
        <Box
          sx={{
            position: 'absolute',
            bottom: 'calc(100% + 16px)',
            left: 0,
            right: 0,
            display: 'flex',
            justifyContent: 'center',
            gap: 1,
            pointerEvents: 'none',
            '& > *': { pointerEvents: 'auto' }
          }}
        >
          {pageScrolls && down && (
            <JumpButton icon={Top} onClick={toTop}>
              {topLabel}
            </JumpButton>
          )}
          {behind && (
            <JumpButton icon={Down} onClick={toEnd}>
              {latestLabel}
            </JumpButton>
          )}
        </Box>
        {composer}
      </Box>
    </Box>
  )
}

function JumpButton({
  icon,
  onClick,
  children
}: {
  icon: IconProps['icon']
  onClick: () => void
  children: ReactNode
}): ReactElement {
  return (
    <Button
      size="small"
      startIcon={<Icon icon={icon} size={16} />}
      onClick={onClick}
      sx={{ borderRadius: 100, boxShadow: 2 }}
    >
      {children}
    </Button>
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

/** A 36px round tile with an app's icon in its colour on the neutral grey,
 * for cards an app sends. */
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
        bgcolor: 'background.default',
        color: theme.space.appColors[app]
      })}
    >
      <Icon icon={icon} size={18} />
    </Avatar>
  )
}

/** A person's avatar with the app they acted in as a small badge. */
export function AppBadge({
  icon,
  label,
  app,
  children
}: {
  icon: IconProps['icon']
  label: string
  app: keyof SpaceTokens['appColors']
  children: ReactNode
}): ReactElement {
  return (
    <Badge
      overlap="circular"
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      sx={{ '& .MuiBadge-badge': { p: 0 } }}
      badgeContent={
        <Avatar
          size={16}
          aria-label={label}
          title={label}
          sx={theme => ({
            bgcolor: 'background.default',
            color: theme.space.appColors[app],
            outline: `2px solid ${theme.palette.background.paper}`
          })}
        >
          <Icon icon={icon} size={10} />
        </Avatar>
      }
    >
      {children}
    </Badge>
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
      sx={{ width: 32, height: 32, p: 1, m: '-8px', color: 'text.secondary' }}
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

const clamp = (lines: number) => ({
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: lines,
  WebkitBoxOrient: 'vertical',
  overflowWrap: 'anywhere'
})

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
            ...clamp(2)
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

/** A link's page as a card that opens it in a new tab. */
export function FeedLinkPreview({
  href,
  site,
  title,
  description,
  image
}: {
  href: string
  site: string
  title: string
  description: string | null
  image: string | null
}): ReactElement {
  return (
    <Box
      component="a"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      sx={{
        display: 'block',
        width: 360,
        maxWidth: '100%',
        mt: 0.5,
        border: 1,
        borderColor: 'border.disabled',
        borderRadius: '10px',
        overflow: 'hidden',
        bgcolor: 'background.paper',
        color: 'inherit',
        textDecoration: 'none',
        '&:hover, &:focus-visible': { borderColor: 'primary.main' }
      }}
    >
      {image && (
        <Box
          component="img"
          src={image}
          alt=""
          sx={{
            display: 'block',
            width: '100%',
            maxHeight: 180,
            objectFit: 'cover',
            bgcolor: 'background.default',
            borderBottom: 1,
            borderColor: 'border.disabled'
          }}
        />
      )}
      <Box sx={{ p: 1.5 }}>
        <Typography
          variant="caption"
          color="textSecondary"
          noWrap
          sx={{ display: 'block', lineHeight: '16px', letterSpacing: 0.4 }}
        >
          {site}
        </Typography>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 600,
            lineHeight: '20px',
            letterSpacing: 0.25,
            ...clamp(2)
          }}
        >
          {title}
        </Typography>
        {description && (
          <Typography
            variant="caption"
            color="textSecondary"
            sx={{ lineHeight: '16px', ...clamp(2) }}
          >
            {description}
          </Typography>
        )}
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

export function FeedMention({ children }: { children: string }): ReactElement {
  return (
    <Box
      component="span"
      sx={theme => ({
        px: '0.35em',
        borderRadius: '4px',
        fontWeight: 500,
        color: theme.vars.palette.primary.main,
        bgcolor: theme.alpha(theme.vars.palette.primary.main, 0.12)
      })}
    >
      {children}
    </Box>
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
          flex: '1 1 auto',
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
        // The composer's 44px cells, so that the row fits the menus' 320px.
        sx={{
          '& .MuiPaper-root': { borderRadius: 100 },
          '& .MuiList-root': { display: 'flex', px: 1 },
          '& .MuiMenuItem-root': { width: 44, minWidth: 0, px: 0 }
        }}
      >
        {emojis.map(emoji => (
          <MenuItem
            key={emoji}
            aria-label={emoji}
            onClick={() => {
              setAnchor(null)
              onPick(emoji)
            }}
            sx={{ fontSize: 20, justifyContent: 'center' }}
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
      // The outlined field's label floats above its border, into the
      // bubble's header unless the form leaves room for it.
      sx={{ mt: 2, mb: 1 }}
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

interface MenuEntry {
  label: string
  icon: IconProps['icon']
  onClick: () => void
  disabled?: boolean
}

/**
 * The « + » before the composer's field, as tall as the field: a menu of the
 * kinds of post, each opening its dialog, as the chat's composer offers them.
 */
export function FeedComposerMenu({
  label,
  files,
  items
}: {
  label: string
  /** Above a divider: ways to share files, which open no dialog. */
  files: MenuEntry[]
  items: MenuEntry[]
}): ReactElement {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const menuId = useId()
  const entry = (item: MenuEntry, dialog: boolean) => (
    <MenuItem
      key={item.label}
      aria-haspopup={dialog ? 'dialog' : undefined}
      disabled={item.disabled}
      onClick={() => {
        setAnchor(null)
        item.onClick()
      }}
      sx={{
        borderRadius: 1.5,
        minHeight: 32,
        typography: 'body2',
        '& .MuiListItemIcon-root': {
          width: 16,
          minWidth: 0,
          flexShrink: 0,
          color: 'text.secondary'
        }
      }}
    >
      <ListItemIcon aria-hidden>
        <Icon icon={item.icon} size={16} />
      </ListItemIcon>
      <ListItemText disableTypography>{item.label}</ListItemText>
    </MenuItem>
  )
  return (
    <>
      <Tooltip title={label}>
        <IconButton
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          aria-controls={anchor ? menuId : undefined}
          onClick={event => {
            setAnchor(event.currentTarget)
          }}
          sx={{
            flex: '0 0 44px',
            width: 44,
            height: 44,
            p: 0,
            border: 1,
            borderColor: 'border.main',
            color: 'text.secondary'
          }}
        >
          <Icon icon={AddCircleIcon} size={24} />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => {
          setAnchor(null)
        }}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          list: { id: menuId, dense: true, sx: { p: 0 } },
          paper: {
            elevation: 2,
            sx: { p: 0.25, borderRadius: 2, mb: 0.5, minWidth: 200 }
          }
        }}
      >
        {files.map(item => entry(item, false))}
        {files.length > 0 && <Divider sx={{ my: 0.5 }} />}
        {items.map(item => entry(item, true))}
      </Menu>
    </>
  )
}

/**
 * Files on their way to the space's Drive, each with its bar: without a
 * percent (null), the bar runs without one.
 */
export function FeedUploads({
  label,
  files,
  cancelLabel,
  onCancel
}: {
  label: string
  files: { name: string; percent: number | null }[]
  cancelLabel: string
  onCancel: () => void
}): ReactElement {
  const id = useId()
  return (
    <Alert
      severity="info"
      action={
        <Button color="inherit" size="small" onClick={onCancel}>
          {cancelLabel}
        </Button>
      }
    >
      {label}
      <Box
        component="ul"
        sx={{
          width: 1,
          maxHeight: 240,
          overflowY: 'auto',
          listStyle: 'none',
          m: 0,
          mt: 1,
          p: 0,
          display: 'grid',
          // A long name would widen an auto column past the alert
          gridTemplateColumns: 'minmax(0, 1fr)',
          gap: 1
        }}
      >
        {files.map((file, index) => (
          <li key={index}>
            <Typography id={id + String(index)} variant="body2" noWrap>
              {file.name}
            </Typography>
            <LinearProgress
              aria-labelledby={id + String(index)}
              variant={file.percent === null ? 'indeterminate' : 'determinate'}
              value={file.percent ?? undefined}
            />
          </li>
        ))}
      </Box>
    </Alert>
  )
}

/** A new poll's option field, and the button that removes it, if any. */
export function FeedPollOption({
  children,
  removeLabel,
  onRemove
}: {
  children: ReactNode
  removeLabel: string
  onRemove: (() => void) | null
}): ReactElement {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      {children}
      {onRemove && (
        <IconButton
          aria-label={removeLabel}
          onClick={onRemove}
          sx={{ color: 'text.secondary' }}
        >
          <Icon icon={Cross} size={20} />
        </IconButton>
      )}
    </Box>
  )
}

/** The small tinted label over a card that says what kind of post it is. */
function FeedKindChip({
  icon,
  label
}: {
  icon?: IconProps['icon']
  label: string
}): ReactElement {
  return (
    <Box
      sx={theme => ({
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        px: 1,
        py: 0.5,
        borderRadius: '100px',
        color: 'primary.main',
        bgcolor: theme.alpha(theme.vars.palette.primary.main, 0.04)
      })}
    >
      {icon && <Icon icon={icon} size={16} />}
      <Typography
        sx={{
          fontSize: 10,
          fontWeight: 500,
          lineHeight: '16px',
          letterSpacing: 0.5
        }}
      >
        {label}
      </Typography>
    </Box>
  )
}

/** The first few people behind a count, as small overlapping avatars. */
function FeedPeople({
  people
}: {
  people: { id: string; name: string; avatar: string | null }[]
}): ReactElement | null {
  if (people.length === 0) return null
  return (
    <Box sx={{ display: 'flex' }}>
      {people.slice(0, 4).map(person => (
        <Box
          key={person.id}
          sx={{
            mr: '-2px',
            borderRadius: '50%',
            border: 1,
            borderColor: 'background.paper',
            display: 'flex'
          }}
        >
          <NameAvatar
            name={person.name}
            size={14}
            label={person.name}
            src={person.avatar}
          />
        </Box>
      ))}
    </Box>
  )
}

/**
 * A poll as the chat shows one: its question and a row per option to pick,
 * with who picked it and its share of the votes, then a summary.
 */
export function FeedPoll({
  kind,
  question,
  multiple,
  options,
  summary,
  disabled,
  onVote,
  close
}: {
  /** The chip over the question; null for none. */
  kind: string | null
  question: string
  multiple: boolean
  /** `name` is the option's accessible name, with its count. */
  options: {
    label: string
    name: string
    count: number
    mine: boolean
    voters: { id: string; name: string; avatar: string | null }[]
  }[]
  summary: string
  disabled: boolean
  onVote: (index: number) => void
  /** The author's button that closes the poll; null for anyone else. */
  close: { label: string; onClick: () => void } | null
}): ReactElement {
  const total = options.reduce((sum, option) => sum + option.count, 0)
  const Pick = multiple ? Checkbox : Radio
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 1,
        py: 0.5
      }}
    >
      {kind && <FeedKindChip label={kind} />}
      <FeedTitle>{question}</FeedTitle>
      <Box
        role="group"
        aria-label={question}
        sx={{
          alignSelf: 'stretch',
          display: 'flex',
          flexDirection: 'column',
          gap: 0.5
        }}
      >
        {options.map((option, index) => (
          <Box
            key={option.label}
            component="label"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              minHeight: 40,
              pl: 2,
              pr: 1,
              py: 0.5,
              borderRadius: '80px',
              bgcolor: 'background.paper',
              cursor: disabled ? 'default' : 'pointer'
            }}
          >
            <Pick
              size="small"
              checked={option.mine}
              disabled={disabled}
              // A click, not a change: picking the checked radio again takes the vote back.
              onClick={() => {
                onVote(index)
              }}
              slotProps={{ input: { 'aria-label': option.name } }}
              sx={{
                p: 0.5,
                m: -0.5,
                // Closed, one's own pick stays readable.
                '&.Mui-checked.Mui-disabled': { color: 'primary.main' }
              }}
            />
            <Typography
              variant="caption"
              sx={{
                flex: '1 1 auto',
                minWidth: 0,
                fontWeight: 500,
                letterSpacing: 0.5,
                overflowWrap: 'anywhere'
              }}
            >
              {option.label}
            </Typography>
            <FeedPeople people={option.voters} />
            <Typography
              aria-hidden
              color="textSecondary"
              sx={{
                flex: '0 0 auto',
                fontSize: 14,
                fontWeight: 500,
                lineHeight: '18.4px',
                letterSpacing: 0.25
              }}
            >
              {`${String(total > 0 ? Math.round((option.count / total) * 100) : 0)}%`}
            </Typography>
          </Box>
        ))}
      </Box>
      <FeedPollFooter people={[]} summary={summary} close={close} />
    </Box>
  )
}

function FeedPollFooter({
  people,
  summary,
  close
}: {
  people: { id: string; name: string; avatar: string | null }[]
  summary: string
  close: { label: string; onClick: () => void } | null
}): ReactElement {
  return (
    <Box
      sx={{
        alignSelf: 'stretch',
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        pl: 1
      }}
    >
      <FeedPeople people={people} />
      <Typography
        variant="caption"
        color="textSecondary"
        sx={{ flex: '1 1 auto', fontWeight: 500, letterSpacing: 0.4 }}
      >
        {summary}
      </Typography>
      {close && (
        <Button size="small" color="inherit" onClick={close.onClick}>
          {close.label}
        </Button>
      )}
    </Box>
  )
}

const ANSWER_ICONS = [ThumbUpIcon, ThumbDownIcon]

/**
 * A yes/no question: its two answers side by side with their counts, the
 * reader's own one tinted, then who answered.
 */
export function FeedYesNo({
  kind,
  deadline,
  question,
  answers,
  people,
  summary,
  disabled,
  onVote,
  close
}: {
  kind: string
  /** The chip that says when it closes; null for no deadline. */
  deadline: string | null
  question: string
  /** Yes, then no. `name` is the answer's accessible name, with its count. */
  answers: { label: string; name: string; count: number; mine: boolean }[]
  people: { id: string; name: string; avatar: string | null }[]
  summary: string
  disabled: boolean
  onVote: (index: number) => void
  /** The author's button that closes it; null for anyone else. */
  close: { label: string; onClick: () => void } | null
}): ReactElement {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 1,
        py: 0.5
      }}
    >
      <Box sx={{ display: 'flex', gap: 1 }}>
        <FeedKindChip label={kind} />
        {deadline && <FeedKindChip icon={ClockOutline} label={deadline} />}
      </Box>
      <FeedTitle>{question}</FeedTitle>
      <Box
        role="group"
        aria-label={question}
        sx={{ alignSelf: 'stretch', display: 'flex', gap: 0.5 }}
      >
        {answers.map((answer, index) => {
          const AnswerIcon = ANSWER_ICONS[index] ?? ThumbUpIcon
          return (
            <ButtonBase
              key={answer.label}
              aria-pressed={answer.mine}
              aria-label={answer.name}
              disabled={disabled}
              onClick={() => {
                onVote(index)
              }}
              sx={theme => ({
                flex: '1 1 0',
                minWidth: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                minHeight: 40,
                pl: 2,
                pr: 1,
                borderRadius: '80px',
                color: 'text.primary',
                bgcolor: answer.mine
                  ? theme.alpha(theme.vars.palette.success.main, 0.12)
                  : 'background.paper'
              })}
            >
              <Box
                sx={{
                  width: 32,
                  height: 32,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <AnswerIcon width={20} height={20} />
              </Box>
              <Typography
                variant="caption"
                sx={{
                  flex: '1 1 auto',
                  textAlign: 'start',
                  fontWeight: 500,
                  letterSpacing: 0.5
                }}
              >
                {answer.label}
              </Typography>
              <Typography
                aria-hidden
                color="textSecondary"
                sx={{
                  fontSize: 14,
                  fontWeight: 500,
                  lineHeight: '18.4px',
                  letterSpacing: 0.25,
                  pr: 1
                }}
              >
                {answer.count}
              </Typography>
            </ButtonBase>
          )
        })}
      </Box>
      <FeedPollFooter people={people} summary={summary} close={close} />
    </Box>
  )
}

/** `none`: no decision, and none awaited any more. */
export type ApproverTone = 'pending' | 'approved' | 'rejected' | 'none'

const TONE_COLOR = {
  pending: 'text.secondary',
  approved: 'success.main',
  rejected: 'error.main',
  none: 'text.secondary'
} as const

const TONE_ICON = {
  pending: ClockOutline,
  approved: Check,
  rejected: Cross,
  none: null
} as const

// A longer list shows its first two until asked: showing all but one hides
// too little to be worth a click.
const APPROVERS_SHOWN = 2

/**
 * An approval request: what needs approval and its details, each approver
 * with what they decided, and the buttons of an approver who has not decided
 * yet.
 */
export function FeedApproval({
  title,
  details,
  approvers,
  more,
  decide
}: {
  title: string
  details: string | null
  approvers: {
    id: string
    /** For the avatar; `label` is shown, "You" for the reader. */
    name: string
    label: string
    avatar: string | null
    tone: ApproverTone
    status: string
    comment: string | null
  }[]
  more: { showAll: string; showLess: string }
  /** For an approver who has not decided while the request is open. */
  decide: {
    approveLabel: string
    rejectLabel: string
    disabled: boolean
    onDecide: (decision: 'approved' | 'rejected') => void
  } | null
}): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const collapsible = approvers.length > APPROVERS_SHOWN + 1
  const shown =
    collapsible && !expanded ? approvers.slice(0, APPROVERS_SHOWN) : approvers
  return (
    <Box
      role="group"
      aria-label={title}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        width: 480,
        maxWidth: '100%',
        pt: 0.5
      }}
    >
      <Box>
        <Typography
          variant="body2"
          sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}
        >
          {title}
        </Typography>
        {details && (
          <Typography
            variant="caption"
            component="p"
            color="textSecondary"
            sx={{
              mt: 0.5,
              letterSpacing: 0.4,
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap'
            }}
          >
            {details}
          </Typography>
        )}
      </Box>
      <Box
        sx={{
          bgcolor: 'background.paper',
          borderRadius: '12px',
          px: 1.5,
          py: 1
        }}
      >
        <Box
          component="ul"
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            m: 0,
            p: 0,
            listStyle: 'none'
          }}
        >
          {shown.map(approver => {
            const icon = TONE_ICON[approver.tone]
            return (
              <Box
                component="li"
                key={approver.id}
                aria-label={`${approver.label}: ${approver.status}`}
                sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5 }}
              >
                <NameAvatar
                  name={approver.name}
                  size="s"
                  src={approver.avatar}
                />
                <Box sx={{ flex: '1 1 auto', minWidth: 0 }}>
                  <Typography
                    variant="body2"
                    sx={{ lineHeight: '24px', overflowWrap: 'anywhere' }}
                  >
                    {approver.label}
                  </Typography>
                  {approver.comment && <Quote>{approver.comment}</Quote>}
                </Box>
                <Box
                  sx={{
                    flex: '0 0 auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    minHeight: 24,
                    color: TONE_COLOR[approver.tone]
                  }}
                >
                  <Typography variant="body2" sx={{ color: 'inherit' }}>
                    {approver.status}
                  </Typography>
                  {icon && <Icon icon={icon} size={18} aria-hidden />}
                </Box>
              </Box>
            )
          })}
        </Box>
        {collapsible && (
          <Button
            size="small"
            variant="text"
            aria-expanded={expanded}
            endIcon={<Icon icon={expanded ? Top : Bottom} size={12} />}
            onClick={() => {
              setExpanded(!expanded)
            }}
            sx={{ mt: 0.5, ml: -1 }}
          >
            {expanded ? more.showLess : more.showAll}
          </Button>
        )}
      </Box>
      {decide && (
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            fullWidth
            variant="outlined"
            disabled={decide.disabled}
            startIcon={<Icon icon={Cross} size={16} />}
            onClick={() => {
              decide.onDecide('rejected')
            }}
          >
            {decide.rejectLabel}
          </Button>
          <Button
            fullWidth
            variant="contained"
            disabled={decide.disabled}
            startIcon={<Icon icon={Check} size={16} />}
            onClick={() => {
              decide.onDecide('approved')
            }}
          >
            {decide.approveLabel}
          </Button>
        </Box>
      )}
    </Box>
  )
}

/** Under an approval request, beside its time: how far it got, and closing it. */
export function FeedApprovalSummary({
  summary,
  close
}: {
  summary: string
  close: { label: string; onClick: () => void } | null
}): ReactElement {
  return (
    <>
      <Typography
        variant="caption"
        color="textSecondary"
        sx={{ flex: '1 1 auto', fontWeight: 500, letterSpacing: 0.4 }}
      >
        {summary}
      </Typography>
      {close && (
        <Button size="small" variant="text" onClick={close.onClick}>
          {close.label}
        </Button>
      )}
    </>
  )
}

function Quote({ children }: { children: string }): ReactElement {
  return (
    <Typography
      variant="body2"
      sx={{
        mt: 0.5,
        pl: 1,
        borderLeft: 2,
        borderColor: 'border.main',
        color: 'text.secondary',
        overflowWrap: 'anywhere',
        whiteSpace: 'pre-wrap'
      }}
    >
      {children}
    </Typography>
  )
}

/**
 * A feedback request: a member rates it from 1 to 5 stars with an optional
 * comment, and can change it while the request is open; then everyone sees the
 * average, the author every comment.
 */
export function FeedFeedback({
  question,
  average,
  comments,
  mine,
  answer,
  summary,
  close
}: {
  question: string
  /** The average rating, null before any. */
  average: { value: number; label: string; text: string } | null
  comments: {
    items: { id: string; name: string | null; text: string }[]
    showAll: string
    showLess: string
  }
  mine: { rating: number | null; text: string } | null
  /** For a member while the request is open. */
  answer: {
    ratingLabel: string
    starLabel: (stars: number) => string
    commentLabel: string
    sendLabel: string
    editLabel: string
    maxLength: number
    disabled: boolean
    onAnswer: (answer: { rating: number; text: string }) => void
  } | null
  summary: string
  close: { label: string; onClick: () => void } | null
}): ReactElement {
  const [rating, setRating] = useState<number | null>(null)
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  const writing = answer !== null && (mine === null || editing)
  return (
    <Box
      role="group"
      aria-label={question}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        width: 480,
        maxWidth: '100%',
        py: 0.5
      }}
    >
      <FeedTitle large>{question}</FeedTitle>
      {writing ? (
        <Box
          component="form"
          sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}
          onSubmit={event => {
            event.preventDefault()
            if (rating === null) return
            answer.onAnswer({ rating, text: text.trim() })
            setEditing(false)
          }}
        >
          <FeedStars
            value={rating}
            label={answer.ratingLabel}
            starLabel={answer.starLabel}
            onChange={setRating}
          />
          <InputBase
            fullWidth
            multiline
            minRows={3}
            maxRows={8}
            placeholder={answer.commentLabel}
            value={text}
            inputProps={{
              maxLength: answer.maxLength,
              'aria-label': answer.commentLabel
            }}
            onChange={event => {
              setText(event.target.value)
            }}
            sx={{
              bgcolor: 'background.paper',
              borderRadius: '12px',
              px: 1.75,
              py: 1.5,
              fontSize: 14,
              lineHeight: '20px'
            }}
          />
          <Box>
            <Button
              type="submit"
              variant="contained"
              disabled={answer.disabled || rating === null}
              sx={{ borderRadius: '50px' }}
            >
              {answer.sendLabel}
            </Button>
          </Box>
        </Box>
      ) : (
        <>
          {average && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <FeedStars value={average.value} label={average.label} />
              <Typography variant="body2" color="textSecondary" aria-hidden>
                {average.text}
              </Typography>
            </Box>
          )}
          {comments.items.length > 0 && <FeedbackComments {...comments} />}
        </>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography
          variant="caption"
          color="textSecondary"
          sx={{ flex: '1 1 auto', fontWeight: 500, letterSpacing: 0.4 }}
        >
          {summary}
        </Typography>
        {answer && mine && !writing && (
          <Button
            variant="text"
            size="small"
            onClick={() => {
              setRating(mine.rating)
              setText(mine.text)
              setEditing(true)
            }}
          >
            {answer.editLabel}
          </Button>
        )}
        {close && (
          <Button variant="text" size="small" onClick={close.onClick}>
            {close.label}
          </Button>
        )}
      </Box>
    </Box>
  )
}

const STAR_SIZE = 28

// Five stars: a radio group to rate with, or, without `onChange`, a picture of
// a rating, filled to its tenth.
function FeedStars({
  value,
  label,
  starLabel,
  onChange
}: {
  value: number | null
  label: string
  starLabel?: (stars: number) => string
  onChange?: (value: number | null) => void
}): ReactElement {
  const name = useId()
  return (
    <Rating
      name={name}
      value={value}
      precision={onChange ? 1 : 0.1}
      readOnly={!onChange}
      {...(onChange
        ? {
            'aria-label': label,
            getLabelText: starLabel,
            onChange: (_event, next) => {
              onChange(next)
            }
          }
        : { getLabelText: () => label })}
      icon={<Icon icon={Star} size={STAR_SIZE} />}
      emptyIcon={<Icon icon={StarOutline} size={STAR_SIZE} />}
      sx={theme => ({
        gap: 0.5,
        '& .MuiRating-iconFilled': { color: theme.space.ratingStar },
        '& .MuiRating-iconEmpty': { color: 'text.secondary' }
      })}
    />
  )
}

const FOLDED_COMMENTS = 2

// The comments on white, each after its author's name; past two, folded
// behind a button, and unfolded, scrolled within.
function FeedbackComments({
  items,
  showAll,
  showLess
}: {
  items: { id: string; name: string | null; text: string }[]
  showAll: string
  showLess: string
}): ReactElement {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const foldable = items.length > FOLDED_COMMENTS
  const shown = foldable && !open ? items.slice(0, FOLDED_COMMENTS) : items
  return (
    <Box
      sx={{
        bgcolor: 'background.paper',
        borderRadius: '12px',
        px: 1.75,
        py: 1.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 1
      }}
    >
      <Box
        id={listId}
        component="ul"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          m: 0,
          p: 0,
          listStyle: 'none',
          ...(open && { maxHeight: 200, overflowY: 'auto' })
        }}
      >
        {shown.map(item => (
          <Typography
            key={item.id}
            component="li"
            variant="body2"
            sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
          >
            {item.name !== null && (
              <Box component="span" sx={{ fontWeight: 600 }}>
                {`${item.name}: `}
              </Box>
            )}
            {item.text}
          </Typography>
        ))}
      </Box>
      {foldable && (
        <Box>
          <Button
            variant="text"
            size="small"
            aria-expanded={open}
            aria-controls={listId}
            endIcon={<Icon icon={ChevronDownIcon} size={16} />}
            sx={{ '& .MuiButton-endIcon': open ? { rotate: '180deg' } : {} }}
            onClick={() => {
              setOpen(current => !current)
            }}
          >
            {open ? showLess : showAll}
          </Button>
        </Box>
      )}
    </Box>
  )
}

/**
 * A form: a member answers every question, a text or one of its options, and
 * can change their response while the form is open; the author reads every
 * response.
 */
export function FeedForm({
  kind,
  title,
  fields,
  mine,
  respond,
  responses,
  summary,
  close
}: {
  kind: string
  title: string
  fields: { label: string; options: string[] | null }[]
  /** The reader's answers, an option's index for a choice; null until sent. */
  mine: (string | number)[] | null
  /** For a member while the form is open. */
  respond: {
    placeholder: string
    sendLabel: string
    editLabel: string
    maxLength: number
    disabled: boolean
    onRespond: (answers: (string | number)[]) => void
  } | null
  /** For its author: each response's answers, in field order. */
  responses: {
    items: { id: string; name: string | null; answers: (string | number)[] }[]
    showAll: string
    showLess: string
  } | null
  summary: string
  close: { label: string; onClick: () => void } | null
}): ReactElement {
  const [answers, setAnswers] = useState<(string | number | null)[]>([])
  const [editing, setEditing] = useState(false)
  const name = useId()
  const writing = respond !== null && (mine === null || editing)
  const answerOf = (index: number) => answers[index] ?? null
  const complete = fields.every((field, index) => {
    const answer = answerOf(index)
    return field.options
      ? typeof answer === 'number'
      : typeof answer === 'string' && answer.trim() !== ''
  })
  const set = (index: number, answer: string | number) => {
    setAnswers(current => {
      const next = fields.map((_, i) => current[i] ?? null)
      next[index] = answer
      return next
    })
  }
  return (
    <Box
      role="group"
      aria-label={title}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 1.5,
        width: 480,
        maxWidth: '100%',
        py: 0.5
      }}
    >
      <FeedKindChip icon={FormIcon} label={kind} />
      <FeedTitle large>{title}</FeedTitle>
      {writing ? (
        <Box
          component="form"
          sx={{
            alignSelf: 'stretch',
            display: 'flex',
            flexDirection: 'column',
            gap: 2
          }}
          onSubmit={event => {
            event.preventDefault()
            if (!complete) return
            respond.onRespond(
              fields.map((field, index) => {
                const answer = answerOf(index)
                return typeof answer === 'string'
                  ? answer.trim()
                  : (answer ?? 0)
              })
            )
            setEditing(false)
          }}
        >
          {fields.map((field, index) => {
            const answer = answerOf(index)
            return (
              <Box
                key={index}
                role={field.options ? 'radiogroup' : 'group'}
                aria-label={field.label}
                sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}
              >
                <Typography
                  variant="body2"
                  aria-hidden
                  sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}
                >
                  {field.label}
                </Typography>
                {field.options ? (
                  field.options.map((option, optionIndex) => (
                    <Box
                      key={option}
                      component="label"
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 2,
                        minHeight: 40,
                        pl: 2,
                        pr: 1,
                        py: 0.5,
                        borderRadius: '80px',
                        bgcolor: 'background.paper',
                        cursor: 'pointer'
                      }}
                    >
                      <Radio
                        size="small"
                        name={`${name}-${String(index)}`}
                        checked={answer === optionIndex}
                        onChange={() => {
                          set(index, optionIndex)
                        }}
                        sx={{ p: 0.5, m: -0.5 }}
                      />
                      <Typography
                        variant="caption"
                        sx={{
                          fontWeight: 500,
                          letterSpacing: 0.5,
                          overflowWrap: 'anywhere'
                        }}
                      >
                        {option}
                      </Typography>
                    </Box>
                  ))
                ) : (
                  <InputBase
                    fullWidth
                    multiline
                    maxRows={6}
                    placeholder={respond.placeholder}
                    value={typeof answer === 'string' ? answer : ''}
                    inputProps={{
                      maxLength: respond.maxLength,
                      'aria-label': field.label
                    }}
                    onChange={event => {
                      set(index, event.target.value)
                    }}
                    sx={{
                      bgcolor: 'background.paper',
                      borderRadius: '12px',
                      px: 1.75,
                      py: 1.25,
                      fontSize: 14,
                      lineHeight: '20px'
                    }}
                  />
                )}
              </Box>
            )
          })}
          <Box>
            <Button
              type="submit"
              variant="contained"
              disabled={respond.disabled || !complete}
              sx={{ borderRadius: '50px' }}
            >
              {respond.sendLabel}
            </Button>
          </Box>
        </Box>
      ) : (
        <>
          {mine && (
            <FormResponses
              items={[{ id: 'mine', name: null, answers: mine }]}
              fields={fields}
              showAll=""
              showLess=""
            />
          )}
          {responses && responses.items.length > 0 && (
            <FormResponses {...responses} fields={fields} />
          )}
        </>
      )}
      <Box
        sx={{
          alignSelf: 'stretch',
          display: 'flex',
          alignItems: 'center',
          gap: 1
        }}
      >
        <Typography
          variant="caption"
          color="textSecondary"
          sx={{ flex: '1 1 auto', fontWeight: 500, letterSpacing: 0.4 }}
        >
          {summary}
        </Typography>
        {respond && mine && !writing && (
          <Button
            variant="text"
            size="small"
            onClick={() => {
              setAnswers(mine)
              setEditing(true)
            }}
          >
            {respond.editLabel}
          </Button>
        )}
        {close && (
          <Button variant="text" size="small" onClick={close.onClick}>
            {close.label}
          </Button>
        )}
      </Box>
    </Box>
  )
}

// Each response on white, its answers under their questions; past two, folded
// behind a button, and unfolded, scrolled within.
function FormResponses({
  items,
  fields,
  showAll,
  showLess
}: {
  items: { id: string; name: string | null; answers: (string | number)[] }[]
  fields: { label: string; options: string[] | null }[]
  showAll: string
  showLess: string
}): ReactElement {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const foldable = items.length > FOLDED_COMMENTS
  const shown = foldable && !open ? items.slice(0, FOLDED_COMMENTS) : items
  return (
    <Box
      sx={{
        alignSelf: 'stretch',
        bgcolor: 'background.paper',
        borderRadius: '12px',
        px: 1.75,
        py: 1.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 1
      }}
    >
      <Box
        id={listId}
        component="ul"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          m: 0,
          p: 0,
          listStyle: 'none',
          ...(open && { maxHeight: 320, overflowY: 'auto' })
        }}
      >
        {shown.map(item => (
          <Box
            key={item.id}
            component="li"
            sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}
          >
            {item.name !== null && (
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {item.name}
              </Typography>
            )}
            {fields.map((field, index) => {
              const answer = item.answers[index]
              return (
                <Box key={index}>
                  <Typography
                    variant="caption"
                    color="textSecondary"
                    sx={{ display: 'block', overflowWrap: 'anywhere' }}
                  >
                    {field.label}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                  >
                    {field.options && typeof answer === 'number'
                      ? field.options[answer]
                      : answer}
                  </Typography>
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
      {foldable && (
        <Box>
          <Button
            variant="text"
            size="small"
            aria-expanded={open}
            aria-controls={listId}
            endIcon={<Icon icon={ChevronDownIcon} size={16} />}
            sx={{ '& .MuiButton-endIcon': open ? { rotate: '180deg' } : {} }}
            onClick={() => {
              setOpen(current => !current)
            }}
          >
            {open ? showLess : showAll}
          </Button>
        </Box>
      )}
    </Box>
  )
}

/** The banner colours design picked; an author may also pick any other. */
export const ANNOUNCEMENT_COLORS = [
  '#abd3ca',
  '#a36f9e',
  '#ba718e',
  '#99aff3',
  '#c77962',
  '#e8c283',
  '#8c78b8',
  '#638f83',
  '#4d9795',
  '#cbddba',
  '#b9c9f3',
  '#dfb5cd',
  '#d1c2ec',
  '#646580'
]
export const ANNOUNCEMENT_DEFAULT_COLOR = '#99aff3'

/**
 * An announcement's headline on its colour. Without a colour it sits on the
 * bubble's grey, in the text colour.
 */
export function AnnouncementBanner({
  color,
  rounded,
  corner,
  children
}: {
  color: string | null
  rounded: boolean
  /** Bottom right, over the watermark: the dialog's colour button. */
  corner?: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <Box
      sx={{
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 149,
        px: 6,
        py: 3,
        borderRadius: rounded ? '16.8px' : 0,
        bgcolor: color ?? 'action.hover',
        color: color ? 'common.white' : 'text.primary'
      }}
    >
      {color && (
        // Only the colour under it changes: the gradient keeps white readable.
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(90deg, rgba(27,31,41,0.12) 0%, rgba(27,31,41,0.08) 50%, rgba(27,31,41,0) 100%)'
          }}
        />
      )}
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          right: -25,
          top: 'calc(50% + 29px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 144,
          height: 144,
          transform: 'translateY(-50%) rotate(-12.69deg)',
          ...(!color && { filter: 'invert(1)' })
        }}
      >
        <img src={megaphone} alt="" width={120} height={120} />
      </Box>
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          textAlign: 'center',
          fontSize: 22,
          fontWeight: 600,
          lineHeight: '25.7px',
          overflowWrap: 'anywhere'
        }}
      >
        {children}
      </Box>
      {corner && (
        <Box sx={{ position: 'absolute', right: 13, bottom: 10 }}>{corner}</Box>
      )}
    </Box>
  )
}

/** The swatches over the banner: none, design's colours, and any other. */
export function AnnouncementColors({
  value,
  labels,
  onChange
}: {
  value: string | null
  labels: { none: string; custom: string; color: (hex: string) => string }
  onChange: (color: string | null) => void
}): ReactElement {
  const custom = value !== null && !ANNOUNCEMENT_COLORS.includes(value)
  const picker = useRef<HTMLInputElement>(null)
  const swatch = {
    width: 21,
    height: 21,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  } as const
  return (
    <Box
      role="radiogroup"
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(7, 21px)',
        gap: '5.3px',
        p: 2
      }}
    >
      <ButtonBase
        role="radio"
        aria-checked={value === null}
        aria-label={labels.none}
        onClick={() => {
          onChange(null)
        }}
        sx={{
          ...swatch,
          bgcolor: 'common.white',
          border: '1px solid #cdcdcd',
          color: 'text.secondary'
        }}
      >
        <Icon icon={Cross} size={10} />
      </ButtonBase>
      {ANNOUNCEMENT_COLORS.map(color => (
        <ButtonBase
          key={color}
          role="radio"
          aria-checked={value === color}
          aria-label={labels.color(color)}
          onClick={() => {
            onChange(color)
          }}
          sx={{ ...swatch, bgcolor: color, color: 'common.white' }}
        >
          {value === color && <Icon icon={Check} size={12} />}
        </ButtonBase>
      ))}
      <ButtonBase
        role="radio"
        aria-checked={custom}
        aria-label={labels.custom}
        onClick={() => {
          picker.current?.click()
        }}
        sx={{
          ...swatch,
          position: 'relative',
          bgcolor: custom ? value : 'transparent'
        }}
      >
        <Box
          component="img"
          src={customRing}
          alt=""
          sx={{ position: 'absolute', inset: 0, width: 21, height: 21 }}
        />
        <img src={palette} alt="" width={10} height={10} />
      </ButtonBase>
      {/* The swatch opens it: hidden from the keyboard and screen readers. */}
      <Box
        component="input"
        ref={picker}
        type="color"
        tabIndex={-1}
        aria-hidden
        value={value ?? ANNOUNCEMENT_DEFAULT_COLOR}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          onChange(event.target.value.toLowerCase())
        }}
        sx={{
          position: 'absolute',
          width: 0,
          height: 0,
          p: 0,
          border: 0,
          opacity: 0,
          pointerEvents: 'none'
        }}
      />
    </Box>
  )
}

/** The dialog's banner: the headline typed on it, its colour picked in a corner. */
export function AnnouncementBannerField({
  title,
  onTitle,
  placeholder,
  label,
  maxLength,
  color,
  onColor,
  colors
}: {
  title: string
  onTitle: (title: string) => void
  placeholder: string
  label: string
  maxLength: number
  color: string | null
  onColor: (color: string | null) => void
  colors: {
    label: string
    none: string
    custom: string
    color: (hex: string) => string
  }
}): ReactElement {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return (
    <>
      <AnnouncementBanner
        color={color}
        rounded={false}
        corner={
          <ButtonBase
            aria-label={colors.label}
            aria-haspopup="dialog"
            onClick={event => {
              setAnchor(event.currentTarget)
            }}
            sx={{
              width: 24,
              height: 24,
              borderRadius: '8px',
              bgcolor: 'common.white',
              boxShadow:
                '0 4px 16px rgba(29,33,42,0.06), 0 2px 4px rgba(29,33,42,0.08), 0 0 0 0.5px rgba(29,33,42,0.12)'
            }}
          >
            <Box
              sx={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                bgcolor: color ?? 'common.white',
                border: color ? 0 : '1px solid #cdcdcd'
              }}
            />
          </ButtonBase>
        }
      >
        <InputBase
          fullWidth
          value={title}
          placeholder={placeholder}
          inputProps={{ 'aria-label': label, maxLength }}
          onChange={event => {
            onTitle(event.target.value)
          }}
          sx={{
            color: 'inherit',
            font: 'inherit',
            '& input': { textAlign: 'center', p: 0 },
            '& input::placeholder': { color: 'inherit', opacity: 1 }
          }}
        />
      </AnnouncementBanner>
      <Popover
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => {
          setAnchor(null)
        }}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        slotProps={{
          paper: { 'aria-label': colors.label, sx: { borderRadius: '16px' } }
        }}
      >
        <AnnouncementColors value={color} labels={colors} onChange={onColor} />
      </Popover>
    </>
  )
}

/** An announcement in its bubble: the chip, the banner, the text and who read it. */
export function FeedAnnouncement({
  label,
  title,
  color,
  children,
  acknowledged,
  acknowledge
}: {
  label: string
  title: string | null
  color: string | null
  children: ReactNode
  acknowledged: {
    label: string
    people: { id: string; name: string; avatar: string | null }[]
  }
  /** Null for its author. */
  acknowledge: {
    label: string
    done: boolean
    disabled: boolean
    onClick: () => void
  } | null
}): ReactElement {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 1,
        py: 0.5
      }}
    >
      <FeedKindChip icon={CampaignIcon} label={label} />
      {(color !== null || title !== null) && (
        <Box sx={{ alignSelf: 'stretch' }}>
          {color ? (
            <AnnouncementBanner color={color} rounded>
              {title}
            </AnnouncementBanner>
          ) : (
            <FeedTitle large>{title}</FeedTitle>
          )}
        </Box>
      )}
      <Box sx={{ color: 'text.secondary' }}>{children}</Box>
      <Box
        sx={{
          alignSelf: 'stretch',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          minHeight: 24
        }}
      >
        <Box
          sx={{
            flex: '1 1 auto',
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            pl: 1
          }}
        >
          <FeedPeople people={acknowledged.people} />
          <Typography
            variant="caption"
            color="textSecondary"
            sx={{ fontWeight: 500, letterSpacing: 0.4, ml: 0.5 }}
          >
            {acknowledged.label}
          </Typography>
        </Box>
        {acknowledge && (
          <Button
            size="small"
            variant={acknowledge.done ? 'text' : 'contained'}
            disabled={acknowledge.disabled}
            aria-pressed={acknowledge.done}
            onClick={acknowledge.onClick}
            startIcon={acknowledge.done && <Icon icon={Check} size={14} />}
            sx={{
              minHeight: 24,
              px: 1,
              py: 0.5,
              borderRadius: '100px',
              fontSize: 11,
              lineHeight: '16px',
              letterSpacing: 0.5,
              '& .MuiButton-startIcon': { mr: 0.5 }
            }}
          >
            {acknowledge.label}
          </Button>
        )}
      </Box>
    </Box>
  )
}

export interface FeedPinnedItem {
  id: string
  author: string
  text: string
  openLabel: string
  onOpen: () => void
  unpin: { label: string; onClick: () => void } | null
}

/**
 * One banner for all pinned announcements. With several, it shows one at a
 * time with its position and a list of them all; opening one moves the banner
 * on to the next.
 */
export function FeedPinned({
  label,
  items,
  position,
  listLabel,
  unpinAll
}: {
  label: string
  items: FeedPinnedItem[]
  position: (index: number, total: number) => string
  listLabel: string
  unpinAll: { label: string; onClick: () => void } | null
}): ReactElement | null {
  const [shownId, setShownId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const several = items.length > 1
  // The list button unmounts once one pin is left: drop its stale anchor.
  if (anchor && !several) setAnchor(null)
  const shown = Math.max(
    0,
    items.findIndex(pinned => pinned.id === shownId)
  )
  const item = items[shown]
  if (!item) return null
  return (
    <Box
      component="section"
      aria-label={label}
      sx={{ flexShrink: 0, maxWidth: BUBBLE_WIDTH + 44, pt: 1 }}
    >
      <Box
        sx={theme => ({
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          minHeight: 42,
          pl: 2,
          pr: 1,
          py: 0.5,
          borderRadius: '12px',
          bgcolor: theme.alpha(theme.vars.palette.primary.main, 0.08)
        })}
      >
        <Box
          sx={{
            alignSelf: 'stretch',
            flexShrink: 0,
            width: 3,
            my: 0.25,
            borderRadius: 3,
            bgcolor: 'primary.main'
          }}
        />
        <ButtonBase
          aria-label={item.openLabel}
          onClick={() => {
            item.onOpen()
            setShownId(items[(shown + 1) % items.length]?.id ?? null)
          }}
          sx={{
            flex: '1 1 auto',
            minWidth: 0,
            alignSelf: 'stretch',
            flexDirection: 'column',
            alignItems: 'flex-start',
            justifyContent: 'center',
            px: 1,
            borderRadius: 1,
            textAlign: 'start'
          }}
        >
          <Typography
            component="span"
            variant="body2"
            noWrap
            sx={{
              display: 'block',
              maxWidth: '100%',
              lineHeight: '16px',
              color: several ? 'text.primary' : 'text.secondary'
            }}
          >
            {several ? position(shown + 1, items.length) : item.author}
          </Typography>
          <Typography
            component="span"
            variant="body2"
            noWrap
            sx={{
              display: 'block',
              maxWidth: '100%',
              lineHeight: '18px',
              color: several ? 'text.secondary' : 'text.primary'
            }}
          >
            {item.text}
          </Typography>
        </ButtonBase>
        {several ? (
          <Tooltip title={listLabel}>
            <IconButton
              size="small"
              aria-label={listLabel}
              aria-haspopup="dialog"
              aria-expanded={anchor !== null}
              onClick={event => {
                setAnchor(event.currentTarget)
              }}
              sx={{ color: 'text.secondary' }}
            >
              <Icon icon={ListMin} size={16} />
            </IconButton>
          </Tooltip>
        ) : (
          item.unpin && <PinnedUnpin unpin={item.unpin} />
        )}
      </Box>
      <Popover
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => {
          setAnchor(null)
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            role: 'dialog',
            'aria-label': listLabel,
            sx: {
              width: 360,
              maxWidth: 'calc(100vw - 32px)',
              borderRadius: '16px'
            }
          }
        }}
      >
        <List sx={{ maxHeight: 320, overflowY: 'auto', py: 1 }}>
          {items.map(pinned => (
            <Box
              component="li"
              key={pinned.id}
              sx={{ display: 'flex', alignItems: 'center', pr: 1 }}
            >
              <ListItemButton
                aria-label={pinned.openLabel}
                onClick={() => {
                  setAnchor(null)
                  setShownId(pinned.id)
                  pinned.onOpen()
                }}
                sx={{ minWidth: 0, py: 0.5 }}
              >
                <ListItemText
                  primary={pinned.author}
                  secondary={pinned.text}
                  slotProps={{
                    primary: {
                      noWrap: true,
                      variant: 'body2',
                      sx: { fontWeight: 500 }
                    },
                    secondary: { noWrap: true, variant: 'body2' }
                  }}
                />
              </ListItemButton>
              {pinned.unpin && <PinnedUnpin unpin={pinned.unpin} />}
            </Box>
          ))}
        </List>
        {unpinAll && (
          <>
            <Divider />
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', p: 1 }}>
              <Button
                size="small"
                onClick={() => {
                  setAnchor(null)
                  unpinAll.onClick()
                }}
              >
                {unpinAll.label}
              </Button>
            </Box>
          </>
        )}
      </Popover>
    </Box>
  )
}

function PinnedUnpin({
  unpin
}: {
  unpin: { label: string; onClick: () => void }
}): ReactElement {
  return (
    <Tooltip title={unpin.label}>
      <IconButton
        size="small"
        aria-label={unpin.label}
        onClick={unpin.onClick}
        sx={{ color: 'text.secondary' }}
      >
        <Icon icon={Cross} size={16} />
      </IconButton>
    </Tooltip>
  )
}

export interface MentionablePerson {
  id: string
  name: string
  email: string
  avatar: string | null
}

// "@" and what follows it up to the caret, at the start or after a space.
const MENTION_QUERY = /(?:^|\s)@([^\s@]*)$/
const MENTION_OPTIONS = 8

export function FeedComposer({
  label,
  sendLabel,
  emojiLabel,
  emojis,
  people,
  peopleLabel,
  value,
  onChange,
  onSend,
  disabled,
  tools
}: {
  label: string
  sendLabel: string
  emojiLabel: string
  emojis: string[]
  /** Who an "@" offers to mention. */
  people: MentionablePerson[]
  peopleLabel: string
  value: string
  onChange: (value: string) => void
  onSend: () => void
  disabled: boolean
  /** Before the field, such as the button that makes the message a poll. */
  tools?: ReactNode
}): ReactElement {
  const empty = value.trim() === ''
  // An on-screen keyboard has no Shift+Enter, so Return must break the line.
  const touch = useMediaQuery('(pointer: coarse)')
  const field = useRef<HTMLTextAreaElement>(null)
  const [form, setForm] = useState<HTMLFormElement | null>(null)
  const listId = useId()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [mention, setMention] = useState<{
    start: number
    query: string
  } | null>(null)
  const [active, setActive] = useState(0)
  const query = mention?.query.toLowerCase()
  const options =
    query === undefined
      ? []
      : people
          .filter(
            p =>
              p.name.toLowerCase().includes(query) ||
              p.email.toLowerCase().replace(/@.*/, '').includes(query)
          )
          .slice(0, MENTION_OPTIONS)
  const picking = options.length > 0
  const current = picking ? Math.min(active, options.length - 1) : -1
  useEffect(() => {
    document
      .getElementById(`${listId}-${String(current)}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [listId, current])
  // The caret stays after the new text.
  const replace = (start: number, end: number, text: string) => {
    const input = field.current
    onChange(value.slice(0, start) + text + value.slice(end))
    const caret = start + text.length
    requestAnimationFrame(() => {
      input?.focus()
      input?.setSelectionRange(caret, caret)
    })
  }
  const insert = (emoji: string) => {
    const input = field.current
    replace(
      input?.selectionStart ?? value.length,
      input?.selectionEnd ?? value.length,
      emoji
    )
  }
  const pick = (person: MentionablePerson) => {
    if (!mention) return
    const end = mention.start + 1 + mention.query.length
    replace(mention.start, end, `@${person.name} `)
    setMention(null)
  }
  const follow = (text: string, caret: number) => {
    const found = MENTION_QUERY.exec(text.slice(0, caret))?.[1]
    setMention(
      found === undefined
        ? null
        : { start: caret - found.length - 1, query: found }
    )
    setActive(0)
  }
  return (
    <Box
      component="form"
      ref={setForm}
      onSubmit={event => {
        event.preventDefault()
        if (!empty && !disabled) onSend()
      }}
      sx={{ display: 'flex', alignItems: 'flex-end', gap: 1, pt: 1 }}
    >
      {tools}
      <InputBase
        multiline
        maxRows={6}
        placeholder={label}
        inputRef={field}
        inputProps={{
          'aria-label': label,
          maxLength: 4000,
          enterKeyHint: touch ? 'enter' : 'send',
          'aria-autocomplete': 'list',
          'aria-controls': picking ? listId : undefined,
          'aria-activedescendant': picking
            ? `${listId}-${String(current)}`
            : undefined
        }}
        value={value}
        onChange={event => {
          onChange(event.target.value)
        }}
        // Typing and moving the caret both change what the "@" asks for.
        onSelect={event => {
          const input = event.target as HTMLTextAreaElement
          follow(input.value, input.selectionStart)
        }}
        onBlur={() => {
          setMention(null)
        }}
        onKeyDown={event => {
          const composing =
            event.nativeEvent.isComposing ||
            // Safari ends the composition before the Enter that commits it,
            // which then only shows as keyCode 229.
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            event.nativeEvent.keyCode === 229
          if (picking && !composing) {
            const count = options.length
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setActive(
                (current + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
              )
              return
            }
            const chosen = options[current]
            if ((event.key === 'Enter' || event.key === 'Tab') && chosen) {
              event.preventDefault()
              pick(chosen)
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setMention(null)
              return
            }
          }
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !touch &&
            !composing
          ) {
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
      <Popper
        open={picking}
        anchorEl={form}
        placement="top-start"
        modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}
        sx={{ zIndex: 'modal' }}
      >
        <Paper
          elevation={8}
          // The field keeps its focus and caret while the pointer picks or scrolls.
          onMouseDown={event => {
            event.preventDefault()
          }}
          sx={{ width: 280, maxWidth: 'calc(100vw - 32px)' }}
        >
          <List
            id={listId}
            role="listbox"
            aria-label={peopleLabel}
            dense
            sx={{ maxHeight: 280, overflowY: 'auto', py: 0.5 }}
          >
            {options.map((person, index) => (
              <ListItemButton
                key={person.id}
                component="li"
                role="option"
                id={`${listId}-${String(index)}`}
                aria-selected={index === current}
                selected={index === current}
                onClick={() => {
                  pick(person)
                }}
                sx={{ gap: 1.5 }}
              >
                <NameAvatar name={person.name} size="s" src={person.avatar} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" noWrap>
                    {person.name}
                  </Typography>
                  {person.name !== person.email && (
                    <Typography
                      variant="caption"
                      color="textSecondary"
                      component="div"
                      noWrap
                    >
                      {person.email}
                    </Typography>
                  )}
                </Box>
              </ListItemButton>
            ))}
          </List>
        </Paper>
      </Popper>
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
