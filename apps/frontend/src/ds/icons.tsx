import type { ReactElement, SVGAttributes } from 'react'

// twake-icons' home.svg in the 24px frame of the mockup's tab. Its Home
// component still draws an older house in fixed greys.
export function Home(props: SVGAttributes<SVGSVGElement>): ReactElement {
  return (
    <svg viewBox="-2 -3 24 24" {...props}>
      <path d="m10 2.69 5 4.5V15h-2V9H7v6H5V7.19l5-4.5ZM10 0 0 9h3v8h6v-6h2v6h6V9h3L10 0Z" />
    </svg>
  )
}

// Twake's Plus is bolder and drawn for a 14px box; the mockups use 2px arms.
export function AddIcon(props: SVGAttributes<SVGSVGElement>): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M20 13H13V20H11V13H4V11H11V4H13V11H20V13Z" />
    </svg>
  )
}

// Twake's Stats glyph sits small in its frame; this one is the chat's poll.
export function PollIcon(props: SVGAttributes<SVGSVGElement>): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z" />
    </svg>
  )
}

// The chat's « + » of the composer, in a circle.
export function AddCircleIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M13 7h-2v4H7v2h4v4h2v-4h4v-2h-4V7zm-1-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" />
    </svg>
  )
}

export function ThumbsUpDownIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12 6c0-.55-.45-1-1-1H5.82l.66-3.18.02-.23c0-.31-.13-.59-.33-.8L5.38 0 .44 4.94C.17 5.21 0 5.59 0 6v6.5c0 .83.67 1.5 1.5 1.5h6.75c.62 0 1.15-.38 1.38-.91l2.26-5.29c.07-.17.11-.36.11-.55V6zm10.5 4h-6.75c-.62 0-1.15.38-1.38.91l-2.26 5.29c-.07.17-.11.36-.11.55V18c0 .55.45 1 1 1h5.18l-.66 3.18-.02.24c0 .31.13.59.33.8l.79.78 4.94-4.94c.27-.27.44-.65.44-1.06v-6.5c0-.83-.67-1.5-1.5-1.5z" />
    </svg>
  )
}

export function CampaignIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M18 11v2h4v-2h-4zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.65 3.2-2.4zM4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9H4zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34z" />
    </svg>
  )
}

// Twake's calendar is a heavy 48px glyph; the mockups use a 2px stroke.
export function CalendarIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="0 0 16 16" {...props}>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d="M5.333 1.333v2.666M10.667 1.333v2.666M2 6.667h12M2 6.667v6.666c0 .737.597 1.334 1.333 1.334h9.334c.736 0 1.333-.597 1.333-1.334V6.667M2 6.667V4c0-.737.597-1.334 1.333-1.334h9.334C13.403 2.666 14 3.263 14 4v2.667"
      />
    </svg>
  )
}

