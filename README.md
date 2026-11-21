# Quick start — `python run.py`

Run from the **project root directory** after extraction:

```bat
python run.py
```

The launcher uses the existing `.venv` environment when present, and if
required Python dependencies are missing on Windows it launches the existing
PowerShell bootstrap (which installs missing tools). GitHub and Cloudflare
browser logins and archives are reused. First-time runs ask for rights
confirmation and whether to shut down Windows after a fully verified finish;
that choice is saved for future runs in `.archiver_state/run_preferences.json`.

**Reader controls:** Shift+Enter opens/closes the minimalist right-side chapter
navigator; X or Escape closes it. The panel contains chapter titles and
search, scrolling speed and auto-scroll. Ordinary Enter toggles auto-scroll.
No wheel-event listeners are installed. The active reading surface remains
image-only while the panel is closed.

**One-file source adapter:** `site_specific/site_adapter.py` contains every
website-specific selector and chapter-title extraction rule. The reusable
engine always expects a chapter title in its published JSON (`title`), using
the native chapter label as fallback for older GitHub archives; it never
redownloads verified images to add title metadata.

**Keep both roles:** `<slug>-reader` (GitHub) and `<slug>-vol-001` (GitHub) are
respectively application source and permanent image archives. Their respective
Cloudflare Pages projects serve the reader frontend and image assets. An
asset-volume `.pages.dev/` root may have no homepage and still be essential.
Use `python run.py --audit-resources` to see these dependencies. This command
is non-destructive; no remote repository or project is deleted automatically.

**Deployed URL in README:** After verified publication the application writes
the actual reader URL into the root GitHub README of the reader repository,
into the image-volume README and into this local README. It does not invent a
URL before Cloudflare confirms the deployment.

---

# GitHub-First Resume — No Repeat Traversal or Lazy Scrolling

**Run the setup again on the same existing project folder.** The new release
checks `.archiver_state/state.sqlite`, the old `events.jsonl` chapter discovery
record, and the existing GitHub volume repositories **before starting Firefox**.
It supports both the pre-modular and current modular archive state and the
volume structure they used.

- **All 60 Webtoon episodes already archived:** inspect GitHub remote trees and
  chapter manifests; do **not** reopen Webtoon, discover/traverse episodes,
  lazy-scroll images, redownload, or push the old episodes. Continue only with
  unpublished Cloudflare content. The source site's chapter count from the
  attached page is stored as a recovery hint in `site_specific/site_adapter.py`.
- **Partially archived series with a saved complete chapter list:** skip the
  original chapter-list traversal and process only chapters not already
  verified on GitHub. Each missing chapter still uses proper progressive
  lazy scrolling and image integrity checks.
- **Push succeeded but SQLite update was interrupted:** independently fetch
  GitHub image bytes and verify SHA-256 for that *untrusted* chapter; restore
  its record and finish local image cleanup, rather than downloading again
  from the publisher site. Already trusted image bytes are not fetched again:
  GitHub manifests and paths are checked instead.
- **Local SQLite state lost:** search this account's repositories matching the
  site-specific series slug. Rebuild archive records from their chapter
  manifests and SHA-256-verified files. If the remote cannot be verified,
  stop safely; never silently create duplicates or redownload as a fallback.
- **Already published and unchanged:** reuse verified Cloudflare volume and
  reader deployments rather than issuing redundant Wrangler uploads.

Inspect the intended action before a run (requires your saved isolated GitHub
browser authentication):

```bat
.venv\Scripts\python.exe comic_archiver.py --archive-needed
```

`READY` means no source-site traversal is needed; `NEEDS_ARCHIVE` means some
chapters genuinely require work. Remote Git failures stop rather than
misleadingly returning `NEEDS_ARCHIVE`. To publish only without even invoking
an archive preflight:

```bat
.venv\Scripts\python.exe comic_archiver.py --deploy --authorized
```

**Only if you explicitly want to look for newly published episodes**, run:

```bat
.venv\Scripts\python.exe comic_archiver.py --archive --refresh-chapters --authorized
```

