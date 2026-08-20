# AGENTS.md — Roundtable

Single-file, dependency-free web app (`index.html`) — a collaborative family
tree. Static-hosted on GitHub Pages at `famroundtable.com`. Backend: Supabase
(boards table, realtime, presence; optional Stripe + email/SMS Edge Functions in
`supabase/functions/`).

## Analytics — Mixpanel

- **Tool:** Mixpanel (product analytics). Platform: **web / browser JS**.
- **SDK:** official Mixpanel browser snippet, loaded in `index.html` `<head>`
  (`mixpanel-2-latest.min.js`), initialized inline with the project token.
- **Token location:** hardcoded in the `mixpanel.init(...)` call in `index.html`
  (single production token). No dev/prod split yet.
- **Config:** `track_pageview:false`, `persistence:"localStorage"`,
  `disable_cookie:true` (cookie-free), super-props `platform:web`, `app:roundtable`.
- **Identity:** none — the app has **no accounts** (name + shareable board code
  only). Events use Mixpanel's anonymous device id. **Do not** call
  `identify()` / `people.set()` / create profiles.
- **Consent:** opt-in gate. Mixpanel inits with `opt_out_tracking_by_default:true`;
  a bottom banner (`consentBanner` in `index.html`, shown when `state.consent===null`)
  asks consent. Accept → `opt_in_tracking()`, Decline → stays opted out. Choice is
  stored in `localStorage["roundtable:consent"]` and restored on boot via
  `applyConsent()`. No events send before consent.
- **Helper:** `track(name, props)` in `index.html` — safe no-op if the lib is
  blocked. Use snake_case event names, lowercase string values, unquoted numbers.

### Value Moment
`person_added` — a relative added to the tree.

### Events (all in `index.html`)
| Event | Where | Properties |
|-------|-------|-----------|
| `board_created` | `onStartBoard` | `has_contact` |
| `board_joined` | `onJoinBoard` / deep-link boot | `via` (code_entry \| link), `has_contact` |
| `person_added` ⭐ | end of `saveEdit` (new) | `relation` (child\|parent\|sibling\|root), `has_partner`, `demo` |
| `person_removed` | end of `removePerson` | `mode` (one \| subtree) |
| `board_share_opened` | `onOpenShare` | — |
| `projection_opened` | `onOpenProjection` | — |
| `view_changed` | `onToggleView` | `view` (list \| radial) |
| `tree_downloaded` | `onDownloadPdf` / `onDownloadImage` | `format` (pdf \| image) |
| `upgrade_started` | `onSubscribe` | — |
| `upgrade_completed` | boot, `?paid=1` return | — |

### Governance TODO (Mixpanel dashboard)
- Add Lexicon descriptions for each event above.
- Enable Data Standards (require snake_case) + Event Approval.
- Verify **Simplified ID Merge** is on (Project Settings → Identity).
- Consider a separate **dev** project/token before heavy iteration.
