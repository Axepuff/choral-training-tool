# Working on this project

## Workflow

- Start from current `main`; inspect the working tree and preserve unrelated edits.
  In cloud environments, use the existing checkout; create worktrees only on request.
- Read the target Issue and dependencies. Implement only its scope, after dependent
  contracts are accepted. Use `issue-<number>-<description>` and one PR per task.
- Code and GitHub determine current state. Report documentation discrepancies:
  `docs/handoff.md`, `docs/architecture.md`, and `docs/roadmap.md` contain historical
  stages; read later supplements before treating old limitations as current.
- Update affected contracts/docs. PRs describe the problem, new behavior, checks,
  limitations, and `Closes #N`. Do not merge automatically.
- Queue work: read `docs/local-automation.md` and `scripts/agent-queue/policy.mjs`.
  Only the controller may merge the explicitly authorized #2–12, #14–15, #31 after
  required checks and clean independent review. No authorization extends to new
  Issues; #13, production #16, and controller update #32 require manual PRs.

## Architecture and scope

React/TypeScript/Vite and CSS Modules at the root; Go/SQLite/FFmpeg in `backend/`.
One service serves API and frontend on one origin with persistent private storage.
Runtime has real sessions, songs, uploads, sharing, and Web Audio playback.
Mocks belong in stories/tests or explicit Pages demo (`VITE_APP_DEMO=true`), never
as runtime fallback or fake success. Pages cannot run Go.

Preserve React and the approved design. Avoid incidental dependency/version changes.
Recording, self-registration, social login, payments, and redesign require a task.
Account administration API/UI is #13; production rollout is #16, not implied by
container readiness. Check live Issues for status.

## UI design: soft neumorphism

- Every new or modified UI component must follow the approved soft-neumorphic
  style in runtime, Storybook, and prototypes. Before UI work, read the current
  Issue #52 design section in `docs/handoff.md` and reuse existing components.
- Use CSS Modules and the shared tokens in `src/styles/tokens.css` for colors,
  typography, radii, spacing, and shadows. Keep these values centralized.
  The base is light `#F4F5F7`, with orange `#FD7202` accents and dark readable text.
- Raised neutral controls use `--background-control` and `--color-control-border`:
  their face is lighter than the page. Buttons, slider thumbs, and raised surfaces
  use `--shadow-raised` (or `--shadow-card`): a tight contact shadow, upper-left
  white highlight, and small inset bevel keep the relief close to the surface.
- Fields and waveform wells use `--shadow-inset`; pressed/selected raised controls
  use `--shadow-pressed`. Choose the token by the surface's role and interaction
  state when adding controls.
- Inherit the locally bundled Jost through `--font-family`: headings 300 with
  gentle positive letter-spacing, body/input/button text 400, labels and restrained
  emphasis 500. Reuse the existing type scale and keep Cyrillic support.
- The whole app is recessed inside one white rounded rim reaching the viewport
  edges. Reuse the shell in `src/styles/global.css`; page components supply content
  within that shell, without another outer frame or gray surround.
- Preserve semantic colors (yellow Solo, burgundy Mute, track/error colors), dark
  text on orange fills, and the global visible focus outline. State changes must
  remain clear through color/text and semantics as well as relief. Check applicable
  hover, active/selected, disabled, and keyboard-focus states in existing stories
  at the viewport sizes below, following the Validation section.

## Read before changing an area

- **Architecture/dependencies:** `docs/architecture.md`, `docs/roadmap.md`.
- **API, data, validation, migrations:** `docs/api/openapi.yaml`, `docs/api/README.md`,
  `docs/decisions/0001-mvp-contract.md`, `docs/backend.md`. Match frontend/backend
  limits and Unicode counting to the contract.
- **Auth, roles, public access:** `docs/authentication.md`, `docs/frontend-auth.md`,
  `docs/backend.md`. Preserve login limits, Argon2id outside DB transactions, and
  account rechecks before session creation.
- **Forms, uploads, filenames, sharing:** `docs/frontend-songs.md`.
- **UI:** approved UX in `docs/handoff.md`; reuse application/Storybook components.
  Light, compact layout with one page padding, no outer gray cards/demo headers;
  44 × 44 px targets. Check 320/360 px, landscape, desktop; never mask page overflow.
  Preserve the title "Песни", guest search/sort, and editor-only create/edit/link actions.
- **Player/mixer/timeline:** `docs/audio-player.md` and handoff UX. Preserve yellow
  Solo, exclusive Solo/Mute, all-Solo reset, faint backing waveform, scrollbar-free
  timeline swipes, shared cursor/clock, inclusive bar loops, and metronome.
- **Containers, proxy/TLS, backup/restore, deployment:** `docs/operations.md`.
  Prepare configuration and verifiable instructions before requesting owner hosting
  or secrets. Protect public tokens from proxy access/error logs.
- **MCP:** run `npm run storybook`, then `npm run check:mcp`; protocol success does
  not prove client tool activation. Pages does not run MCP.

## Validation

- Read `docs/e2e.md` for commands, prerequisites, and coverage; required CI checks
  live in `.github/workflows/checks.yml`, scripts in `package.json`. Run frontend
  commands from the root and Go commands from `backend/`. Verify `go version`
  against `backend/go.mod`; system Go may be too old.
- Build is not browser proof: `test:stories` runs all built stories/play;
  `test:e2e` builds isolated runtime/demo and tests real Go/SQLite/FFmpeg flows.
  Ordinary `go test` excludes opt-in browser tests. Run container smoke/restore
  and proxy-log checks separately per operations docs.
- Test behavior, especially authorization, persistence, processing failures, and
  synchronization; avoid tests that merely mirror implementation.
- Report skipped checks and distinguish local results, remote CI, and physical
  devices. Mobile viewport emulation is not device testing; check Issue #34 and
  audio QA for device evidence. Do not present cloud localhost as a usable preview.
- Markdown-only changes: verify sources/links and run `git diff --check`.

## Security

- Enforce roles, ownership, and public-token scope on the server: teachers edit
  their songs, admins all songs/accounts, guests only read published content.
  UI visibility and query parameters are not authorization.
- Keep passwords, keys, cookies, tokens, original audio, and production databases
  out of Git/logs/reports; use fictional fixtures.
- Delete originals only after conversion is validated and its result committed.