This refresh uses the original website again but still skips already archived
chapters. Both setups preserve `.archiver_state`, GitHub/Cloudflare browser
credentials, and existing Git identity configuration. **Never delete the
application state folder to upgrade.** The ZIP deliberately excludes state,
browser profiles, and credentials.

---

# Firefox + One-File Site Adapter + Windows Cloudflare UTF-8 Fix

**This version is a full replacement ZIP, not an isolated script.** It preserves
existing `.archiver_state/`, all verified GitHub archive data, isolated GCM
credentials, and Cloudflare browser login.

## Two strictly separate source-code sections

- `reusable/` is provider-independent and site-independent: generic chapter
  discovery, careful scrolling, Firefox/Chromium profile management, download,
  GitHub archive/verification, local deletion, Cloudflare publication, reader,
  quota handling, and logging.
- `site_specific/site_adapter.py` is **the ONLY file you need to edit** for a
  different source site. It defines the allowed hosts, title/image selectors,
  native chapter list/next/previous selectors, page-number identity, and the
  Chrome/Edge extension site scope. No generic algorithm, credentials, or
  provider code should be modified for a new site. Run
  `python comic_archiver.py --refresh-extension` after editing.

`comic_archiver.py` is a compatibility entry point. The Webtoon adapter in the
current ZIP matches the HTML source already supplied. The same downloaded
browser extension remains scoped to the site's original URL.

## Firefox headless

The source crawler now defaults to **Playwright Firefox**, with an independent
Firefox profile per domain under `.archiver_state/source_browser_profiles/firefox`.
It starts *visible on the first successful Firefox session*, then runs headless
on subsequent runs using the saved profile. `--source-visible` overrides auto;
`--source-headless` forces headless after Firefox has been initialized;
`--source-browser chromium` explicitly restores Chromium with its own profile.
Firefox and Chromium both support headless: source lazy-loading is handled by
progressive DOM scrolling and page-image detection, not by needing a visible UI.

## Cloudflare deployment failure fixed

Your run already archived 60 episodes (1164 images). Wrangler emits UTF-8 while
Windows Python subprocess may default to cp1252, causing UnicodeDecodeError and
then `re.findall` TypeError on `None` output. All Wrangler commands now capture
raw stdout/stderr and explicitly decode using UTF-8 with replacement errors.
Account selection checks output safely. The setup detects fully archived state
and **skips source browsing**, publishing from GitHub directly.

## Install

Extract the ZIP over the previous `ComicArchiver` project directory, without
manually deleting `.archiver_state`. Run `setup_and_publish.ps1`. It installs
Playwright Firefox and runs the existing GitHub/Cloudflare browser login checks.
For an already complete GitHub archive, the deployment phase starts without
re-downloading or opening the source browser.

To bypass all source work and deploy directly:

```powershell
& .\.venv\Scripts\python.exe comic_archiver.py --deploy --authorized
```

To force a visible source session for a NEW source:

```powershell
& .\.venv\Scripts\python.exe comic_archiver.py --archive --authorized --source-visible --source-url "https://example.com/episode/1"
```

To inspect the adapted extension: `python comic_archiver.py --refresh-extension`.

No site bypassing, proxy rotation, CAPTCHA evasion, or fingerprint spoofing is
implemented. Provider and publication operations still require valid account
permissions and rights to redistribute the comic. Live deployment has not been
verified in this packaging environment.

---

# Universal Comic Archiver + Cloudflare Reader — Python Project

## Windows persistent-browser lifecycle hotfix (2026-11-20)

This release fixes a reproducible source-browser lifecycle bug in URL-first archiving: the previous release loaded the starting URL into the sole persistent Chromium tab and then called `live_page.close()` before chapter discovery. On some Windows Chromium sessions, that closes the whole context, causing `BrowserContext.new_page: Target page, context or browser has been closed`. The first source tab is now deliberately kept open until the archive run closes the context. A regression test prevents reintroducing the bug.

