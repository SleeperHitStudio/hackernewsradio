<wizard-report>
# PostHog post-wizard report

The wizard integrated PostHog analytics into the HNR frontend. `posthog-js` was installed and initialized in `web/src/main.jsx` using Vite environment variables. Twelve events covering the full user journey — from episode generation to audio playback and social sharing — were instrumented in `web/src/App.jsx`. No existing code was altered; all PostHog calls are additive.

| Event name | Description | File |
|---|---|---|
| `episode_generation_submitted` | User submits a HN thread URL via the form | `web/src/App.jsx` |
| `episode_generation_auto_started` | Episode generation triggered automatically from `?url=` / `?id=` param | `web/src/App.jsx` |
| `episode_generation_errored` | Generation API call returned an error shown to the user | `web/src/App.jsx` |
| `episode_deep_link_viewed` | User lands on a specific episode permalink `/e/:hnId` | `web/src/App.jsx` |
| `episode_playback_started` | User pressed play on an episode's audio player | `web/src/App.jsx` |
| `episode_link_copied` | User clicked "Copy link" to copy a shareable episode URL | `web/src/App.jsx` |
| `episode_shared_social` | User clicked a social share button (X, Facebook, or LinkedIn) | `web/src/App.jsx` |
| `episode_shared_native` | User tapped the native device share sheet | `web/src/App.jsx` |
| `rss_subscribe_clicked` | User clicked the RSS Subscribe link | `web/src/App.jsx` |
| `create_podcast_modal_opened` | User opened the "Create your own podcast" modal | `web/src/App.jsx` |
| `create_podcast_cta_clicked` | User clicked the Sleeper Hit Studio CTA inside the modal | `web/src/App.jsx` |
| `episode_search_performed` | User typed in the episode search bar (captured after 250ms debounce) | `web/src/App.jsx` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics (wizard) — Dashboard](https://us.posthog.com/project/509489/dashboard/1837793)
- [Episode generation → playback funnel](https://us.posthog.com/project/509489/insights/2I5DCGT4)
- [Episode generations over time](https://us.posthog.com/project/509489/insights/ZmK9kyE4)
- [Social shares by platform](https://us.posthog.com/project/509489/insights/oJOGpRga)
- [Episode sharing & copying](https://us.posthog.com/project/509489/insights/CWHW64u2)
- [RSS & podcast CTA clicks](https://us.posthog.com/project/509489/insights/q0RUaRGN)

## Verify before merging

- [ ] Run a full production build (the wizard only verified the files it touched) and fix any lint or type errors introduced by the generated code.
- [ ] Run the test suite — call sites that were rewritten or instrumented may need updated mocks or fixtures.
- [ ] Add `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST` to `.env.example` so collaborators know what to set.
- [ ] Wire source-map upload (`posthog-cli sourcemap` or your bundler's upload step) into CI so production stack traces de-minify.

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
