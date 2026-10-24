# Architecture

How Twake Space fits among the Twake apps: what each side owns, and how they talk.

## Terms

- Space: a team's workspace. ldap-rest holds it and its members.
- App: Twake Chat, Tasks, Drive, Mail or Calendar. Each one prepares a resource for every space.
- Resource: what an app prepared for a space, such as a Matrix space, a Tasks project or a team mailbox. The space's tab for that app shows it.
- Platform: each person's Twake Workplace instance, which serves the top bar, their Drive and their assistant.
- Copy: the backend's Postgres copy of spaces, members and resources, built from events and repaired once a night from ldap-rest.

## The pieces

```mermaid
flowchart LR
  subgraph browser[Browser]
    fe[Twake Space frontend]
    frames["App frames<br>Chat, Tasks, Drive, Mail, Calendar"]
    meet[Meet call window]
    bar[Platform top bar]
    assistant[Twake Assistant frame]
  end
  be[Twake Space backend]
  pg[(Postgres)]
  mq[(RabbitMQ)]
  redis[(Redis, optional)]
  ldap[ldap-rest]
  sso[SSO]
  apps[Apps' backends]
  settings[Common settings]
  platform[Platform]
  harness[Twake Harness]

  fe -->|HTTP, SSE| be
  fe <-->|twake-embed messages| frames
  fe --> meet
  fe --> bar
  fe --> assistant
  bar & assistant --> platform
  fe -->|approve, refuse| harness
  fe & frames -->|sign in| sso
  be --> pg
  be -.->|rate limit counts| redis
  be -->|reads, space writes, nightly reconciliation| ldap
  be -->|introspection, userinfo| sso
  ldap -->|space, b2b events| mq
  apps -->|activity events| mq
  settings -->|settings events| mq
  mq --> be
  be -->|meeting requests, drive commands, mentions| mq
  mq --> apps
  sso -->|back-channel logout| be
  harness -->|suggestions, API token| be
```

- The frontend draws the shell, the home, the feed and the members, and frames each app in its tab. It never calls an app's backend.
- The backend serves the spaces, the feed, the notifications and the API tokens. It never calls an app either: apps reach it through RabbitMQ.
- Postgres holds all the backend's state. Redis, when set, holds only the rate limit counts, shared by every replica; without it each replica counts in memory.
- Other servers call the backend's HTTP API in two cases only: the SSO for back-channel logout, and API token holders, Twake Harness among them.

## Who owns what

- ldap-rest owns the organizations, people, groups, technical accounts and spaces with their members and roles. A space write goes to ldap-rest first, and its event updates every app.
- Each app owns its resources and what is in them: messages, tasks, files, mail and events.
- Twake Space owns its copy, the feed (cards, posts, reactions), the notifications, each space's description, color, apps, banner and state (active, archived, in the Bin), and each person's pins and visits.
- The SSO owns the sessions. Common settings owns each person's language, theme, timezone, avatar and display name.

Archiving a space or moving it to the Bin stays in Twake Space: ldap-rest and the apps still hold it. Only a deletion from the Bin reaches ldap-rest, and the apps then hear `twake.space.deleted`.

## Signing in

```mermaid
sequenceDiagram
  participant FE as Frontend
  participant SSO
  participant P as Platform
  participant BE as Backend
  FE->>SSO: OIDC code flow (twakespace client)
  SSO-->>FE: access token, id token with workplaceFqdn
  FE->>BE: Authorization: Bearer <access token>
  BE->>SSO: introspection and userinfo, cached 60 s
  FE->>P: exchange the id token (twake-sdk)
  P-->>FE: platform token for the top bar and the assistant
```

- The frontend holds the tokens in the browser. The backend takes bearer tokens only, no cookies.
- The `workplaceFqdn` claim names the person's platform. Without it the app runs without the top bar, the assistant and Drive.
- Each app in a frame signs in on its own with the same SSO, silently. When it cannot, it posts `twake-embed:login-required` and the frontend signs in again.
- The SSO calls the backend's back-channel logout, which closes the session's live streams on every replica.

