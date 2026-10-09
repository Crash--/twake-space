import {
  Avatar,
  Box,
  Card,
  CardActionArea,
  Skeleton,
  Tooltip,
  Typography
} from '@linagora/twake-mui'
import { Icon, Pin } from '@linagora/twake-icons'
import { type ReactElement, type ReactNode } from 'react'

import { NameAvatar } from '@/ds/AppFrame'

const RADIUS = '20px'

// `maxColumns` caps the columns of a wide screen: no card is narrower than
// its share of the row, the 16px gaps left out, less a pixel so that
// rounding never drops a column.
export function CardGrid({
  maxColumns,
  children
}: {
  maxColumns?: number
  children: ReactNode
}): ReactElement {
  const min =
    maxColumns === undefined
      ? '200px'
      : `max(200px, calc((100% - ${String(maxColumns - 1)} * 16px) / ${String(maxColumns)} - 1px))`
  return (
    <Box
      component="ul"
      sx={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${min}, 1fr))`,
        gap: 2,
        m: 0,
        p: 0,
        listStyle: 'none'
      }}
    >
      {children}
    </Box>
  )
}

// `link` is the space's name as a link; it stretches over the whole card.
// `menu` sits above that stretch so it keeps its own click. `pinned` marks
// a card shown among the pinned ones with the mockup's pin, before the menu.
export function SpaceCard({
  avatar,
  link,
  description,
  members,
  menu,
  pinned = false
}: {
  avatar: ReactNode
  link: ReactNode
  description?: string
  members?: ReactNode
  menu?: ReactNode
  pinned?: boolean
}): ReactElement {
  return (
    <Card
      component="li"
      sx={{
        height: 192,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        p: 1.5,
        borderRadius: RADIUS,
        '&:hover': { boxShadow: 3 },
        '& a': { color: 'text.primary', textDecoration: 'none' },
        '& a::after': { content: '""', position: 'absolute', inset: 0 },
        '&:focus-within': {
          outline: 2,
          outlineColor: 'primary.main',
          outlineOffset: -2
        },
        '& a:focus-visible': { outline: 'none' }
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        {avatar}
        <Typography
          variant="h6"
          component="p"
          noWrap
          sx={{ flex: '1 1 auto', minWidth: 0 }}
        >
          {link}
        </Typography>
        {pinned && (
          <Box
            component="span"
            aria-hidden
            sx={{ display: 'flex', color: 'text.secondary' }}
          >
            <Icon icon={Pin} size={16} />
          </Box>
        )}
        {/* The menu button keeps its target but takes the row's 24px, its
            icon clear of the card's corner */}
        {menu && (
          <Box
            sx={{
              position: 'relative',
              zIndex: 1,
              m: -1.5,
              mr: 0,
              '& svg': { width: 10.667, height: 'auto' }
            }}
          >
            {menu}
          </Box>
        )}
      </Box>
      {description && (
        <Typography
          variant="subtitle3"
          component="p"
          color="textSecondary"
          sx={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden'
          }}
        >
          {description}
        </Typography>
      )}
      {members}
    </Card>
  )
}

export interface AvatarMember {
  id: string
  name: string
  src: string | null
}

// The first members of a space side by side, the rest counted. Each avatar
// has a ring of the card's color that cuts into the one before it.
// Hovering or focusing the count lists the members it stands for; it sits
// above a card's stretched link so the pointer reaches it.
export function MemberAvatars({
  members,
  max = 5,
  size = 's'
}: {
  members: AvatarMember[]
  max?: number
  size?: 's' | 'm'
}): ReactElement {
  const shown = members.length > max ? members.slice(0, max - 1) : members
  const hidden = members.slice(shown.length)
  const hiddenNames = hidden.map(member => member.name)

  return (
    <Box
      sx={{
        display: 'flex',
        '& .MuiAvatar-root': {
          ...(size === 's' && { typography: 'overline' }),
          boxShadow: theme => `0 0 0 2px ${theme.vars.palette.background.paper}`
        }
      }}
    >
      {shown.map(member => (
        <NameAvatar
          key={member.id}
          name={member.name}
          label={member.name}
          size={size}
          src={member.src}
        />
      ))}
      {hidden.length > 0 && (
        <Tooltip
          title={
            <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
              {hidden.map(member => (
                <li key={member.id}>{member.name}</li>
              ))}
            </Box>
          }
        >
          <Box
            component="span"
            tabIndex={0}
            aria-label={hiddenNames.join(', ')}
            sx={{ position: 'relative', zIndex: 1, display: 'flex' }}
          >
            <Avatar
              size={size}
              aria-hidden
              sx={{
                bgcolor: 'background.paper',
                color: 'text.secondary',
                border: 1,
                borderColor: 'divider'
              }}
            >
              +{hidden.length}
            </Avatar>
          </Box>
        </Tooltip>
      )}
    </Box>
  )
}

// The space home's cards, side by side down to a phone's width.
export function TileGrid({
  min,
  children
}: {
  min: number
  children: ReactNode
}): ReactElement {
  return (
    <Box
      component="ul"
      sx={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(min(${String(min)}px, 100%), 1fr))`,
        gap: 3,
        m: 0,
        p: 0,
        listStyle: 'none'
      }}
    >
      {children}
    </Box>
  )
}

