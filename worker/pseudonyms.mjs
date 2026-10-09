/**
 * COMMENTERS ARE NAMED BY PSEUDONYM, NEVER BY THEIR HACKER NEWS USERNAME (owner, 2026-10-09).
 *
 * The show still reads and argues the real thread, but every Hacker News username that reaches the
 * writer is replaced by a STABLE pseudonym before it leaves the fetch: the comment authors, the
 * submitter, and any mention of a username inside the text. The writer never sees a real handle, so
 * no script, episode, show note or feed built from it can carry one.
 *
 * STABLE: a pseudonym is a keyed hash (HMAC-SHA-256) of the username, read as two plain words and a
 * number ("AmberHeron42"). The same username gets the same pseudonym in every thread and every
 * episode, so a running bit about one commenter stays coherent, and a pseudonym cannot be turned back
 * into the username without the key. The key is the Worker secret `HNR_PSEUDONYM_KEY`. Anywhere that
 * can publish (a Sleeper Hit API key is configured) must hold it: without it the fetch refuses, rather
 * than naming people with a public development key that anyone could reverse against the list of
 * usernames. A development install with no API key uses a fixed development key.
 *
 * MENTIONS inside the text:
 *   - a username of anyone IN THIS THREAD (author or submitter) is replaced wherever it stands as a
 *     whole word, with or without a leading "@", when it is distinctive enough not to be an ordinary
 *     word (it carries a digit, "_", "-" or a capital, or is 8+ letters). A short plain-word username
 *     ("dang", "sama") is replaced only in its "@" form, because replacing every "dang" in the thread
 *     would rewrite ordinary English. Its comments are still pseudonymous; only a bare-word mention of
 *     it in someone else's text can survive.
 *   - any "@name" mention of someone NOT in the thread is replaced too (it is still a username), except
 *     code at-keywords ("@media", "@Override", "@property", ...) and scoped packages ("@types/node").
 *   - the linked ARTICLE is the published work the thread discusses and is left verbatim.
 * Usernames are case-sensitive on Hacker News; bare-word matches are exact, "@" matches ignore case.
 */

/** The Worker secret / environment variable that holds the pseudonym key. */
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
 * The pseudonym key for this environment. A configured key wins (and must be long enough). With none,
 * an environment that can publish (it holds a Sleeper Hit API key) is refused; a development install
 * with no API key gets the fixed development key.
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
      `${PSEUDONYM_KEY_ENV} is not set. HNR names Hacker News commenters only by pseudonym, and the pseudonym key `
      + 'must be a secret wherever episodes can be made (`npx wrangler secret put HNR_PSEUDONYM_KEY`).',
    )
  }
  return DEV_PSEUDONYM_KEY
}

/** fetchThread options carrying this environment's pseudonym key. */
export function pseudonymOptions(env = {}) {
  return { pseudonymKey: resolvePseudonymKey(env) }
}

/**
 * The two word lists a pseudonym is read from: plain, neutral, easy to say aloud, and not a person's
 * name, so a pseudonym can never be mistaken for (or defame) a real, named person.
 */
export const PSEUDONYM_ADJECTIVES = Object.freeze([
  'Amber', 'Ashen', 'Azure', 'Bitter', 'Blazing', 'Bold', 'Brass', 'Brisk', 'Bronze', 'Calm',
  'Candid', 'Cedar', 'Chalk', 'Clever', 'Cobalt', 'Copper', 'Coral', 'Crimson', 'Crisp', 'Dapper',
  'Dusky', 'Dusty', 'Eager', 'Early', 'Ember', 'Fabled', 'Feral', 'Fizzy', 'Flint', 'Foggy',
  'Frosty', 'Gentle', 'Gilded', 'Glassy', 'Golden', 'Granite', 'Grassy', 'Hasty', 'Hazel', 'Hollow',
  'Humble', 'Icy', 'Indigo', 'Inky', 'Ivory', 'Jade', 'Jolly', 'Keen', 'Lanky', 'Lemon',
  'Linen', 'Lofty', 'Lucky', 'Lunar', 'Marble', 'Mellow', 'Misty', 'Mossy', 'Muddy', 'Nimble',
  'Noble', 'Nutmeg', 'Oaken', 'Ochre', 'Olive', 'Onyx', 'Pale', 'Peppery', 'Pewter', 'Plucky',
  'Polar', 'Prickly', 'Quiet', 'Quick', 'Rapid', 'Rocky', 'Rosy', 'Rowdy', 'Ruby', 'Rusty',
  'Sable', 'Salty', 'Sandy', 'Scarlet', 'Shady', 'Silent', 'Silver', 'Sleepy', 'Slate', 'Smoky',
  'Snowy', 'Solar', 'Spicy', 'Steady', 'Steel', 'Stormy', 'Sturdy', 'Sunny', 'Swift', 'Tawny',
  'Teal', 'Thorny', 'Tidal', 'Timber', 'Tiny', 'Topaz', 'Velvet', 'Vivid', 'Wandering', 'Wary',
  'Windy', 'Wiry', 'Witty', 'Woolly', 'Zesty', 'Breezy', 'Cloudy', 'Dizzy', 'Fuzzy', 'Glowing',
  'Grumpy', 'Mighty', 'Nervous', 'Patient', 'Restless', 'Shiny', 'Tangled', 'Wobbly',
])