export function SpaceCubeIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="0 0 16 16" {...props}>
      <path d="M14.6016 3.72457C14.6232 3.71199 14.6411 3.69397 14.6535 3.67233C14.6659 3.65068 14.6725 3.62615 14.6725 3.60119C14.6725 3.57622 14.6659 3.55169 14.6535 3.53004C14.6411 3.5084 14.6232 3.49039 14.6016 3.4778L9.14715 0.30883C8.79815 0.106536 8.40191 0 7.99851 0C7.59512 0 7.19888 0.106536 6.84988 0.30883L1.39648 3.4778C1.37492 3.49039 1.35703 3.5084 1.3446 3.53004C1.33216 3.55169 1.32562 3.57622 1.32562 3.60119C1.32562 3.62615 1.33216 3.65068 1.3446 3.67233C1.35703 3.69397 1.37492 3.71199 1.39648 3.72457L7.92727 7.56633C7.94924 7.57927 7.97427 7.58609 7.99976 7.58609C8.02526 7.58609 8.05029 7.57927 8.07226 7.56633L14.6016 3.72457ZM0.785114 4.69626C0.763331 4.68368 0.738613 4.67708 0.71346 4.67712C0.688307 4.67716 0.663611 4.68384 0.641868 4.69649C0.620126 4.70913 0.602108 4.7273 0.589638 4.74914C0.577167 4.77099 0.570686 4.79573 0.570849 4.82089V11.0306C0.571388 11.3299 0.650259 11.6238 0.799617 11.8831C0.948975 12.1424 1.16362 12.3581 1.42219 12.5087L7.21305 15.9809C7.23476 15.9934 7.25938 16 7.28444 16C7.3095 16 7.33412 15.9934 7.35583 15.9809C7.37755 15.9684 7.39558 15.9504 7.40813 15.9287C7.42067 15.907 7.42729 15.8824 7.42732 15.8573V8.65265C7.42729 8.6276 7.42068 8.603 7.40815 8.58132C7.39561 8.55963 7.37759 8.54162 7.3559 8.52909L0.785114 4.69626ZM8.57006 8.67765V15.8555C8.57009 15.8806 8.57671 15.9052 8.58926 15.9269C8.6018 15.9486 8.61984 15.9666 8.64155 15.9791C8.66326 15.9916 8.68788 15.9982 8.71294 15.9982C8.73801 15.9982 8.76263 15.9916 8.78433 15.9791L14.5748 12.5069C14.8332 12.3565 15.0478 12.1411 15.1972 11.8821C15.3466 11.6232 15.4256 11.3296 15.4265 11.0306V4.82089C15.4264 4.79586 15.4198 4.77129 15.4072 4.74964C15.3946 4.728 15.3766 4.71004 15.3549 4.69756C15.3332 4.68508 15.3086 4.67852 15.2836 4.67855C15.2585 4.67857 15.2339 4.68517 15.2123 4.69769L8.64149 8.55445C8.61984 8.56694 8.60186 8.5849 8.58933 8.60652C8.5768 8.62813 8.57015 8.65266 8.57006 8.67765Z" />
    </svg>
  )
}

// twake-icons has no video camera.
export function Videocam(props: SVGAttributes<SVGSVGElement>): ReactElement {
  return (
    <svg viewBox="0 0 24 24" {...props}>
      <path d="M15 8v8H5V8h10m1-2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4V7a1 1 0 0 0-1-1z" />
    </svg>
  )
}

// The header's mockup icons are drawn in a 20px frame. They show its middle
// 16px so they sit in the 16px slot of the header's buttons beside Twake's
// glyphs, and spill into the padding at the mockup's size.

// Material Symbols' videocam, as in the mockup's header.
export function VideocamSymbolIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="2 2 16 16" overflow="visible" {...props}>
      <path d="M3.333 16.667q-.687 0-1.177-.49A1.6 1.6 0 0 1 1.666 15V5q0-.687.49-1.177t1.177-.49h10q.688 0 1.177.49T15 5v3.75l2.625-2.625q.209-.209.458-.104.25.104.25.396v7.166q0 .292-.25.396t-.458-.104L15 11.25V15q0 .687-.49 1.177-.489.49-1.177.49zm0-1.667h10V5h-10z" />
    </svg>
  )
}

// Material Symbols' open_in_full and close_fullscreen, at the weight of the
// header's videocam: the content takes the page and gives it back. Twake's
// Expand and Narrow read as a row's height.
export function OpenInFullIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="0 -960 960 960" {...props}>
      <path d="M105.87-105.87v-319.22h79.22v183.87l533.69-533.69H534.91v-79.79H854.7v319.79h-79.79v-183.87L241.22-185.09h183.87v79.22H105.87Z" />
    </svg>
  )
}

export function CloseFullscreenIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="0 -960 960 960" {...props}>
      <path d="m121.43-65.87-55.56-55.56 279.35-279.35H145.87V-480H480v334.13h-79.22v-199.35L121.43-65.87ZM480-480v-334.7h79.78v199.35L839.13-894.7l55.57 55.57-279.35 279.35H814.7V-480H480Z" />
    </svg>
  )
}

