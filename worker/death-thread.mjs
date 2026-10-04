/**
 * DEATH THREADS ARE NEVER COVERED (owner, 2026-10-04, Option B).
 *
 * HNRadio is a profane comedy show. On 2026-10-04 an obituary thread ("Bob Cringely Has Died") reached it through
 * the ordinary nightly pick, and the episode mocked a mourner and swore at the man who had died. The owner's rule:
 * the show never covers a thread about a real person's death. The harness passes one over, as the Bible passes
 * over unsafe material, and the next thread is picked.
 *
 * Deterministic on purpose: phrase matching on the title, the self-post, and the linked article's headline and
 * opening, with no model call. It is tuned for a PERSON's death, not a product's: "Python 2 is dead", "the death
 * of Google Reader", "RIP Google Reader" and "how Flash died" are not death threads. A miss airs an episode the
 * owner has ruled out; a false catch costs one thread, replaced by the next. So ambiguity leans toward catching.
 */

// Phrases that announce a death on their own, in any field.
const STRONG_PATTERNS = [
  { phrase: 'has died', re: /\b(?:has|have|had)\s+(?:(?:just|sadly|reportedly|apparently)\s+)?died\b/gi, needsPersonSubject: true },
  { phrase: 'passed away', re: /\bpassed\s+away\b/gi },
  { phrase: 'obituary', re: /\bobituar(?:y|ies)\b/gi },
  { phrase: 'in memoriam', re: /\bin\s+memoriam\b/gi },
  { phrase: 'dies at', re: /\b(?:dies|died|dead)\s*,?\s+(?:at|aged)\s+(?:the\s+age\s+of\s+)?\d{1,3}\b/gi },
  { phrase: 'rest in peace', re: /\brest\s+in\s+peace\b/gi },
]

// Words that mean a death only about a person, so a TITLE needs a person signal beside them. "RIP" is matched
// in capitals only ("rip out the ORM" is not one).
const WEAK_PATTERNS = [
  { phrase: 'RIP', re: /(?:^|[^A-Za-z])R\.?I\.?P\.?(?![A-Za-z])/ },
  { phrase: 'died', re: /\bdied\b/i },
  { phrase: 'dies', re: /\bdies\b/i },
  { phrase: 'funeral', re: /\bfuneral\b/i },
  { phrase: 'memorial', re: /\bmemorial\b/i },
  { phrase: 'remembering', re: /\bremembering\b/i },
]