export const PSEUDONYM_NOUNS = Object.freeze([
  'Badger', 'Beacon', 'Beetle', 'Bison', 'Bramble', 'Buffalo', 'Canyon', 'Capybara', 'Cobra', 'Comet',
  'Condor', 'Cormorant', 'Coyote', 'Crane', 'Cricket', 'Dingo', 'Dolphin', 'Dragonfly', 'Eagle', 'Egret',
  'Falcon', 'Ferret', 'Finch', 'Firefly', 'Fjord', 'Gazelle', 'Gecko', 'Geyser', 'Glacier', 'Gopher',
  'Harbor', 'Hedgehog', 'Heron', 'Hornet', 'Ibex', 'Iguana', 'Jackal', 'Jaguar', 'Kestrel', 'Kiwi',
  'Koala', 'Lantern', 'Lemur', 'Lighthouse', 'Llama', 'Lobster', 'Lynx', 'Magpie', 'Mammoth', 'Manatee',
  'Marmot', 'Meadow', 'Meerkat', 'Mesa', 'Mongoose', 'Moose', 'Narwhal', 'Newt', 'Ocelot', 'Octopus',
  'Orca', 'Osprey', 'Otter', 'Owl', 'Panda', 'Pangolin', 'Parrot', 'Pelican', 'Penguin', 'Pebble',
  'Pigeon', 'Pine', 'Platypus', 'Puffin', 'Quail', 'Quokka', 'Raccoon', 'Raven', 'Reef', 'Rhino',
  'Bluejay', 'Salamander', 'Sandpiper', 'Seal', 'Shark', 'Skunk', 'Sloth', 'Sparrow', 'Squid', 'Starling',
  'Stoat', 'Swallow', 'Tapir', 'Tern', 'Thistle', 'Toad', 'Tortoise', 'Toucan', 'Trout', 'Tundra',
  'Turtle', 'Urchin', 'Valley', 'Vole', 'Vulture', 'Walrus', 'Warbler', 'Wasp', 'Weasel', 'Whale',
  'Willow', 'Wolverine', 'Wombat', 'Wren', 'Yak', 'Zebra', 'Anchor', 'Kettle', 'Teapot', 'Cactus',
  'Pretzel', 'Muffin', 'Biscuit', 'Turnip', 'Radish', 'Walnut', 'Acorn', 'Pumpkin',
])

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

function readName(bytes) {
  const adjective = PSEUDONYM_ADJECTIVES[((bytes[0] << 8) | bytes[1]) % PSEUDONYM_ADJECTIVES.length]
  const noun = PSEUDONYM_NOUNS[((bytes[2] << 8) | bytes[3]) % PSEUDONYM_NOUNS.length]
  const number = (((bytes[4] << 8) | bytes[5]) % 90) + 10
  return `${adjective}${noun}${number}`
}

/**
 * The pseudonym for one username: the same username and key always give the same pseudonym.
 * `attempt` > 0 draws an alternative, used only to settle a collision inside one thread.
 */
