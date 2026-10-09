/**
 * COMMENTERS GO BY AN INVENTED NAME, NEVER BY THEIR HACKER NEWS USERNAME (owner, 2026-10-09).
 *
 * The show still reads and argues the real thread, but every Hacker News username that reaches the
 * writer is replaced by an invented name before it leaves the fetch: the comment authors, the
 * submitter, and any mention of a username inside the text. The writer never sees a real handle, so
 * no script, episode, show note or feed built from it can carry one. On air a host introduces one
 * naturally: "a commenter we'll call Marlowe".
 *
 * THE NAMES are plain, sayable given names (no digits, no compound handles), mostly unisex so a name
 * never guesses anyone's gender. A name is drawn by a keyed hash (HMAC-SHA-256) of the username, so it
 * cannot be turned back into the username without the key, and the same username draws the same name
 * whenever nobody else in the thread has it. WITHIN ONE EPISODE every commenter has exactly one name and
 * no two commenters share one: a collision draws again, deterministically, and a thread with more
 * commenters than given names falls back to a given name and a surname ("Marlowe Fenwick"). Across
 * episodes the same person USUALLY keeps their name; a collision can change it, which the owner allows.
 *
 * THE KEY is the Worker secret `HNR_PSEUDONYM_KEY`. Anywhere that can publish (a Sleeper Hit API key is
 * configured) must hold it: without it the fetch refuses, rather than drawing names with a public
 * development key that anyone could replay against the list of usernames. A development install with
 * no API key uses a fixed development key.
 *
 * MENTIONS inside the text:
 *   - a username of anyone IN THIS THREAD (author or submitter) is replaced wherever it stands as a
 *     whole word, with or without a leading "@", when it is distinctive enough not to be an ordinary
 *     word (it carries a digit, "_", "-" or a capital, or is 8+ letters). A short plain-word username
 *     ("dang", "sama") is replaced only in its "@" form, because replacing every "dang" in the thread
 *     would rewrite ordinary English. Its own comments still go by its invented name; only a bare-word
 *     mention of it in someone else's text can survive (a known limit).
 *   - any "@name" mention of someone NOT in the thread is replaced too (it is still a username), with a
 *     name unique in the episode, except code at-keywords ("@media", "@Override", "@property", ...),
 *     scoped packages ("@types/node") and email addresses.
 *   - the linked ARTICLE is the published work the thread discusses and is left verbatim.
 * Usernames are case-sensitive on Hacker News; bare-word matches are exact, "@" matches ignore case.
 */

/** The Worker secret / environment variable that holds the naming key. */
export const PSEUDONYM_KEY_ENV = 'HNR_PSEUDONYM_KEY'

/** The fixed key a development install without a Sleeper Hit API key uses. Never used where it can publish. */
export const DEV_PSEUDONYM_KEY = 'hnr-development-pseudonym-key-not-secret'

/** A secret shorter than this is refused: a short key is a guessable key. */
export const PSEUDONYM_KEY_MIN_LENGTH = 16

export class PseudonymKeyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PseudonymKeyError'
    this.code = 'pseudonym_key_missing'
  }
}

/**
 * The naming key for this environment. A configured key wins (and must be long enough). With none, an
 * environment that can publish (it holds a Sleeper Hit API key) is refused; a development install with
 * no API key gets the fixed development key.
 */
export function resolvePseudonymKey(env = {}) {
  const configured = typeof env?.[PSEUDONYM_KEY_ENV] === 'string' ? env[PSEUDONYM_KEY_ENV].trim() : ''
  if (configured) {
    if (configured.length < PSEUDONYM_KEY_MIN_LENGTH) {
      throw new PseudonymKeyError(`${PSEUDONYM_KEY_ENV} must be at least ${PSEUDONYM_KEY_MIN_LENGTH} characters.`)
    }
    return configured
  }
  const canPublish = typeof env?.SLEEPERHIT_API_KEY === 'string' && env.SLEEPERHIT_API_KEY.trim() !== ''
  if (canPublish) {
    throw new PseudonymKeyError(
      `${PSEUDONYM_KEY_ENV} is not set. HNR names Hacker News commenters only by invented names, and the naming key `
      + 'must be a secret wherever episodes can be made (`npx wrangler secret put HNR_PSEUDONYM_KEY`).',
    )
  }
  return DEV_PSEUDONYM_KEY
}