// A person, not a product: an age, a lifespan, an honorific, or a role.
const AGE_RE = /\b(?:at|aged)\s+\d{2,3}\b|,\s*\d{2,3}\s*,/i
const HONORIFIC_RE = /\b(?:Sir|Dame|Dr\.|Prof\.|Professor)\s+[A-Z]/
const ROLE_RE = new RegExp(`\\b(?:${[
  'founder', 'co-?founder', 'creator', 'inventor', 'pioneer', 'author', 'writer', 'journalist', 'columnist',
  'programmer', 'engineer', 'scientist', 'physicist', 'chemist', 'biologist', 'mathematician', 'astronomer',
  'hacker', 'designer', 'developer', 'investor', 'venture capitalist', 'entrepreneur', 'professor', 'researcher',
  'astronaut', 'CEO', 'legend', 'maintainer', 'economist', 'historian', 'novelist', 'artist', 'musician',
  'actor', 'actress', 'director', 'filmmaker', 'documentarian', 'father', 'mother', 'wife', 'husband',
  'son', 'daughter', 'brother', 'sister', 'friend', 'colleague', 'mentor',
].join('|')})\\b`, 'i')
// "Dennis Ritchie (1941–2011)": a span of a human lifetime after a personal name (two to four capitalized words).
// A single word is not a name: "Holes (1996-2025)" is an encyclopedia entry's publication history.
const LIFESPAN_RE = /^([^()\d]*?)\(\s*((?:1[89]|20)\d{2})\s*[-–—]\s*(20\d{2})\s*\)/
const PERSONAL_NAME_RE = /^(?:[A-Z][\p{L}'’.-]*\s+){1,3}[A-Z][\p{L}'’.-]*$/u

// The head of a "has died" subject that makes it a thing, not a person ("my startup has died", "Python 2 has died").
const THING_NOUNS = new Set([
  'startup', 'company', 'project', 'product', 'service', 'app', 'site', 'website', 'server', 'browser', 'language',
  'framework', 'library', 'format', 'protocol', 'standard', 'platform', 'feature', 'api', 'game', 'console',
  'phone', 'device', 'plan', 'tier', 'account', 'repo', 'repository', 'blog', 'podcast', 'newsletter', 'forum',
  'community', 'business', 'idea', 'laptop', 'computer', 'drive', 'disk', 'battery', 'keyboard', 'mouse',
  'extension', 'plugin', 'tool', 'os', 'distro', 'kernel', 'engine', 'database', 'model', 'bot', 'codebase',
  'career', 'dream', 'meme', 'trend', 'hype', 'movement', 'web', 'internet', 'era', 'printer', 'router', 'car',
])

/** The opening of a body that the strong phrases are checked against (an obituary says so up front). */
export const DEATH_LEDE_CHARS = 600

function lifespanMatch(title) {
  const match = LIFESPAN_RE.exec(String(title || ''))
  // The name after any "Tell HN:" style label.
  const name = match?.[1].split(':').at(-1).trim()
  if (!name || !PERSONAL_NAME_RE.test(name)) return null
  const span = Number(match[3]) - Number(match[2])
  return span >= 20 && span <= 120 ? match[0].slice(match[1].length) : null
}

function subjectIsAThing(text, index) {
  // The subject runs back to the last sentence or label boundary ("Tell HN:", ". "), and its first clause names
  // it: "Niklaus Wirth, creator of the Pascal language, has died" is about Niklaus Wirth.
  const sentence = text.slice(0, index).split(/[.!?:;]\s+|\n/).at(-1) ?? ''
  const clause = sentence.split(',')[0].trim()
  const head = (clause.split(/\s+/).at(-1) || '').toLowerCase().replace(/[^a-z0-9-]/g, '')
  if (!head) return false
  if (/\d/.test(head)) return true
  return THING_NOUNS.has(head) || THING_NOUNS.has(head.replace(/s$/, ''))
}

function strongMatch(text) {
  for (const { phrase, re, needsPersonSubject } of STRONG_PATTERNS) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(text))) {
      if (!needsPersonSubject || !subjectIsAThing(text, match.index)) return { phrase, text: match[0].trim() }
    }
  }
  return null
}

function personSignal(title) {
  return AGE_RE.test(title) || HONORIFIC_RE.test(title) || ROLE_RE.test(title) || Boolean(lifespanMatch(title))
}

function titleMatch(title) {
  const text = String(title || '').trim()
  if (!text) return null
  const strong = strongMatch(text)
  if (strong) return strong
  const lifespan = lifespanMatch(text)
  if (lifespan) return { phrase: 'lifespan', text: lifespan }
  for (const { phrase, re } of WEAK_PATTERNS) {
    const match = re.exec(text)
    if (match && personSignal(text)) return { phrase, text: match[0].trim() }
  }
  return null
}

function ledeMatch(body) {
  const text = String(body || '').slice(0, DEATH_LEDE_CHARS)
  return text.trim() ? strongMatch(text) : null
}

/**
 * Whether a thread is about a real person's death. Pass what is known: the HN title and self-post at pick time,
 * then the linked article's headline and text once fetched. Returns the first match as
 * `{ field, phrase, text }`, or null.
 */
export function deathThreadMatch({ title, storyText, articleTitle, articleText } = {}) {
  const checks = [
    ['title', () => titleMatch(title)],
    ['article headline', () => titleMatch(articleTitle)],
    ['self-post', () => ledeMatch(storyText)],
    ['article', () => ledeMatch(articleText)],
  ]
  for (const [field, check] of checks) {
    const match = check()
    if (match) return { field, ...match }
  }
  return null
}

/** The reason logged when a death thread is passed over. */
export function deathThreadReason(match) {
  return `death thread (owner rule, 2026-10-04: never covered): "${match.text}" in the ${match.field}`
}