// The mockup's grey outlined button, for the buttons of tiles and app cards
const GREY_BUTTONS = {
  '& .MuiButton-outlined': {
    px: 3,
    py: 1.25,
    color: 'text.primary',
    borderColor: 'divider'
  }
}

// The space home's tiles, the figures narrow beside a wide one.
export function TileRow({ children }: { children: ReactNode }): ReactElement {
  return (
    <Box
      component="ul"
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: { xs: 1.5, md: 3 },
        m: 0,
        p: 0,
        listStyle: 'none'
      }}
    >
      {children}
    </Box>
  )
}

// The figures share one line down to a phone's width; the wide tile takes the
// next line there.
export function Tile({
  wide = false,
  children
}: {
  wide?: boolean
  children: ReactNode
}): ReactElement {
  return (
    <Card
      component="li"
      sx={{
        flex: wide
          ? { xs: '1 1 100%', md: '3 1 360px' }
          : { xs: '1 1 0', md: '1 1 140px' },
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: wide ? 'flex-start' : 'center',
        flexWrap: 'wrap',
        gap: { xs: 1.5, md: 2 },
        '& > .MuiButton-root': { ml: 'auto' },
        minHeight: { xs: 64, md: 72 },
        py: 1,
        pl: wide ? { xs: 2, md: 3.5 } : 1,
        pr: 1,
        borderRadius: RADIUS,
        ...GREY_BUTTONS
      }}
    >
      {children}
    </Card>
  )
}

// A null value is still loading.
export function TileNumber({
  value,
  label
}: {
  value: ReactNode
  label: ReactNode
}): ReactElement {
  return (
    <Box
      aria-busy={value === null ? true : undefined}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center'
      }}
    >
      <Typography
        component="span"
        sx={{ fontSize: { xs: 24, md: 28 }, fontWeight: 700 }}
      >
        {value ?? <Skeleton width={56} />}
      </Typography>
      <Typography component="span" variant="caption" color="textSecondary">
        {label}
      </Typography>
    </Box>
  )
}

export function CalendarLeaf({
  weekday,
  day,
  month
}: {
  weekday: string
  day: string
  month: string
}): ReactElement {
  const small = { fontSize: 11, fontWeight: 400 }
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1.5
      }}
    >
      <Typography component="span" color="textSecondary" sx={small}>
        {weekday}
      </Typography>
      <Typography
        component="span"
        sx={{ fontSize: 32, fontWeight: 600, lineHeight: '42px' }}
      >
        {day}
      </Typography>
      <Typography component="span" color="textSecondary" sx={small}>
        {month}
      </Typography>
    </Box>
  )
}

// The mockup tilts the pictures of the apps a little.
export function AppArt({ src }: { src: string }): ReactElement {
  return (
    <Box
      component="img"
      src={src}
      alt=""
      sx={{ maxWidth: 1, transform: 'rotate(-5deg)' }}
    />
  )
}

// `count` is only what is shown ("3", "99+"): `nameLabel` names it for
// assistive technology.
export function AppCard({
  visual,
  icon,
  name,
  nameLabel,
  count,
  description,
  action
}: {
  visual: ReactNode
  icon: ReactNode
  name: string
  nameLabel?: string | undefined
  count: string | null
  description: string
  action: ReactNode
}): ReactElement {
  return (
    <Card
      component="li"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        minHeight: 156,
        p: 1.5,
        borderRadius: RADIUS,
        ...GREY_BUTTONS
      }}
    >
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
          alignSelf: 'stretch',
          width: 100,
          minHeight: 132,
          p: 1.5,
          borderRadius: RADIUS,
          bgcolor: 'action.hover',
          overflow: 'hidden'
        }}
      >
        {visual}
      </Box>
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 0.75,
          minWidth: 0,
          py: 1.5,
          pr: 1.5
        }}
      >
        <Typography
          variant="h6"
          component="h3"
          aria-label={nameLabel}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            fontWeight: 600
          }}
        >
          {icon}
          {name}
          {count !== null && (
            <Box
              component="span"
              aria-hidden
              sx={{
                minWidth: 16,
                px: '4.5px',
                borderRadius: '10000px',
                bgcolor: 'action.selected',
                fontSize: 11,
                fontWeight: 500,
                lineHeight: '16px',
                letterSpacing: 0.5,
                textAlign: 'center'
              }}
            >
              {count}
            </Box>
          )}
        </Typography>
        <Typography
          variant="body2"
          component="p"
          color="textSecondary"
          sx={{ fontSize: 12, lineHeight: 1.4 }}
        >
          {description}
        </Typography>
        <Box sx={{ mt: 0.75 }}>{action}</Box>
      </Box>
    </Card>
  )
}

export function CreateCard({
  icon,
  title,
  text,
  onClick
}: {
  icon: ReactNode
  title: string
  text: string
  onClick: () => void
}): ReactElement {
  return (
    <Card component="li" sx={{ height: 192, borderRadius: RADIUS }}>
      <CardActionArea
        onClick={onClick}
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 1.5,
          p: 1.5,
          textAlign: 'center'
        }}
      >
        <Box
          component="span"
          sx={{ display: 'flex', p: 1.5, color: 'primary.main' }}
        >
          {icon}
        </Box>
        <Typography variant="h5" component="span" noWrap sx={{ maxWidth: 1 }}>
          {title}
        </Typography>
        <Typography variant="subtitle3" component="span" color="textSecondary">
          {text}
        </Typography>
      </CardActionArea>
    </Card>
  )
}
