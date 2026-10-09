import { Icon, Magnifier, PersonAdd } from '@linagora/twake-icons'
import {
  Box,
  ButtonBase,
  IconButton,
  InputBase,
  Typography
} from '@linagora/twake-mui'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { NameAvatar } from '@/ds/AppFrame'
import { SidePanelIcon } from '@/ds/icons'

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
  // The panel covers the feed on a narrow screen: focus goes in when it opens
  // and back to the button that opened it when it closes.
  useEffect(() => {
    const opener = document.activeElement
    panel.current?.focus()
    return () => {
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [])
  const needle = query.trim().toLowerCase()
  const shown = members.filter(m => m.name.toLowerCase().includes(needle))
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
        sx={{
          m: 0,
          p: 0,
          listStyle: 'none',
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          rowGap: 2,
          columnGap: 1
        }}
      >
        {shown.map(member => (
          <Box
            component="li"
            key={member.id}
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
              title={member.name}
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
        ))}
      </Box>
    </Box>
  )
}