export async function pseudonymFor(handle, key, attempt = 0) {
  if (!key) throw new PseudonymKeyError('A pseudonym key is required.')
  const name = String(handle ?? '')
  const salt = attempt > 0 ? `#${attempt}` : ''
  return readName(await hmacBytes(key, `hn-username:${name}${salt}`))
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
 * Build the username → pseudonym map for one thread: every author and the submitter. Two usernames that
 * draw the same pseudonym are settled deterministically (the one whose draw sorts first keeps it; the
 * other draws again), and no pseudonym may equal a real username in the thread.
 */
export async function buildPseudonymMap(handles, key) {
  const unique = [...new Set([...handles].map((h) => String(h ?? '').trim()).filter(Boolean))].sort()
  const real = new Set(unique.map((h) => h.toLowerCase()))
  const drawn = await Promise.all(unique.map(async (handle) => ({ handle, name: await pseudonymFor(handle, key) })))
  const map = new Map()
  const taken = new Set()
  // Settle collisions in a fixed order (by the drawn name, then the username), so the result does not
  // depend on the order comments arrived in.
  drawn.sort((a, b) => a.name.localeCompare(b.name) || a.handle.localeCompare(b.handle))
  for (const { handle, name: first } of drawn) {
    let name = first
    let attempt = 0
    while (taken.has(name.toLowerCase()) || real.has(name.toLowerCase())) {
      attempt += 1
      name = await pseudonymFor(handle, key, attempt)
    }
    taken.add(name.toLowerCase())
    map.set(handle, name)
  }
  return map
}

/** A function that replaces usernames in free text with their pseudonyms (see the header for the rules). */
export function makeTextPseudonymizer(map, key) {
  const bare = [...map.keys()].filter(isDistinctiveHandle).sort((a, b) => b.length - a.length)
  const bareRe = bare.length > 0
    ? new RegExp(`(?<![${HANDLE_CHAR}@])(${bare.map(escapeRegExp).join('|')})(?![${HANDLE_CHAR}])`, 'g')
    : null
  const lowerToHandle = new Map([...map.keys()].map((handle) => [handle.toLowerCase(), handle]))
  const atRe = new RegExp(`(?<![${HANDLE_CHAR}.@])@([${HANDLE_CHAR}]{2,32})(?![${HANDLE_CHAR}/])`, 'g')
  const outsiders = new Map()

  return async function pseudonymizeText(text) {
    let out = String(text ?? '')
    if (!out) return out
    // "@name" first: a thread member by their thread pseudonym, anyone else by their own.
    const mentions = [...out.matchAll(atRe)].map((m) => m[1])
    for (const mention of mentions) {
      const lower = mention.toLowerCase()
      if (lowerToHandle.has(lower) || CODE_AT_KEYWORDS.has(lower) || outsiders.has(lower)) continue
      outsiders.set(lower, await pseudonymFor(mention, key))
    }
    out = out.replace(atRe, (whole, mention) => {
      const lower = mention.toLowerCase()
      const member = lowerToHandle.get(lower)
      if (member) return `@${map.get(member)}`
      if (CODE_AT_KEYWORDS.has(lower)) return whole
      return `@${outsiders.get(lower)}`
    })
    if (bareRe) out = out.replace(bareRe, (handle) => map.get(handle) ?? handle)
    return out
  }
}

/**
 * Replace every Hacker News username in a captured thread with its pseudonym: each comment's author,
 * the submitter, and usernames mentioned in comment text and the self-post. Returns a new thread
 * marked `pseudonymized: true`; the article and the counts are unchanged.
 */
export async function pseudonymizeThread(thread, key) {
  if (!key) throw new PseudonymKeyError('A pseudonym key is required to name commenters.')
  const comments = Array.isArray(thread?.comments) ? thread.comments : []
  const submitter = typeof thread?.author === 'string' && thread.author && thread.author !== 'unknown' ? thread.author : null
  const handles = comments.map((comment) => comment.author).filter(Boolean)
  if (submitter) handles.push(submitter)
  const map = await buildPseudonymMap(handles, key)
  const rename = makeTextPseudonymizer(map, key)
  const renamedComments = await Promise.all(comments.map(async (comment) => ({
    ...comment,
    author: map.get(String(comment.author ?? '').trim()) ?? comment.author,
    text: await rename(comment.text),
  })))
  return {
    ...thread,
    author: submitter ? map.get(submitter) : thread?.author,
    storyText: typeof thread?.storyText === 'string' ? await rename(thread.storyText) : thread?.storyText,
    comments: renamedComments,
    pseudonymized: true,
  }
}