**Keep the dedicated Chromium window open while archiving; you can minimize it.** If the window closes unexpectedly, the program now explains the error and preserves the app's `.archiver_state` rather than silently discarding session state.

Upgrade by extracting this ZIP over the previous project folder, preserving `.archiver_state`, and rerunning `setup_and_publish.ps1`. Existing app-selected GitHub account, Cloudflare authorization and website browser profile are reused when valid. No terminal global Git configuration is changed.


This is **source code**, not another LLM prompt. It is a browser-assisted archival tool for material you have permission to download **and publicly republish**. It does not bypass paywalls, DRM, CAPTCHAs, or website login restrictions. The supplied sample HTML is from a third-party comic publisher; its presence does not grant redistribution rights.

## What is implemented

- Inspect the live comic page directly by URL, or optionally inspect saved reader HTML. Prefer the site's **native episode list and next/previous navigation**; use supplementary navigation only if needed. The attached sample HTML was used to detect the starting URL; the app then reads the real page itself.
- Open the source pages through Playwright, scroll and scan the reader for legitimate lazy images, validate image bytes with Pillow and SHA-256, preserve page order and file formats.
- Browser-based GitHub OAuth through **Git Credential Manager**, explicitly verifying the chosen GitHub username. Per-login credential namespace and isolated per-process Git configuration avoid changing `.gitconfig`, global credential helpers, SSH config, unrelated Git repos, or current terminal Git settings.
- GitHub private repositories, normal Git protocol (never `gh`), native account API repository creation when authorized, otherwise browser-assisted manual repository creation. Chapter-by-chapter Git commits without checking out all previous image files, Git remote readback of **every image SHA-256**, disposable verification copies, immediate deletion of locally managed chapter images **before** downloading the next chapter.
- Per-repository logical byte accounting with 700 MiB target and paced Git pushes; append-only JSONL logs, SQLite resume state, status command. A full GitHub API quota-aware scheduler and automatic OS task resumption are **not implemented** in this release; rate-limit errors pause rather than creating risky workarounds.
- Cloudflare Pages **or** Workers Static Assets deployments through a locally installed Wrangler, using browser sign-in, account selection, asset-size validation and deployment rebuild from GitHub. Previously published assets are reconstructed for a full deployment. Live production asset checksum verification is performed for sample files; the reader index is fetched and checked.
- GitHub reader-source repository, `manifest.json` chapter index, centered image-only reader, `requestAnimationFrame` automatic scrolling, Enter toggle, native arrow navigation, persistent preferences and fullscreen. A separate settings page has a speed slider.
- A Chrome/Edge MV3 extension scoped to the original HTML source host, replacing clutter and using original-site chapter links without changing source website URLs. The extension uses **no wheel listeners**. It adapts known layouts but cannot guarantee compatibility with every virtualized or access-controlled website.

## Fast Windows setup

Unzip the downloaded project into a dedicated folder, then run `setup_and_publish.ps1`. It installs local dependencies, opens GitHub and Cloudflare browser authorization when needed, uses the bundled source webpage URL or a different URL you supply, requests explicit redistribution-rights confirmation, and starts archiving and deployment. **There is no HTML file picker.** The Windows setup automatically installs missing Node.js LTS/npm with Windows Package Manager (winget), if available; the official installer may request elevation. Python and Git for Windows with GCM must already be installed. If winget is unavailable, setup prints the official Node.js download link.

Do not enable public deployment for third-party comics without an appropriate license.

### Inspect without downloading anything

```powershell
python comic_archiver.py --inspect --source-url "https://example.com/comic/chapter-1"
```

### Authenticate in an isolated Git namespace

```powershell
python comic_archiver.py --github-login
python comic_archiver.py --github-account
```

### Archive, delete verified local chapter images, publish

```powershell
python comic_archiver.py --archive --source-url "https://example.com/comic/chapter-1" --authorized
python comic_archiver.py --deploy --cloudflare-mode pages --authorized
```

For Workers Static Assets, use `--cloudflare-mode workers` for deployment. Each deployment requires authorized assets and the applicable platform limits.

