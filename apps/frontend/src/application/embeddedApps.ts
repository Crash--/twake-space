import {
  embedUrl,
  loadMessage,
  navigateMessage,
  parseAppMessage,
  pathBelow,
  type LoadMessage,
  type NavigateMessage
} from '@linagora/twake-embed'

import type { ResourceKind, Space } from '@/application/spaces'

export { embedUrl, loadMessage, navigateMessage, pathBelow }

// The apps TwakeSpace frames in a tab of a space (ADR 010). One frame per
// app for the whole session: another space's resource is shown in the same
// frame with a `load` message, and TwakeSpace alone writes the browser
// history.
export type EmbeddedApp = 'chat' | 'tasks' | 'drive' | 'mail' | 'calendar'

export interface EmbeddedAppSpec {
  app: EmbeddedApp
  resource: ResourceKind
  // The app's embed route for a resource
  embedPath: (resourceId: string) => string
  // The empty page of the app its dialogs and windows go onto, if it has one
  overlayPath: string | null
  // Permissions of this app alone, beyond the clipboard (Chat's calls)
  allow?: string
  // Whether the app may take the whole page (`twake-embed:fill-page`)
  canFillPage?: boolean
}

export const EMBEDDED_APPS: Record<EmbeddedApp, EmbeddedAppSpec> = {
  // Twake Chat shows the conversation of the space's Matrix space. Its calls
  // take the camera, the microphone and the screen, and the whole page
  // while they last.
  chat: {
    app: 'chat',
    resource: 'matrix_space',
    embedPath: id => `/embed/rooms/${encodeURIComponent(id)}`,
    overlayPath: '/embed/overlay.html',
    allow: 'camera; microphone; display-capture; autoplay',
    canFillPage: true
  },
  tasks: {
    app: 'tasks',
    resource: 'project',
    embedPath: id => `/embed/projects/${id}`,
    overlayPath: '/embed/overlay.html'
  },
  // Twake Drive's embed of a shared drive, opened from its sharing id alone.
  // Drive routes in the hash: cozy-stack serves no other path than its files.
  drive: {
    app: 'drive',
    resource: 'drive',
    embedPath: id => `/#/embed/sharings/${encodeURIComponent(id)}`,
    overlayPath: '/embed/overlay.html'
  },
  mail: {
    app: 'mail',
    resource: 'mailbox',
    embedPath: id => `/embed/team-mailboxes/${encodeURIComponent(id)}`,
    overlayPath: '/embed/overlay.html'
  },
  // Twake Calendar shows the team calendar of the space, and draws its
  // dialogs on its overlay (twake-calendar-frontend#1539).
  calendar: {
    app: 'calendar',
    resource: 'calendar',
    embedPath: id => `/embed/calendars/${encodeURIComponent(id)}`,
    overlayPath: '/embed/overlay.html'
  }
}

export function embeddedApp(tab: string | undefined): EmbeddedAppSpec | null {
  return tab !== undefined && Object.hasOwn(EMBEDDED_APPS, tab)
    ? EMBEDDED_APPS[tab as EmbeddedApp]
    : null
}

export function tabPath(spaceId: string, app: EmbeddedApp): string {
  return `/spaces/${spaceId}/${app}`
}

// The space whose resource for the app is this one (the resource of a
// notification): one frame of the app serves every space. Null when none
// of the spaces known has it.
export function spaceOfResource(
  spaces: readonly Pick<Space, 'id' | 'resources'>[],
  app: EmbeddedApp,
  resourceId: string
): string | null {
  return (
    spaces.find(space =>
      space.resources.some(
        resource =>
          resource.kind === EMBEDDED_APPS[app].resource &&
          resource.id === resourceId
      )
    )?.id ?? null
  )
}

// What a frame tells TwakeSpace about its URL. In the embed dialect the app
// reports a path below its route and says whether it replaced its URL. The
// legacy dialect (Tasks' `twake-tasks:path`, cozy-external-bridge's
// `updateHistory`) reports the whole frame path and never adds entries on
// TwakeSpace's side: such a frame is replaced, not told to `load`.
export interface EmbedPath {
  dialect: 'embed' | 'legacy'
  resourceId: string | null
  path: string
  replace: boolean
}

function isRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null
}

