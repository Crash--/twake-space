import {
  IconButton as MuiIconButton,
  Tooltip,
  type IconButtonProps
} from '@linagora/twake-mui'
import type { ReactElement } from 'react'

type LabeledIconButtonProps = Omit<IconButtonProps, 'aria-label'> & {
  /** Names the action: the accessible name and the tooltip on hover or focus. */
  label: string
}

export function IconButton({
  label,
  ...props
}: LabeledIconButtonProps): ReactElement {
  return (
    <Tooltip title={label}>
      <MuiIconButton aria-label={label} {...props} />
    </Tooltip>
  )
}