### Resume and see status

```powershell
python comic_archiver.py --resume --authorized
python comic_archiver.py --status
```

The `--resume` option uses the last saved source URL (or an optional HTML source if needed). It is safe to rerun completed chapter checks, but does not automatically schedule future execution at provider quota-reset times.

### Source-URL handling and browser extension

The Cloudflare reader uses its own ordinary HTTPS deployment URL. It **cannot preserve an unrelated original publisher's domain**. The separate browser extension uses native navigation inside the original website and retains its legitimate page URL. The extension matches the domain extracted from the live reader URL once archiving starts. Load `extension/` as an unpacked extension through `chrome://extensions` or `edge://extensions` (Developer mode). Site CSS and virtualized readers vary; test with the target site before trusting unattended progress.

## Important authentication details

GitHub: the application launches GCM's browser OAuth flow without asking you for a GitHub username or manual API token, then displays and confirms the authenticated account. If the browser authenticated the wrong user, switch accounts in the browser and retry; there is no fallback to the terminal's existing GitHub credentials. GCM's encrypted credentials are stored in an application-specific namespace, and later runs reuse them while valid. Existing global Git config is untouched. You never need to manually register an OAuth app or generate a token.

Cloudflare: `wrangler login` opens a browser flow. Wrangler authorization is reused while valid, and account selection uses the output of `wrangler whoami`. Manual service enrollment or billing approval, if required by Cloudflare, **cannot be automated by ordinary sign-in**. No Google Cloud Console or personal API token setup is required by this project.

For GitHub repository creation, the GCM OAuth token **may** lack the required API authorization. The script attempts the official repository API and, if blocked, opens the normal private-repository creation screen. This cannot be truthfully guaranteed as a login-only flow in every account.

## Quotas and safeguards

| Provider | Relevant limit | Implementation behavior |
|---|---|---|
| GitHub | 100 MB single Git object | Validates before upload |
| GitHub | 2 GiB push | Intended small chapter commits; if a chapter exceeds safe push size, stop rather than claim successful chunking |
| GitHub | 6 pushes/min/repo recommendation | Paces at 4 per minute |
| GitHub | 10 GB `.git` size recommendation | Uses conservative 700 MiB *logical* target; measured compressed Git history is not yet accounted for |
| Cloudflare Pages Free | 100 projects/account | Checks Pages project count before creating |
| Cloudflare Pages/Workers Free | 20,000 files/project or Worker version | Enforces max and targets 18,000 files through Git volume rotation |
| Cloudflare Pages/Workers | 25 MiB static asset file | Refuses oversized assets without lossy conversion |
| Pages Free | 500 builds/month (applicability depends on deployment mode) | Uses direct deployments; does not claim to know unavailable monthly usage |
| Workers Free | Script requests separately metered | Uses static asset-first mode, no Worker code for images |

Provider limits can change. Verify against GitHub repository limits, Cloudflare Pages limits, and Cloudflare Workers static-asset limits before unusually large runs. The project does **not** guarantee free unlimited storage or automatic quota-reset resumption.

## Runtime state

`.archiver_state/state.sqlite` contains series/chapter/repository/deployment records; `.archiver_state/events.jsonl` tracks decisions, measurements, remote verification, cleanup and errors. Neither includes access tokens. Do not delete this directory if you want resumability.

## Known limitations and live testing

Offline tests cover native HTML parsing, static image counting, isolated environment construction, and a real local bare-Git push/fetch/checksum verification. **No real comic images were downloaded, no GitHub or Cloudflare account was accessed, and no live hosted website was deployed during packaging.** Website behavior, browser authentication, GitHub repository creation, dynamic image discovery, and Cloudflare uploads still need integration verification on your machine. The pipeline pauses safely on unverified remote assets rather than deleting them. Source images showing no stable total page count can require source-specific adapter improvements.

