# Deployment

## Status: blocked on an account decision

The build and the deployment workflow are complete and tested. The live site is
**not** enabled, for one specific reason:

```
$ gh api -X POST repos/metygl/ad-racers/pages -f build_type=workflow
{
  "message": "Your current plan does not support GitHub Pages for this repository.",
  "status": "422"
}
```

`metygl/ad-racers` is a **private** repository. GitHub Pages can only publish
from a private repository on a paid plan (Pro, Team or Enterprise); on the Free
plan it is available for public repositories only.

Nothing about the project is wrong — `npm run build` produces a correct,
budgeted, base-path-aware bundle, and `.github/workflows/deploy.yml` will
publish it without modification the moment Pages becomes available.

### What would unblock it

| Option | Effect | Cost |
| --- | --- | --- |
| **Make the repository public** | Pages works immediately on the Free plan. The workflow needs no change. | Source code becomes public. |
| **Upgrade the account to GitHub Pro** | Pages works from the private repository. The published *site* is still public — Pages access control is Enterprise-only. | Paid subscription. |
| **Use a different static host** | Netlify, Cloudflare Pages, Vercel and others publish from a private repository on free tiers. | A new account/credential, and a host the brief did not specify. |
| **Ship without a live site** | Everything else is complete; the site is enabled later. | No public URL. |

This is an ownership decision about public exposure and billing, so it is not
one to make silently. The brief is explicit that a different host must not be
substituted without saying so.

---

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
