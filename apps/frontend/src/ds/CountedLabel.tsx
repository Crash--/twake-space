import { Badge, badgeClasses, styled } from '@linagora/twake-mui'
import type { ReactElement, ReactNode } from 'react'

// A tab lays its content out in a column, so the label and its count share a
// row of their own, the count at the label's top right corner.
const Row = styled('span')({
  display: 'inline-flex',
  alignItems: 'flex-start'
})

// The badge sits after the label instead of over its corner, which the
// scrollable tabs would clip. It is no taller than the label's line, so a
// count never changes the height of the row. Neutral grey like the sidebar's
// badge, which twake-mui does not export.
const Count = styled(Badge)(({ theme }) => ({
  marginLeft: theme.spacing(0.5),
  [`& .${badgeClasses.badge}`]: {
    position: 'static',
    transform: 'none',
    border: 'none',
    backgroundColor: theme.vars.palette.action.selected,
    color: theme.vars.palette.text.primary,
    fontWeight: 500
  }
}))

// A label with its count after it; no count, no badge. `count` is what is
// shown ("3", "99+"): the caller names the count for assistive technology.
export function CountedLabel({
  label,
  count
}: {
  label: ReactNode
  count: string | null
}): ReactElement {
  return (
    <Row>
      {label}
      {count !== null && <Count badgeContent={count} />}
    </Row>
  )
}
