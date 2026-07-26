# Deployment

## Status: enabled

The repository was made public and GitHub Pages is enabled, sourced from GitHub
Actions:

```
$ gh api -X POST repos/metygl/ad-racers/pages -f build_type=workflow
{ "build_type": "workflow", "html_url": "https://metygl.github.io/ad-racers/" }
```

**Site URL:** <https://metygl.github.io/ad-racers/>

The site publishes when `.github/workflows/deploy.yml` runs, which happens on
every push to `main`. Until the first such push lands the URL will 404 — Pages
is configured but has no artefact yet. Nothing further is needed to make it
work.

### Why it was blocked before

For the record, since the workflow was written against this constraint: while
the repository was private, enabling Pages returned

```
422 "Your current plan does not support GitHub Pages for this repository."
```

GitHub Pages publishes from a private repository only on a paid plan; on the
Free plan it is available for public repositories only. Making the repository
public was chosen over upgrading the account or moving to another host.

Note that a Pages site is publicly readable regardless of repository
visibility — access control for Pages is an Enterprise feature. Publishing the
game was always going to mean publishing the game.

## What is already in place

### Build

`vite.config.ts` bakes in the Pages sub-path for production and allows an
override:

```ts
const base = process.env.BASE_PATH ?? (isProduction ? '/ad-racers/' : '/');
```

Every emitted file has a content hash, so a deploy can never serve a stale mix
of old and new chunks, and the CDN can cache aggressively.

### Workflow

`.github/workflows/deploy.yml` runs on every push to `main`:

1. Install with `npm ci`.
2. Re-run typecheck, lint and the unit tests. Deliberately repeated rather than
   trusting the CI job — a deploy is the one place where shipping a broken
   build has consequences beyond a red tick.
3. Build with `BASE_PATH="/${GITHUB_REPOSITORY#*/}/"`, so the base path is
   derived from the repository name and a fork under a different name works.
4. Check the download budget.
5. Upload and deploy via `actions/deploy-pages`.

Permissions are the minimum Pages needs (`contents: read`, `pages: write`,
`id-token: write`). Concurrency is `group: pages` with
`cancel-in-progress: false` — a half-published site is worse than a slightly
stale one.

Pull requests are verified by `ci.yml` but never published.

### Enabling it, once the plan allows

Either flip **Settings → Pages → Source → GitHub Actions** in the repository
settings, or:

```bash
gh api -X POST repos/metygl/ad-racers/pages -f build_type=workflow
```

Then push to `main`. The site appears at
`https://metygl.github.io/ad-racers/`.

## Serving it anywhere else

The output is plain static files with no server requirements — no redirects, no
rewrites, no headers beyond the defaults.

```bash
npm run build          # base path /ad-racers/
BASE_PATH=/ npm run build   # base path is the domain root
npx serve dist
```

Because the game makes no network requests after load, it works from a file
server, a CDN, or an intranet with no internet access at all.