/** fetchThread options carrying this environment's naming key. */
export function pseudonymOptions(env = {}) {
  return { pseudonymKey: resolvePseudonymKey(env) }
}

/**
 * The given names a commenter is called by: plain and easy to say aloud, mostly unisex, no host's name
 * (Gary, Maeve, Obi, Gruner), no famous single-name figure, and nothing that reads as an ordinary word.
 */
export const COMMENTER_GIVEN_NAMES = Object.freeze([
  'Ainsley', 'Alden', 'Alex', 'Alexis', 'Ali', 'Andie', 'Arden', 'Ari', 'Aubrey', 'Avery',
  'Bailey', 'Billie', 'Blair', 'Bobbie', 'Brett', 'Cameron', 'Carey', 'Carson', 'Casey', 'Cassidy',
  'Charlie', 'Corey', 'Courtney', 'Dale', 'Dana', 'Darby', 'Darcy', 'Darian', 'Devin', 'Devon',
  'Dorian', 'Dylan', 'Eden', 'Ellery', 'Elliot', 'Ellis', 'Emerson', 'Emery', 'Emory', 'Finley',
  'Flynn', 'Frankie', 'Glenn', 'Greer', 'Hadley', 'Harley', 'Harper', 'Hayden', 'Hollis', 'Ira',
  'Jaden', 'Jaime', 'Jamie', 'Jesse', 'Jessie', 'Jody', 'Joey', 'Jordan', 'Jules', 'Kai',
  'Keegan', 'Kelly', 'Kelsey', 'Kendall', 'Kerry', 'Kim', 'Kit', 'Kris', 'Laurie', 'Lee',
  'Leighton', 'Lennie', 'Leslie', 'Lindsay', 'Linden', 'Logan', 'Lou', 'Lowell', 'Lynn', 'Mackenzie',
  'Marion', 'Marley', 'Marlowe', 'Max', 'Mel', 'Merritt', 'Micah', 'Mickey', 'Morgan', 'Nat',
  'Nicky', 'Nico', 'Noel', 'Oakley', 'Ollie', 'Parker', 'Payton', 'Perry', 'Peyton', 'Quinn',
  'Rae', 'Ramsey', 'Reese', 'Remy', 'Rene', 'Riley', 'Robbie', 'Robin', 'Ronnie', 'Rory',
  'Rowan', 'Ryan', 'Sam', 'Sasha', 'Sawyer', 'Shannon', 'Shay', 'Shelby', 'Sidney', 'Skyler',
  'Sloane', 'Spencer', 'Stevie', 'Sutton', 'Tatum', 'Taylor', 'Teagan', 'Terry', 'Toby', 'Tracy',
  'Tyler', 'Val', 'Whitney', 'Wren', 'Wynn',
])

/** Surnames for the fallback when a thread has more commenters than given names: plain, not famous. */
export const COMMENTER_SURNAMES = Object.freeze([
  'Abbott', 'Ashford', 'Barlow', 'Beck', 'Bellamy', 'Bishop', 'Blackwood', 'Bramley', 'Brennan', 'Calloway',
  'Carver', 'Chandler', 'Colby', 'Conway', 'Corbett', 'Crane', 'Dalton', 'Darrow', 'Dawson', 'Delaney',
  'Doyle', 'Drummond', 'Easton', 'Ellison', 'Fairbanks', 'Fallon', 'Farley', 'Fenwick', 'Fletcher', 'Foster',
  'Garrett', 'Gibbons', 'Granger', 'Hale', 'Halloway', 'Harlow', 'Hastings', 'Hawthorne', 'Haywood', 'Hensley',
  'Holloway', 'Hudson', 'Ingram', 'Jarvis', 'Keating', 'Kendrick', 'Kirkland', 'Landry', 'Langley', 'Larkin',
  'Lawson', 'Lockhart', 'Lowry', 'Lyons', 'Maddox', 'Mercer', 'Merrick', 'Morrow', 'Nash', 'Norris',
  'Oakes', 'Ogden', 'Osborne', 'Pace', 'Pembroke', 'Prescott', 'Quigley', 'Radcliffe', 'Redding', 'Rhodes',
  'Ridley', 'Rowe', 'Rutherford', 'Sheridan', 'Sinclair', 'Somers', 'Stanton', 'Sterling', 'Talbot', 'Thorne',
  'Tolliver', 'Underwood', 'Vance', 'Voss', 'Wakefield', 'Waverly', 'Whitaker', 'Winslow', 'Wolcott', 'Yardley',
])