export function parseEmbedPath(
  data: unknown,
  embedPath: string
): EmbedPath | null {
  const message = parseAppMessage(data)
  if (message?.type === 'twake-embed:path') {
    const { resourceId, path, replace } = message
    return { dialect: 'embed', resourceId, path, replace }
  }
  if (
    isRecord(data) &&
    data.type === 'twake-tasks:path' &&
    typeof data.path === 'string'
  ) {
    return legacyEmbedPath(data.path, embedPath)
  }
  return null
}

export function legacyEmbedPath(
  framePath: string,
  embedPath: string
): EmbedPath | null {
  const path = pathBelow(embedPath, framePath)
  return path === null
    ? null
    : { dialect: 'legacy', resourceId: null, path, replace: true }
}

export function isLoginRequired(data: unknown): boolean {
  return parseAppMessage(data)?.type === 'twake-embed:login-required'
}

// What TwakeSpace knows of a frame: the resource and the path it shows.
export interface FrameState {
  // Changes to replace the iframe element
  key: number
  src: string
  // The space of the resource, which a floating frame keeps
  spaceId: string
  resourceId: string
  path: string
  dialect: EmbedPath['dialect'] | null
  // The last message for the frame, sent once
  pending: EmbedMessage | null
  // The address TwakeSpace was at when it wrote the frame's path: a data
  // router applies the new address in a transition, so until it shows the
  // frame is not brought to the old one
  writtenFrom: string | null
}

export type EmbedMessage = LoadMessage | NavigateMessage

export interface ShownApp {
  app: EmbeddedApp
  spaceId: string
  resourceId: string
  path: string
}

// The app moved to another origin, as Chat does when its organization gets
// its own: its frame cannot follow with a message.
function moved(frame: FrameState, appUrl: string): boolean {
  return new URL(frame.src).origin !== new URL(appUrl).origin
}

export type Reconciliation =
  | { kind: 'create'; src: string }
  | { kind: 'replace'; src: string }
  | { kind: 'load' }
  | { kind: 'navigate' }
  | { kind: 'adopt'; to: string }
  | { kind: 'none' }

// What brings a frame to what the address shows. `popped` tells a Back or
// Forward from a tab change: on a tab change the bare tab path takes the
// path the frame kept while hidden, on a Back it means the embed route.
export function reconcile(
  frame: FrameState | null,
  shown: ShownApp,
  spec: EmbeddedAppSpec,
  appUrl: string,
  popped: boolean,
  here: string
): Reconciliation {
  if (frame?.writtenFrom === here) return { kind: 'none' }
  const src = embedUrl(appUrl, spec.embedPath(shown.resourceId), shown.path)
  if (frame === null || moved(frame, appUrl)) {
    return src === null
      ? { kind: 'adopt', to: tabPath(shown.spaceId, shown.app) }
      : { kind: frame === null ? 'create' : 'replace', src }
  }
  if (frame.resourceId !== shown.resourceId) {
    if (frame.dialect === 'embed') return { kind: 'load' }
    return src === null
      ? { kind: 'adopt', to: tabPath(shown.spaceId, shown.app) }
      : { kind: 'replace', src }
  }
  if (frame.path === shown.path) return { kind: 'none' }
  if (shown.path === '' && !popped) {
    return { kind: 'adopt', to: tabPath(shown.spaceId, shown.app) + frame.path }
  }
  if (frame.dialect === 'embed' && src !== null) return { kind: 'navigate' }
  return { kind: 'none' }
}

// What brings a frame the address does not show to its space's resource:
// the other tabs' frames stay mounted so that every app can report its
// counts, and follow the space shown. There is no address to follow: a
// hidden frame is never navigated, never adopted, and never writes the
// history. Its path starts at the app's embed route.
export type HiddenReconciliation = Extract<
  Reconciliation,
  { kind: 'create' | 'replace' | 'load' | 'none' }
>

export function reconcileHidden(
  frame: FrameState | null,
  resourceId: string,
  spec: EmbeddedAppSpec,
  appUrl: string
): HiddenReconciliation {
  const stays = frame !== null && !moved(frame, appUrl)
  if (stays && frame.resourceId === resourceId) return { kind: 'none' }
  if (stays && frame.dialect === 'embed') return { kind: 'load' }
  const src = embedUrl(appUrl, spec.embedPath(resourceId), '')
  if (src === null) return { kind: 'none' }
  return { kind: frame === null ? 'create' : 'replace', src }
}