The full wish list (automatic source-site adapter generation for every website, an adaptive long-wait scheduler, monthly quota telemetry from all accounts, automatic partial-chapter splitting, and fully verified browser compatibility for all source websites) is not all implemented. This is an executable implementation, not a guarantee of those untested functions.

## Updated source-browser persistence and safe rate handling

**This version replaces the old fresh headless Playwright context.** Normal
archiving now launches a **visible Chromium window** with a dedicated persistent
profile for the original source domain. Cookies, local storage and other
supported session state remain in `.archiver_state/source_browser_profiles/`
between runs, including after a computer restart while the website's session
remains valid. The browser window itself closes at the end of a run; its
on-disk session survives. The archiver never reads or changes the user's
normal Firefox/Chrome profiles. Keep the browser profile directory private;
it can contain active website login sessions.

For a one-time manual login to the comic **source website** (independent of the
GitHub/Cloudflare account logins), run:

```powershell
python comic_archiver.py --source-login --source-html "C:\path\reader.html"
```

The dedicated browser opens. Sign in normally if necessary, then press Enter
in the terminal. For normal archiving, use the same setup/bootstrap command as
before. It will reuse the source profile automatically. For optional background
runs with an **already created** profile, add `--source-headless` to the
`--archive` or `--resume` command. Use the visible mode when signing in.

The source browser stops safely if it encounters an explicit HTTP 401/403,
429 rate limit, login wall, or detectable CAPTCHA/bot challenge. On HTTP 429,
it records the server's `Retry-After` (seconds **or** HTTP date), or a
conservative fallback, in `.archiver_state/source_cooldowns.json`; the
cooldown survives a restart. Normal navigations and Python image fetches are
paced **per source domain** to reduce unnecessary traffic. A long cooldown
pauses the archive rather than switching accounts, proxies, identities, or
trying to defeat the site's protections.

The optional `--source-headless` flag does not guarantee that a website will
permit automation. There is no stealth/fingerprint spoofing, CAPTCHA-solving,
proxy rotation, or other detection evasion in the package. The browser keeps
its normal automation characteristics and honors access decisions. Source
website behavior and live account flows remain unverified outside offline
tests. Do not publicly republish comic images without the appropriate rights.

## Browser-first setup (new)

The old first-run HTML file picker was a mistake. **It has been removed.** The
setup now runs three stages: (1) actual GitHub browser OAuth through isolated
Git Credential Manager, (2) actual Cloudflare browser authorization through
Wrangler, and (3) read the comic directly from its normal website URL.

For the attached *The Stories of Those Around Me* source, the canonical episode
URL is provided as input in `source/starting_url.txt`. The implementation is
still universal: to use a different website, pass `-SourceUrl 'https://...'`
to `setup_and_publish.ps1`, or replace that plain URL file. **No saved HTML
file is needed.** The optional `-SourceHtml` parameter remains available for
advanced offline inspection.

