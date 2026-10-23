import { dialogActionsClasses, dialogContentClasses } from '@linagora/twake-mui'
import type { ThemeOptions } from '@mui/material/styles'
import type { CSSProperties } from 'react'

// What the Twake theme lacks for Space and the mockups draw. Each belongs in
// twake-mui in time.
declare module '@mui/material/styles' {
  interface Theme {
    space: SpaceTokens
  }
  interface ThemeOptions {
    space?: SpaceTokens
  }
  interface TypographyVariants {
    subtitle3: CSSProperties
  }
  interface TypographyVariantsOptions {
    subtitle3?: CSSProperties
  }
}

declare module '@mui/material/Typography' {
  interface TypographyPropsVariantOverrides {
    subtitle3: true
  }
}

interface PageBackground {
  base: string
  layers: string[]
}

export interface SpaceTokens {
  // The page behind the panels, in each color scheme
  page: { light: PageBackground; dark: PageBackground }
  // The mockup's elevation 3, of the menus that open over the feed
  menuShadow: string
  // The size line under a file's name
  fileMeta: { light: string; dark: string }
  // The count beside a reaction
  reactionCount: { light: string; dark: string }
  // The color of each app that sends feed cards: its avatar, and the band of
  // a calendar day
  appColors: Record<'tasks' | 'mail' | 'calendar' | 'drive', string>
}

export const spaceThemeOptions = {
  typography: {
    subtitle3: {
      fontSize: 12,
      fontWeight: 600,
      lineHeight: '18.4px',
      letterSpacing: '0.25px'
    }
  },
  space: {
    appColors: {
      tasks: '#4caf50',
      mail: '#0a84ff',
      calendar: '#f67e35',
      drive: '#5c9ce6'
    },
    reactionCount: { light: '#69666a', dark: '#c9c5ca' },
    fileMeta: { light: '#5f6b78', dark: '#c4ced8' },
    menuShadow:
      '0px 1px 3px 0px rgba(0, 0, 0, 0.3), 0px 4px 8px 3px rgba(0, 0, 0, 0.15)',
    page: {
      // Pink from the top left corner, green to the bottom right, on blue
      light: {
        base: '#dde9fe',
        layers: [
          'radial-gradient(ellipse 66% 110% at 0% 0%, #fbefef 30%, transparent 100%)',
          'radial-gradient(ellipse 100% 55% at 100% 100%, #eaf7f0 8%, transparent 100%)'
        ]
      },
      dark: {
        base: '#1a3146',
        layers: [
          'radial-gradient(at 0% 0%, #363648 0px, transparent 55%)',
          'radial-gradient(at 100% 0%, #193745 0px, transparent 55%)',
          'radial-gradient(at 100% 100%, #2e3648 0px, transparent 55%)'
        ]
      }
    }
  },
  components: {
    MuiDialog: {
      styleOverrides: {
        // The Twake content leaves its bottom margin to the actions below it:
        // without actions, the content keeps the margin of its sides.
        container: ({ theme }) => ({
          [`& .${dialogContentClasses.root}:not(:has(~ .${dialogActionsClasses.root}))`]:
            {
              paddingBottom: 32,
              [theme.breakpoints.down('md')]: { paddingBottom: 16 }
            }
        })
      }
    }
  }
} satisfies ThemeOptions
