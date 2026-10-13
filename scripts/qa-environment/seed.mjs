// Seeds the directory through ldap-rest, which announces each space on RabbitMQ the way it
// does in production. Runs in the backend container (start.sh), and prints the people the
// mock SSO signs in, with the uuid ldap-rest gave them.
import { LdapRestClient, NotFoundError } from '@linagora/ldap-rest-client'

const ORGANIZATIONS = [
  {
    id: 'acme',
    name: 'Acme',
    domain: 'acme.twake.local',
    people: [
      ['alice', 'Alice', 'Martin', 'admin'],
      ['bob', 'Bob', 'Durand', 'member'],
      ['carol', 'Carol', 'Petit', 'member'],
      ['dave', 'Dave', 'Moreau', 'member']
    ],
    groups: [{ name: 'Designers', members: ['carol', 'dave'] }],
    spaces: [
      {
        name: 'Roadmap',
        members: { alice: 'admin', bob: 'editor', carol: 'viewer' },
        groups: { Designers: 'editor' }
      },
      {
        name: 'Design Sprint',
        members: { bob: 'admin', alice: 'editor', dave: 'viewer' }
      },
      { name: 'Handover', members: { carol: 'admin', alice: 'viewer' } }
    ]
  },
  {
    id: 'globex',
    name: 'Globex',
    domain: 'globex.twake.local',
    people: [['erin', 'Erin', 'Leroy', 'admin']],
    groups: [],
    spaces: [{ name: 'Globex team', members: { erin: 'admin' } }]
  }
]

const client = new LdapRestClient({
  baseUrl: process.env.LDAP_REST_URL,
  auth: {
    type: 'hmac',
    serviceId: process.env.LDAP_REST_SERVICE_ID,
    secret: process.env.LDAP_REST_SECRET
  },
  logger: { type: 'hidden' }
})

async function exists(request) {
  try {
    await request
    return true
  } catch (error) {
    if (error instanceof NotFoundError) return false
    throw error
  }
}

const people = {}
for (const org of ORGANIZATIONS) {
  // A second start.sh on a running stack only reads the people back.
  const seeded = await exists(client.organizations.get(org.id))
  if (!seeded) {
    await client.organizations.create({
      id: org.id,
      name: org.name,
      domain: org.domain
    })
    for (const [uid, givenName, sn, organizationRole] of org.people) {
      await client.organizations.createUser(org.id, {
        uid,
        cn: `${givenName} ${sn}`,
        displayName: `${givenName} ${sn}`,
        givenName,
        sn,
        mail: `${uid}@${org.domain}`,
        organizationRole
      })
    }
    const groupIds = {}
    for (const group of org.groups) {
      const { id } = await client.groups.create(org.id, { name: group.name })
      await client.groups.addMembers(org.id, id, { usernames: group.members })
      groupIds[group.name] = id
    }
    for (const space of org.spaces) {
      await client.spaces.create(org.id, {
        name: space.name,
        members: Object.entries(space.members).map(([username, role]) => ({
          username,
          role
        })),
        groups: Object.entries(space.groups ?? {}).map(([name, role]) => ({
          id: groupIds[name],
          role
        }))
      })
    }
  }
  for (const [uid, givenName, sn, organizationRole] of org.people) {
    const user = await client.organizations.getUser(org.id, {
      by: 'username',
      value: uid
    })
    people[uid] = {
      uuid: user._id,
      name: `${givenName} ${sn}`,
      email: user.mail,
      org_id: org.id,
      org_role: organizationRole
    }
  }
}

// The number of spaces the backend should learn of, then the people
const spaces = ORGANIZATIONS.reduce(
  (count, org) => count + org.spaces.length,
  0
)
process.stdout.write(`${spaces}\n${JSON.stringify(people, null, 2)}\n`)