// Material's group_add, as in the mockup's header: Twake's PersonAdd is one
// filled person.
export function GroupAddIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="2 2 16 16" overflow="visible" {...props}>
      <path d="M18.333 7.5V5.833h-1.666V7.5H15v1.667h1.667v1.666h1.666V9.167H20V7.5zM6.667 10a3.332 3.332 0 1 0 0-6.667 3.332 3.332 0 1 0 0 6.667m0-5c.916 0 1.666.75 1.666 1.667 0 .916-.75 1.666-1.666 1.666C5.75 8.333 5 7.583 5 6.667 5 5.75 5.75 5 6.667 5M6.667 10.833C4.442 10.833 0 11.95 0 14.167v2.5h13.333v-2.5c0-2.217-4.441-3.334-6.666-3.334m5 4.167h-10v-.825c.166-.6 2.75-1.675 5-1.675s4.833 1.075 5 1.667zM10.425 3.375a5 5 0 0 1 1.242 3.292 5 5 0 0 1-1.242 3.291 3.32 3.32 0 0 0 2.908-3.291c0-1.7-1.275-3.084-2.908-3.292M13.775 11.525c.742.692 1.225 1.558 1.225 2.642v2.5h1.667v-2.5c0-1.209-1.325-2.092-2.892-2.642" />
    </svg>
  )
}

// Material's keyboard_arrow_down, as in the mockup's filter chip: Twake's
// Down is an arrow.
export function ChevronDownIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z" />
    </svg>
  )
}

// The mockup's more_vert: three dots, one over the other. Twake's Dots lie flat.
export function MoreVertIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" {...props}>
      <path d="M8 5.333A1.333 1.333 0 1 0 8 2.667a1.333 1.333 0 0 0 0 2.666Zm0 1.334a1.333 1.333 0 1 0 0 2.666 1.333 1.333 0 0 0 0-2.666Zm0 4a1.333 1.333 0 1 0 0 2.666 1.333 1.333 0 0 0 0-2.666Z" />
    </svg>
  )
}

// A smiling face with a plus: the button that adds a reaction.
export function AddReactionIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="0 0 20 20" {...props}>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M17.2 9.6A7.25 7.25 0 1 1 10.4 2.8M7 11.9a3.9 3.9 0 0 0 6 0M14.5 1.5v4M12.5 3.5h4"
      />
      <circle cx="7.2" cy="8.4" r="0.9" fill="currentColor" />
      <circle cx="12.6" cy="9.6" r="0.9" fill="currentColor" />
    </svg>
  )
}

// Material's tag_faces, the mockup's emoji button: a smiling face.
export function EmojiIcon(props: SVGAttributes<SVGSVGElement>): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2ZM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8Zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5Zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11Zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5Z" />
    </svg>
  )
}

// The mockup's collapse menu: a window with a narrow column on its left, the
// button that shows and hides the members panel.
export function SidePanelIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="0 0 20 20" {...props}>
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M6.5 3h7A3.5 3.5 0 0 1 17 6.5v7a3.5 3.5 0 0 1-3.5 3.5h-7A3.5 3.5 0 0 1 3 13.5v-7A3.5 3.5 0 0 1 6.5 3ZM8.5 3v14M5.6 7.5h.01M5.6 10h.01"
      />
    </svg>
  )
}

// Material's open_in_new: a 12px glyph in a 16px box. Twake's Openwith fills
// the whole box, so it reads bigger and bolder next to the label.
export function OpenInNewIcon(
  props: SVGAttributes<SVGSVGElement>
): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7ZM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7Z" />
    </svg>
  )
}

// Material's folder, outlined, with the same 2px margin as OpenInNewIcon.
export function FolderIcon(props: SVGAttributes<SVGSVGElement>): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2Zm0 12H4V8h16v10Z" />
    </svg>
  )
}
