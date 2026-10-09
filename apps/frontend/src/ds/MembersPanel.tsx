import { Icon, Magnifier, PersonAdd } from '@linagora/twake-icons'
import {
  Box,
  ButtonBase,
  IconButton,
  InputBase,
  Tooltip,
  Typography
} from '@linagora/twake-mui'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { NameAvatar } from '@/ds/AppFrame'
import { SidePanelIcon } from '@/ds/icons'

const COLUMNS = 4

export interface PanelMember {
  id: string
  name: string
  avatar?: string | null
}

/** The side panel of a space's people: search, add button, avatars in rows of four. */
export function MembersPanel({
  title,
  count,
  searchLabel,
  noneLabel,
  members,
  addLabel,
  onAdd,
  closeLabel,
  onClose
}: {
  title: string
  count: string
  searchLabel: string
  noneLabel: string
  members: PanelMember[]
  addLabel: string
  /** Absent for a person who cannot add members. */
  onAdd?: (() => void) | undefined
  closeLabel: string
  onClose: () => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const panel = useRef<HTMLElement>(null)
  // The panel covers the feed on a narrow screen: focus goes in when it
  // opens, and the toolbar takes it back when it closes.
  useEffect(() => {
    panel.current?.focus()
  }, [])
  const needle = query.trim().toLowerCase()
  const shown = members.filter(m => m.name.toLowerCase().includes(needle))
  // The list is one stop of the keyboard, on this member; the arrows, Home
  // and End move through it.
  const [active, setActive] = useState(0)
  const current = Math.min(active, shown.length - 1)
  const moveTo = (list: HTMLElement, key: string): boolean => {
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -COLUMNS,
      ArrowDown: COLUMNS,
      Home: -shown.length,
      End: shown.length
    }
    const by = step[key]
    if (by === undefined) return false
    const next = Math.max(0, Math.min(shown.length - 1, current + by))
    setActive(next)
    const item = list.children.item(next)
    if (item instanceof HTMLElement) item.focus()
    return true
  }
  return (
    <Box
      component="aside"
      ref={panel}
      tabIndex={-1}
      aria-label={title}
      onKeyDown={event => {
        if (event.key === 'Escape') onClose()
      }}
      sx={{
        // Over the feed on a narrow screen, beside it on a wide one.
        position: { xs: 'absolute', md: 'static' },
        inset: 0,
        zIndex: 2,
        flex: '0 0 300px',
        width: { xs: 'auto', md: 300 },
        bgcolor: 'background.paper',
        // In the same media query as the border, which resets its colour
        borderLeft: { md: 1 },
        borderLeftColor: { md: 'divider' },
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        overflowY: 'auto',
        outline: 'none'
      }}
    >
      <Box
        sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minHeight: 32 }}
      >
        <IconButton size="small" aria-label={closeLabel} onClick={onClose}>
          <Icon icon={SidePanelIcon} size={20} />
        </IconButton>
        <Typography variant="h6" component="h2" sx={{ flex: '1 1 auto' }}>
          {title}
        </Typography>
        <Typography variant="caption" color="textSecondary">
          {count}
        </Typography>
      </Box>
      <InputBase
        value={query}
        onChange={event => {
          setQuery(event.target.value)
        }}
        placeholder={searchLabel}
        inputProps={{ 'aria-label': searchLabel }}
        startAdornment={
          <Box sx={{ display: 'flex', mr: 1.5, color: 'text.secondary' }}>
            <Icon icon={Magnifier} size={16} />
          </Box>
        }
        sx={{
          flex: '0 0 auto',
          height: 40,
          px: 2,
          borderRadius: '20px',
          bgcolor: 'background.default',
          fontSize: 14
        }}
      />
      {onAdd && (
        <ButtonBase
          onClick={onAdd}
          sx={{
            justifyContent: 'flex-start',
            gap: 1.5,
            borderRadius: '28px',
            color: 'primary.main',
            fontSize: 14,
            fontWeight: 500
          }}
        >
          <Box
            sx={theme => ({
              width: 56,
              height: 56,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              bgcolor: theme.alpha(theme.vars.palette.primary.main, 0.16)
            })}
          >
            <Icon icon={PersonAdd} size={24} />
          </Box>
          {addLabel}
        </ButtonBase>
      )}
      {shown.length === 0 && (
        <Typography variant="body2" color="textSecondary">
          {noneLabel}
        </Typography>
      )}
      <Box
        component="ul"
        onKeyDown={event => {
          if (moveTo(event.currentTarget, event.key)) event.preventDefault()
        }}
        sx={{
          m: 0,
          p: 0,
          listStyle: 'none',
          display: 'grid',
          gridTemplateColumns: `repeat(${String(COLUMNS)}, 1fr)`,
          rowGap: 2,
          columnGap: 1
        }}
      >
        {shown.map((member, index) => (
          <Tooltip key={member.id} title={member.name}>
            <Box
              component="li"
              tabIndex={index === current ? 0 : -1}
              onFocus={() => {
                setActive(index)
              }}
              sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 0.75,
                minWidth: 0
              }}
            >
              <NameAvatar
                name={member.name}
                size={48}
                src={member.avatar ?? null}
              />
              <Typography
                variant="caption"
                noWrap
                sx={{
                  maxWidth: '100%',
                  fontSize: 11,
                  lineHeight: '16px',
                  letterSpacing: 0.5
                }}
              >
                {member.name.split(' ')[0]}
              </Typography>
            </Box>
          </Tooltip>
        ))}
      </Box>
    </Box>
  )
}
