// Keep the legacy Node server on the exact same fail-closed acquisition path
// as the production Cloudflare Worker. A second implementation previously
// retained the old sampled comments and clipped-article behavior.
export * from '../worker/hn.mjs'