Example from Command Prompt after extracting the ZIP:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup_and_publish.ps1
```

After initial authorization, credentials are reused while valid; the script
does not sign you out after running. This app still requires permission to
redistribute images publicly and will explicitly ask for that permission.
Cloudflare or GitHub can request further consent or browser confirmation; it
cannot always create resources with sign-in alone. The first-run OAuth flows
have not been tested against your live accounts in the packaging environment.

## Fully automatic prerequisites (Windows)

`setup_and_publish.ps1` automatically installs missing Python 3.13 and Node.js LTS using `winget`, then installs the Python packages, Playwright Chromium, and project-local Wrangler. If Git Credential Manager is unavailable, it downloads the official **PortableGit for Windows** release into `.archiver_tools/PortableGit`, only for this project (no `git config --global` or system Git changes). The program prepends tool paths to its *process* PATH only. Authentication still requires ordinary browser sign-in and authorization; neither account credentials nor login can be created without user consent. If Windows Package Manager is unavailable, the script stops rather than installing untrusted executables.

For a fresh install, download the complete project ZIP, extract it into `Downloads/ComicArchiver`, and run `setup_and_publish.ps1`. Re-running is safe.

## Original-site lazy scrolling (latest fix)

Chapter acquisition scrolls the **original website** in small increments
(~55% of a viewport, up to 560px), allowing source-side IntersectionObserver
and lazy-loading code to reveal additional panels. It scans reader images
after every increment and observes late `src`, `data-src`, and DOM mutations.
It will only finalize after reaching the real document bottom, seeing five
consecutive stable checks, satisfying any declared image count, and finding
no unresolved image slots. Missing known panels stop archival rather than
producing an incomplete GitHub archive. This does **not** use scroll-wheel
synthetic events, does not change reader URLs, and does not bypass access
restrictions. The browser extension and Cloudflare reader retain their
separate refresh-rate-synchronized manual/automatic scrolling systems.

Use the latest ZIP for the combined Windows persistent-browser lifecycle fix
and lazy-scroll improvements. The account credentials and profile in
`.archiver_state/` are not packaged or deleted by source updates.

## Visible Cloudflare deployment progress and optional Windows shutdown

Cloudflare publication now shows distinct live stages:

- `GitHub volume download` — one Git fetch for a previously verified image volume; elapsed-time heartbeat and Git-reported transfer progress.
- `Building Cloudflare assets` — accurate progress bar using the **actual number of recovered, SHA-256-verified images**. It reconstructs images from GitHub, **not the original comic website**, so saved chapter traversal and lazy scrolling are never repeated for an already archived chapter.
- `Cloudflare Pages upload` / `Cloudflare Workers upload` — Wrangler's upload messages plus a heartbeat every few seconds; a percentage is shown only when there is a measured denominator.
- `Verifying Cloudflare public URL` — live heartbeat during HTTP checks and transparent retries.
- `COMPLETED` / `RUN COMPLETE` — terminal exits normally after the entire catalog has been verified and published. Unchanged verified deployments are reused.

**Windows shutdown is opt-in.** On startup, `setup_and_publish.ps1` asks whether to shut down automatically **after** fully verified Cloudflare publication. For fully unattended runs, use `setup_and_publish.ps1 -Authorized -ShutdownWhenDone` (only if you've already confirmed your rights) or `python comic_archiver.py --deploy --authorized --shutdown-on-complete`. To suppress the question without shutdown, use `-NoShutdownPrompt`. No shutdown is requested after a failed upload, a missing chapter, a partial publication, or archive-only work. Windows shutdown is scheduled **60 seconds** in advance; cancel during this window with `shutdown /a`. Windows may close other open applications when the timer ends: **save any unrelated work before opting in**.

After a Cloudflare-only failure you can run `python comic_archiver.py --deploy --authorized --shutdown-on-complete` from the project directory; the Python engine uses the saved GitHub chapter manifests and skips all completed Webtoon work. The first deployment of 1,164 images still requires transferring the verified archived bytes from GitHub to Cloudflare, even though no original source redownload is necessary.

GitHub-first recovery itself now prints `GitHub archive metadata` heartbeats and a per-chapter manifest progress bar. Existing verified chapters are checked against remote manifests without opening the source browser or redoing source lazy scrolling; only missing/untrusted image bytes are independently verified as needed.


## Cloudflare Pages project discovery recovery (2026-11-20)

Wrangler 4.x `pages project list --json` can return human-facing JSON columns
`Project Name` and `Project Domains` rather than API-style `name` and `subdomain`.
The Cloudflare publisher normalizes both shapes. When an earlier run successfully
created a Pages project but failed before its first deployment, the next run
reuses that empty project after checking it contains no deployments; a project
with existing unknown deployments still requires explicit confirmation.

This fix does **not** affect the archive, browser credentials, source adapter,
or published chapter content. Run the normal setup or use `--deploy --authorized`
to resume the pending publication from verified GitHub images. The source website
will not be revisited when the full chapter catalog is already archived.


## Automatic chapter-title reconciliation, including completed archives

`python run.py` now performs a lightweight native chapter-list title check even
if every image has already been archived and the reader is already published.
This is a **metadata-only pass**: the original source is not lazy-scrolled,
comic images are not downloaded again, and existing image Git objects remain
unchanged. The normal run automatically updates stale chapter manifest JSON in
GitHub, then republishes only the lightweight reader if title labels change;
previously published image-volume projects are reused when their image hashes
match. To manually try the site title lookup again after it was unavailable:

    python run.py --refresh-titles --authorized

The page-specific source extraction (Webtoon native `Ep. N - Description`
labels, including punctuation) is **only** in
`site_specific/site_adapter.py`. The generic title reconciliation, GitHub
metadata-only update and reader are entirely under `reusable/`. The generic
engine remembers completed scans by an adapter-content fingerprint, so missing
native titles are safely skipped and do not lead to repeated requests every
run. Changing the single site adapter resets that one-time title check.

### Source-adapter contract — one website-specific file

For the next comic website, change **only** `site_specific/site_adapter.py`.
The entire reader/publisher/archival implementation stays in `reusable/`.
The adapter supplies `SOURCE_NAME`, `STATE_STORAGE_MODE`, `DEFAULT_START_URL`,
`ALLOWED_HOSTS`, `EXTENSION_MATCHES`, source CSS selectors, `chapter_identity`,
`title_from_html`, and optional native-title functions:
`native_chapter_titles_from_catalog(raw_html, page_url) -> dict[str,str]`,
`title_catalog_url(url) -> str`, and `accept_catalog_title(id, label) -> bool`.

All platforms normalize the adapter results into a universal manifest shape:
`{id, number, label, title, images}`. The reusable sidebar reads that schema,
not Webtoon HTML or selectors. A missing or unreliable source title causes
`TITLE_CATALOG_SKIPPED` / `TITLE_CATALOG_RECONCILED` with skipped records,
**never fabricated subtitles, image deletion, chapter re-download, or a failed
publication**.

Automatic title repair includes chapters already marked `PUBLISHED_VERIFIED`.
It compares all 60 catalog entries, so `Ep. 46` is upgraded to
`Ep. 46 - Valentine's Day Post-Mortem` when the native source provides it.
Existing native labels such as `Ep. 1` remain unchanged if the source provides
nothing more. It updates only chapter-manifest Git blobs, updates the reader
chapter index and relevant README links, and reuses already-published Cloudflare
image assets. Normal `python run.py` executes this maintenance once per site
adapter revision. Recheck explicitly using `python run.py --refresh-titles`,
then `python run.py` to republish the reader if any labels changed.