[HTTP API](api.md#authentication) has the details, and API tokens.

## Creating a space

```mermaid
sequenceDiagram
  participant FE as Frontend
  participant BE as Backend
  participant L as ldap-rest
  participant MQ as RabbitMQ
  participant A as Each app
  FE->>BE: POST /spaces
  BE->>L: create the space, the caller as admin
  BE->>BE: copy it at once
  BE-->>FE: 201
  L->>MQ: twake.space.created (space exchange)
  MQ->>A: twake.space.created
  A->>A: prepare the resource
  A->>MQ: com.twake.<app>.space.provisioned.v1 (activity exchange)
  MQ->>BE: provisioned
  BE->>BE: store the resource id
  BE-->>FE: live event spaces
  FE->>BE: GET /spaces/:id
  Note over FE: the app's tab is ready
```

- Drive is the exception: it answers a `drive.org_drive.ensure` command for the space with `com.twake.drive.org_drive.ready.v1`, which carries the drive id ([ADR 009](https://github.com/linagora/cozy-stack/blob/addefe293/docs/adr/009-adr-org-drive-provisioning.md)).
- Members, groups and renames go the same way: ldap-rest first, then its event to the backend and every app.
- Once a night the backend reads each organization's spaces, members and groups from ldap-rest and repairs what lost events left in the copy.
- A tab shows as being prepared until its resource arrives, and as stalled after 2 minutes. Chat also needs the organization's homeserver.
- `SPACE_APPS` and the space's own `apps` decide which tabs exist. Chat and mail also depend on the organization: the chat control plane and `dns.validated` tell.

[Events](events.md) covers every event the backend handles.

## Apps in the tabs

Each app is framed once for the whole session, at its embed route for the space's resource, and kept while the person moves between spaces and tabs. The contract is [`@linagora/twake-embed`](https://github.com/linagora/twake-libs/tree/427b0508d87480dc10f972be9ef6bd7175ad853d/packages/twake-embed) ([ADR 010](https://github.com/linagora/twake-space-architecture/blob/bbcb1ffe03e5452c99325662f247dadba8fecb7c/ADR010.md), [metadata](https://github.com/linagora/twake-space-architecture/blob/f11d90c122393d20d236eca5017c25fcc338e5dd/ADR010.md)).

- Chat: `<space's chatUrl or CHAT_URL>/embed/rooms/<Matrix space id>`
- Tasks: `TASKS_URL/embed/projects/<project id>`
- Drive: `<person's Drive>/#/embed/sharings/<sharing id>`, on each person's own platform
- Mail: `MAIL_URL/embed/team-mailboxes/<mailbox id>`
- Calendar: `CALENDAR_URL/embed/calendars/<calendar id>`

```mermaid
sequenceDiagram
  participant FE as Frontend
  participant F as App frame
  participant O as App overlay
  F->>FE: twake-embed:ready
  FE->>F: twake-embed:hello
  FE->>F: load (another space's resource) or navigate (Back, a link)
  F->>FE: twake-embed:path (its URL changed)
  F->>FE: badges, metadata (counts for every resource it knows)
  F->>FE: notification, pip, fill-page, login-required
  F->>O: dialogs and docked windows
  F->>FE: overlay-region
```

- The frontend owns the browser history. A frame never adds an entry: it reports its path, and the frontend moves it with `load` and `navigate`.
- Hidden frames stay loaded and follow the space shown, so every app keeps reporting its counts. The tabs and the list of spaces show them.
- An app draws its dialogs on its overlay, `<app>/embed/overlay.html`, an empty page of its own origin over the whole page.
- The browser shows the system notifications an app asks for, since a frame cannot. A click opens the app at the resource.
- Chat may take the whole page during a call (`fill-page`). Any app may ask to open a Meet room in the call window (`pip`): only rooms of `MEET_URL` open.
- Mail still talks through cozy-external-bridge, and Tasks may send its older `twake-tasks:path`. The frontend accepts both.
- Each app lists the origin of Twake Space in its `frame-ancestors`, and Twake Space lists the apps in its `frame-src`. [Deploying](deploy.md#runtime-configuration) lists the settings on both sides.

## The feed

The feed is Twake Space's own: it reads no app and no homeserver from the browser.

- Apps publish activity events (CloudEvents) on the `activity` exchange. Each one updates the card of its object, in the space whose resource holds it.
- Members post and react through the backend.
- A card's title opens the object in its app's tab. An event card opens Calendar's preview of it.
- A post with a link shows a preview of it. The backend fetches the page, so the browser never asks the linked site for anything ([API](api.md#get-link-preview)).

[Events](events.md#activity-events) has the CloudEvent fields and the card rules.

## Meetings

- Scheduling: the frontend calls `POST /spaces/:spaceId/meetings`, and the backend publishes a meeting request on the `twake-space` exchange. The calendar side service creates the Meet room and the event in the space's team calendar, and the event's activity event brings its card. [Events](events.md#meeting-requests) has the message.
- Joining: the space header and the apps open a room of `MEET_URL` in a floating call window that stays while the person moves around.

## The assistant

Two separate pieces:

- Twake Assistant: the panel of a space frames the assistant that the person's platform serves, through a platform intent (`io.cozy.ai.chat.conversations`). Its answer can be posted to the space's feed.
- Twake Harness: the person's agent pushes suggestions to `POST /notifications/suggestions` with a technical account's API token. The frontend shows them top right, and its buttons call Harness at `HARNESS_URL` with the person's access token.

## Settings

Common settings publishes `user.settings.updated` on the `settings` exchange with each change. The backend keeps the latest per email and serves it at `GET /settings`, and the frontend applies the language, theme, timezone, name and avatar. Twake Space never calls common settings. [Events](events.md#user-settings) has the rules.

## Twake Workplace home and bar

Twake Space is listed in the registry as a standalone app with no code: the home and the bar open the URL of the `space.embedded-app-url` flag. [README](../README.md#publish-it-on-the-registry) covers the release.

## Open questions

- @rezk2ll [ADR 010](https://github.com/linagora/twake-space-architecture/pull/10) and its [metadata change](https://github.com/linagora/twake-space-architecture/pull/13) are still open pull requests, like every ADR this doc links. Should the links move to `main` once they merge?
- @rezk2ll Which metadata names (`tasks.done`, `tasks.total` and so on) has each app agreed to send? The contract leaves them to each app and Twake Space.
