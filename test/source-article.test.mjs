import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ARTICLE_BROWSER_USER_AGENT,
  fetchArticle,
  HNError,
  threadToTranscript,
} from '../worker/hn.mjs'

const baseThread = {
  id: '1',
  title: 'Tailscale did not stop the intrusion',
  url: 'https://news.ycombinator.com/item?id=1',
  author: 'bluehatbrit',
  points: 597,
  storyText: '',
  total: 2,
  comments: [
    { id: 'c1', author: 'alice', depth: 0, text: 'This is a nothingburger.', parentId: null },
    { id: 'c2', author: 'bob', depth: 1, text: 'Disagree, the blast radius matters.', parentId: 'c1' },
  ],
  completeness: {
    comments: { complete: true, expected: 2, fetched: 2, capturedAt: '2026-08-10T12:00:00.000Z' },
  },
}

test('the complete source article is rendered before every comment', () => {
  const articleText = `ARTICLE-BEGIN\n${'full article paragraph. '.repeat(800)}\nARTICLE-END`
  const transcript = threadToTranscript({
    ...baseThread,
    articleUrl: 'https://tailscale.com/blog/intrusion',
    article: {
      url: 'https://tailscale.com/blog/intrusion',
      text: articleText,
      charCount: articleText.length,
      complete: true,
      truncated: false,
    },
  })

  const sourceAt = transcript.indexOf('## THE COMPLETE SOURCE ARTICLE')
  const beginAt = transcript.indexOf(`<<<HNR_ARTICLE_BEGIN chars=${articleText.length}>>>`)
  const endAt = transcript.indexOf('ARTICLE-END')
  const boundaryEndAt = transcript.indexOf('<<<HNR_ARTICLE_END>>>')
  const commentsAt = transcript.indexOf('## COMPLETE COMMENT THREAD')
  assert.ok(sourceAt > -1)
  assert.ok(beginAt > sourceAt)
  assert.ok(endAt > beginAt)
  assert.ok(boundaryEndAt > endAt)
  assert.ok(commentsAt > boundaryEndAt)
  assert.match(transcript, /Article: complete reader extraction/)
})

test('an unavailable linked article blocks generation instead of becoming a warning', () => {
  assert.throws(
    () => threadToTranscript({
      ...baseThread,
      articleUrl: 'https://paywalled.example/story',
      article: null,
    }),
    (error) => error instanceof HNError && error.code === 'article_incomplete',
  )
})

test('a self-post with no external link includes the entire original post', () => {
  const storyText = `Ask HN: ${'details '.repeat(2_000)}THE-END`
  const transcript = threadToTranscript({
    ...baseThread,
    articleUrl: null,
    article: null,
    storyText,
  })

  assert.doesNotMatch(transcript, /THE COMPLETE SOURCE ARTICLE/)
  assert.ok(transcript.includes(storyText))
  assert.match(transcript, new RegExp(`<<<HNR_SELF_POST_BEGIN chars=${storyText.length}>>>`))
  assert.match(transcript, /<<<HNR_SELF_POST_END>>>/)
})

test('a linked article with an incorrect declared character count is rejected', () => {
  assert.throws(
    () => threadToTranscript({
      ...baseThread,
      articleUrl: 'https://publisher.example/article',
      article: {
        url: 'https://publisher.example/article',
        text: 'Complete article body.',
        charCount: 3,
        complete: true,
        truncated: false,
      },
    }),
    (error) => error instanceof HNError && error.code === 'article_incomplete',
  )
})

test('fetchArticle rejects non-http inputs before making a network call', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error('must not be called') }

  for (const bad of [null, undefined, '', 'ftp://x/y', 'javascript:alert(1)', 'not a url']) {
    await assert.rejects(
      () => fetchArticle(bad, { fetchImpl }),
      (error) => error instanceof HNError && error.code === 'article_url_invalid',
    )
  }
  assert.equal(calls, 0)
})