## 2026-11-20 title reconciliation callback hotfix

The native-title reconciliation callback mismatch has been fixed in `reusable/engine.py`. This change affects neither `site_specific/site_adapter.py` nor the verified archive. Extract over the existing project, retain `.archiver_state`, and run `python run.py` from the project root. Already-verified images are not downloaded or pushed again merely to update chapter titles. `python run.py --refresh-titles` forces a title-only metadata audit.


## 2026-11-20 — Windows README checksum and post-deployment recovery

If a previous run said `Reader source remote file checksum mismatch: README.md`
after **Cloudflare deployment completed**, the site itself had succeeded.
The fault was the publisher comparing an LF-only text-string hash to a
Windows-translated CRLF file. Both reader and image-volume README writers now
create exact UTF-8 bytes and verify those bytes from independent Git fetches.

Cloudflare verification is now checkpointed *before* GitHub README updates.
If GitHub documentation synchronization fails, `python run.py` resumes that
small step using the already-published Cloudflare reader and stored manifests.
It checks the entire chapter/title/index mapping and frontend bytes before
reusing a deployment. No original-source crawling, no 1,164-image GitHub
reconstruction, and no redundant Cloudflare upload is required for README-only
recovery. Reader source Git commits are idempotent; GitHub chapter image blobs
are not modified by README updates.

If desired, run `python run.py --deploy --authorized` to retry publication
metadata without the full archive preflight. The regular command remains
`python run.py`. All website-specific extraction remains in the ONE editable
`site_specific/site_adapter.py`; this fix is reusable infrastructure only.