/** How many times a username draws a given name before it falls back to a given name and a surname. */
export const GIVEN_NAME_DRAWS = 24

// Inside a character class: letters, digits, '_' and a literal '-'.
const HANDLE_CHAR = 'A-Za-z0-9_\\-'
const encoder = new TextEncoder()

// One imported HMAC key per secret: a thread of a thousand commenters signs a thousand names.
const importedKeys = new Map()

function hmacKey(key) {
  let imported = importedKeys.get(key)
  if (!imported) {
    imported = crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    importedKeys.set(key, imported)
  }
  return imported
}

async function hmacBytes(key, message) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(key), encoder.encode(message)))
}

const pick = (list, high, low) => list[((high << 8) | low) % list.length]

/**
 * The name one username draws: the same username, key and attempt always draw the same name. Draws
 * 0..GIVEN_NAME_DRAWS-1 are given names; later draws are a given name and a surname. A draw after the
 * first is used only to settle a collision inside one episode.
 */
export async function pseudonymFor(handle, key, attempt = 0) {
  if (!key) throw new PseudonymKeyError('A naming key is required.')
  const salt = attempt > 0 ? `#${attempt}` : ''
  const bytes = await hmacBytes(key, `hn-username:${String(handle ?? '')}${salt}`)
  const given = pick(COMMENTER_GIVEN_NAMES, bytes[0], bytes[1])
  return attempt < GIVEN_NAME_DRAWS ? given : `${given} ${pick(COMMENTER_SURNAMES, bytes[2], bytes[3])}`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True when a username is distinctive enough to replace as a bare word without rewriting ordinary English. */
export function isDistinctiveHandle(handle) {
  const name = String(handle ?? '')
  if (name.length < 3) return false
  if (/[0-9_A-Z-]/.test(name)) return true
  return name.length >= 8
}

/** "@" words that are code, not people: CSS at-rules, annotations, decorators, chat broadcasts. */
export const CODE_AT_KEYWORDS = Object.freeze(new Set([
  'media', 'import', 'keyframes', 'font-face', 'supports', 'charset', 'page', 'layer', 'container', 'property',
  'apply', 'tailwind', 'namespace', 'override', 'deprecated', 'param', 'return', 'returns', 'throws', 'see',
  'since', 'test', 'before', 'after', 'autowired', 'component', 'injectable', 'staticmethod', 'classmethod',
  'dataclass', 'app', 'pytest', 'ts-ignore', 'ts-expect-error', 'ts-nocheck', 'everyone', 'here', 'channel',
  'author', 'version', 'type', 'typedef', 'interface', 'functional', 'nonnull', 'nullable', 'suppresswarnings',
  'jsx', 'flow', 'license', 'abstractmethod', 'cached_property', 'lru_cache', 'click', 'input', 'output',
]))

/**
 * Every given name and surname pairing, walked from an offset the username draws: the last resort that
 * always finds a free name while the episode has fewer commenters than pairings.
 */
async function* fullNameScan(handle, key) {
  const bytes = await hmacBytes(key, `hn-username-scan:${handle}`)
  const g = COMMENTER_GIVEN_NAMES.length
  const s = COMMENTER_SURNAMES.length
  const start = ((bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) % (g * s)
  for (let i = 0; i < g * s; i++) {
    const index = (start + i) % (g * s)
    yield `${COMMENTER_GIVEN_NAMES[index % g]} ${COMMENTER_SURNAMES[Math.floor(index / g)]}`
  }
}

/**
 * The username → name map for one episode. Every username gets exactly one name and no two share one;
 * no name is a real username in the thread. Collisions settle in a fixed order (by first draw, then
 * username), so the result never depends on the order comments arrived in.
 */
export async function buildPseudonymMap(handles, key) {
  if (!key) throw new PseudonymKeyError('A naming key is required.')
  const unique = [...new Set([...handles].map((h) => String(h ?? '').trim()).filter(Boolean))].sort()
  const real = new Set(unique.map((h) => h.toLowerCase()))
  const drawn = await Promise.all(unique.map(async (handle) => ({ handle, name: await pseudonymFor(handle, key) })))
  drawn.sort((a, b) => a.name.localeCompare(b.name) || a.handle.localeCompare(b.handle))
  const map = new Map()
  const taken = new Set()
  const free = (name) => !taken.has(name.toLowerCase()) && !real.has(name.toLowerCase())
  const givenFree = () => COMMENTER_GIVEN_NAMES.some(free)
  for (const { handle, name: first } of drawn) {
    let name = first
    let attempt = 0
    // Every given name is spoken for: skip straight to given name and surname.
    if (!free(name) && !givenFree()) attempt = GIVEN_NAME_DRAWS - 1
    while (!free(name) && attempt < GIVEN_NAME_DRAWS + 64) {
      attempt += 1
      name = await pseudonymFor(handle, key, attempt)
    }
    if (!free(name)) {
      name = null
      for await (const candidate of fullNameScan(handle, key)) {
        if (free(candidate)) { name = candidate; break }
      }
      if (!name) throw new Error('More commenters than names: the episode cannot give each one a distinct name.')
    }
    taken.add(name.toLowerCase())
    map.set(handle, name)
  }
  return map
}

const atMentionRe = () => new RegExp(`(?<![${HANDLE_CHAR}.@])@([${HANDLE_CHAR}]{2,32})(?![${HANDLE_CHAR}/])`, 'g')

/** The "@name" mentions of people outside the thread in these texts (lower-cased, code keywords dropped). */
export function outsideMentions(texts, members) {
  const known = new Set([...members].map((handle) => String(handle).toLowerCase()))
  const found = new Set()
  for (const text of texts) {
    for (const match of String(text ?? '').matchAll(atMentionRe())) {
      const lower = match[1].toLowerCase()
      if (!known.has(lower) && !CODE_AT_KEYWORDS.has(lower)) found.add(lower)
    }
  }
  return [...found]
}

/**
 * A function that replaces usernames in free text with their names (see the header for the rules).
 * `map` holds the thread's members by their exact username and outside "@" mentions by lower case.
 */
export function makeTextPseudonymizer(map) {
  const bare = [...map.keys()].filter(isDistinctiveHandle).sort((a, b) => b.length - a.length)
  const bareRe = bare.length > 0
    ? new RegExp(`(?<![${HANDLE_CHAR}@])(${bare.map(escapeRegExp).join('|')})(?![${HANDLE_CHAR}])`, 'g')
    : null
  const byLower = new Map()
  for (const [handle, name] of map) if (!byLower.has(handle.toLowerCase())) byLower.set(handle.toLowerCase(), name)

  return function pseudonymizeText(text) {
    let out = String(text ?? '')
    if (!out) return out
    out = out.replace(atMentionRe(), (whole, mention) => {
      const lower = mention.toLowerCase()
      if (CODE_AT_KEYWORDS.has(lower)) return whole
      const name = byLower.get(lower)
      return name ? `@${name}` : whole
    })
    if (bareRe) out = out.replace(bareRe, (handle) => map.get(handle) ?? handle)
    return out
  }
}

/**
 * Replace every Hacker News username in a captured thread with its invented name: each comment's author,
 * the submitter, and usernames mentioned in comment text and the self-post (outside mentions included,
 * each with a name unique in the episode). Returns a new thread marked `pseudonymized: true`; the
 * article and the counts are unchanged.
 */
export async function pseudonymizeThread(thread, key) {
  if (!key) throw new PseudonymKeyError('A naming key is required to name commenters.')
  const comments = Array.isArray(thread?.comments) ? thread.comments : []
  const submitter = typeof thread?.author === 'string' && thread.author && thread.author !== 'unknown' ? thread.author : null
  const members = comments.map((comment) => String(comment.author ?? '').trim()).filter(Boolean)
  if (submitter) members.push(submitter)
  const texts = [...comments.map((comment) => comment.text), thread?.storyText]
  const map = await buildPseudonymMap([...members, ...outsideMentions(texts, members)], key)
  const rename = makeTextPseudonymizer(map)
  return {
    ...thread,
    author: submitter ? map.get(submitter) : thread?.author,
    storyText: typeof thread?.storyText === 'string' ? rename(thread.storyText) : thread?.storyText,
    comments: comments.map((comment) => ({
      ...comment,
      author: map.get(String(comment.author ?? '').trim()) ?? comment.author,
      text: rename(comment.text),
    })),
    pseudonymized: true,
  }
}