test('fetchArticle reader-extracts beyond the former 12,000-character cutoff', async () => {
  const middle = 'Complete evidence sentence. '.repeat(900)
  const html = `<!doctype html><html><head><title>Full source</title></head><body><main><article><h1>Full source</h1><p>ARTICLE-BEGIN</p><p>${middle}</p><p>ARTICLE-END</p></article></main></body></html>`
  let requestOptions
  const fetchImpl = async (_url, options) => {
    requestOptions = options
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }

  const article = await fetchArticle('https://example.com/full', { fetchImpl })
  assert.equal(article.complete, true)
  assert.equal(article.truncated, false)
  assert.ok(article.charCount > 12_000)
  assert.match(article.text, /ARTICLE-BEGIN/)
  assert.match(article.text, /ARTICLE-END/)
  assert.equal(requestOptions.headers['User-Agent'], ARTICLE_BROWSER_USER_AGENT)
  assert.equal(requestOptions.headers['Accept-Language'], 'en-US,en;q=0.9')
})

test('fetchArticle prefers a longer structured article body over a rendered teaser', async () => {
  const articleBody = `STRUCTURED-BEGIN ${'complete structured evidence. '.repeat(600)} STRUCTURED-END`
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: 'Complete structured article',
    isAccessibleForFree: true,
    articleBody,
  })
  const html = `<!doctype html><html><head><script type="application/ld+json">${jsonLd}</script></head><body><article><h1>Teaser</h1><p>${'Rendered teaser. '.repeat(40)}</p></article></body></html>`
  const fetchImpl = async () => new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })

  const article = await fetchArticle('https://example.com/structured', { fetchImpl })
  assert.equal(article.title, 'Complete structured article')
  assert.match(article.text, /STRUCTURED-BEGIN/)
  assert.match(article.text, /STRUCTURED-END/)
  assert.ok(article.charCount > 12_000)
})

test('fetchArticle rejects partial HTTP responses and paywall previews', async () => {
  const partial = async () => new Response('x'.repeat(1_000), {
    status: 206,
    headers: {
      'content-type': 'text/plain',
      'content-range': 'bytes 0-999/5000',
    },
  })
  await assert.rejects(
    () => fetchArticle('https://example.com/partial', { fetchImpl: partial }),
    (error) => error instanceof HNError && error.code === 'article_body_incomplete',
  )

  const paywallHtml = `<!doctype html><html><body><article><h1>Preview</h1><p>${'Opening paragraph. '.repeat(40)}</p><p>Subscribe now to continue reading.</p></article></body></html>`
  const paywall = async () => new Response(paywallHtml, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })
  await assert.rejects(
    () => fetchArticle('https://example.com/paywall', { fetchImpl: paywall }),
    (error) => error instanceof HNError && error.code === 'article_paywalled',
  )

  const restrictedMetadata = JSON.stringify({
    '@type': 'NewsArticle',
    isAccessibleForFree: false,
    articleBody: 'Restricted article body. '.repeat(40),
  })
  const restricted = async () => new Response(
    `<!doctype html><html><head><script type="application/ld+json">${restrictedMetadata}</script></head><body><article><p>${'Visible preview. '.repeat(40)}</p></article></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html' } },
  )
  await assert.rejects(
    () => fetchArticle('https://example.com/restricted', { fetchImpl: restricted }),
    (error) => error instanceof HNError && error.code === 'article_paywalled',
  )
})

test('fetchArticle rejects oversized and unreadable bodies rather than clipping them', async () => {
  const oversized = async () => new Response('tiny', {
    status: 200,
    headers: { 'content-type': 'text/plain', 'content-length': '5001' },
  })
  await assert.rejects(
    () => fetchArticle('https://example.com/large', { fetchImpl: oversized, maxBytes: 5_000 }),
    (error) => error instanceof HNError && error.code === 'article_too_large',
  )

  const unreadable = async () => new Response('<html><body><p>short</p></body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })
  await assert.rejects(
    () => fetchArticle('https://example.com/short', { fetchImpl: unreadable }),
    (error) => error instanceof HNError && error.code === 'article_unreadable',
  )
})

test('a partial article marker can never pass the transcript guard', () => {
  assert.throws(
    () => threadToTranscript({
      ...baseThread,
      articleUrl: 'https://example.com/long',
      article: {
        url: 'https://example.com/long',
        text: 'BEGIN\n\n[HNR ARTICLE TRUNCATED]',
        complete: false,
        truncated: true,
      },
    }),
    (error) => error instanceof HNError && error.code === 'article_incomplete',
  )
})
