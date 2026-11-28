#!/usr/bin/env python3
"""One-command entry: python run.py (from the extracted project directory).

All site-specific settings live in site_specific/site_adapter.py.  Existing
GitHub, Cloudflare, source-browser profile and SQLite state are reused.
"""
from __future__ import annotations

import json
import ast
import re
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def _relaunch_project_venv() -> None:
    if os.environ.get('COMIC_ARCHIVER_IN_VENV') == '1':
        return
    candidate = ROOT / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if candidate.exists() and candidate.resolve() != Path(sys.executable).resolve():
        env = os.environ.copy()
        env['COMIC_ARCHIVER_IN_VENV'] = '1'
        raise SystemExit(subprocess.call([str(candidate), str(ROOT / 'run.py'), *sys.argv[1:]], cwd=ROOT, env=env))


def _check_dependencies() -> bool:
    try:
        import playwright  # noqa: F401
        import bs4  # noqa: F401
        import requests  # noqa: F401
        import PIL  # noqa: F401
    except ImportError:
        return False
    return True


def _bootstrap() -> None:
    if os.name == 'nt':
        powershell = 'powershell.exe'
        bootstrap = ROOT / 'setup_and_publish.ps1'
        print('Installing missing project dependencies; setup will then continue automatically.', flush=True)
        # During first-time prerequisite installation the PowerShell setup owns
        # the complete run. Let its existing shutdown prompt run interactively.
        flags = []
        if '--shutdown-on-complete' in sys.argv[1:]:
            flags.append('-ShutdownWhenDone')
        elif '--no-shutdown' in sys.argv[1:] or not sys.stdin.isatty():
            flags.append('-NoShutdownPrompt')
        raise SystemExit(subprocess.call([powershell, '-NoProfile', '-ExecutionPolicy', 'Bypass',
                                           '-File', str(bootstrap), *flags], cwd=ROOT))
    print('Install project dependencies with: python -m pip install -r requirements.txt; '
          'python -m playwright install firefox; npm install', file=sys.stderr)
    raise SystemExit(2)


def _preferences() -> dict:
    prefs = ROOT / '.archiver_state' / 'run_preferences.json'
    from site_specific import site_adapter
    current = str(getattr(site_adapter, 'SOURCE_NAME', '') or 'unknown') + ':' + str(getattr(site_adapter, 'SERIES_SLUG_HINT', ''))
    data = {}
    if prefs.exists():
        try:
            data = json.loads(prefs.read_text(encoding='utf-8'))
        except (ValueError, OSError):
            data = {}
    if data.get('source_scope') != current or data.get('rights_confirmed') is not True:
        print('You must have permission to archive and publish the source images.')
        answer = input('Type I HAVE RIGHTS to confirm your permission: ').strip()
        if answer != 'I HAVE RIGHTS':
            raise SystemExit('Stopped without downloading or publishing.')
        data = {'source_scope': current, 'rights_confirmed': True,
                'confirmed_at_utc': datetime.now(timezone.utc).isoformat()}
        # Rights authorization is per source. Shutdown consent is deliberately
        # NOT stored here: it must be reconfirmed for each interactive run.
        prefs.parent.mkdir(parents=True, exist_ok=True)
        temp = prefs.with_suffix('.tmp')
        temp.write_text(json.dumps(data, indent=2), encoding='utf-8')
        os.replace(temp, prefs)
    return data


def _shutdown_choice(args, *, platform=None, interactive=None, prompt=None):
    """Ask on EVERY interactive publish run, not just first-ever rights consent.

    --shutdown-on-complete is explicit opt-in for non-interactive automation;
    --no-shutdown explicitly opts out. Nothing persists a silent yes across runs.
    """
    args = list(args)
    if '--no-shutdown' in args:
        if '--shutdown-on-complete' in args:
            raise SystemExit('Choose either --no-shutdown or --shutdown-on-complete, not both.')
        return [arg for arg in args if arg != '--no-shutdown']
    if '--shutdown-on-complete' in args:
        print('Windows shutdown explicitly enabled after successful verified publication '
              '(60-second cancellation window).', flush=True)
        return args
    if not ({'--deploy', '--resume'} & set(args)):
        return args
    platform = os.name if platform is None else platform
    interactive = sys.stdin.isatty() if interactive is None else interactive
    if platform != 'nt' or not interactive:
        # Never block redirected input or make shutdown the non-interactive default.
        if platform == 'nt':
            print('Shutdown not requested. For unattended operation, pass '
                  '--shutdown-on-complete explicitly.', flush=True)
        return args
    prompt = input if prompt is None else prompt
    print('Publication may close other running applications. Save your work first.', flush=True)
    try:
        answer = prompt('Shut down Windows 60 seconds after ALL comics are verified? [y/N]: ').strip().lower()
    except EOFError:
        answer = ''
    if answer in ('y', 'yes'):
        args.append('--shutdown-on-complete')
        print('Automatic shutdown enabled for THIS run only. '
              'To cancel during the countdown: shutdown /a', flush=True)
    else:
        print('Automatic shutdown disabled for this run.', flush=True)
    return args



def _open_reader_sync_choice(args, *, interactive=None, prompt=None):
    """Archive-only opt-out: keep new GitHub upload verification, skip reader sync.

    This is never remembered: the next run defaults to publishing normally.
    """
    args = list(args)
    if '--skip-open-reader-sync' in args:
        print('Shared Open Reader synchronization skipped by explicit flag.', flush=True)
        return True
    if args and not ({'--resume', '--deploy'} & set(args)):
        return False  # No shared-reader deployment requested.
    interactive = sys.stdin.isatty() if interactive is None else interactive
    if not interactive:
        return False  # Unattended runs retain the existing full-sync default.
    prompt = input if prompt is None else prompt
    try:
        answer = prompt('Sync and verify shared Open Reader (all GitHub/Cloudflare comics) this run? [Y/n]: ').strip().lower()
    except EOFError:
        answer = ''
    if answer in ('n', 'no'):
        print('Archive-only this run: no account-wide GitHub reader scan, Cloudflare '
              'deployment/verification, or README synchronization. Newly archived '
              'chapters will remain pending reader publication.', flush=True)
        return True
    print('Shared Open Reader synchronization enabled.', flush=True)
    return False


def _reader_workflow_choices(argv, *, interactive=None, prompt=None):
    """Focused by default after initial library setup; full audit is opt-in."""
    argv=list(argv)
    options={'--status','--archive-needed','--inspect','--audit-resources',
             '--github-login','--github-logout','--github-account',
             '--github-switch-account','--default-source-url',
             '--refresh-extension','--self-test-only','--library-audit'}
    if options.intersection(argv):
        return 'full', False, '--self-test-only' in argv
    # A brand-new installation still needs the initial full registry setup.
    scope='comic' if (ROOT/'.archiver_state/open_reader_registry.json').is_file() else 'full'
    explicit='--open-reader-update-scope' in argv
    if explicit:
        ix=argv.index('--open-reader-update-scope')
        if ix+1>=len(argv) or argv[ix+1] not in ('full','comic','site'):
            raise SystemExit('--open-reader-update-scope requires full, comic, or site')
        scope=argv[ix+1]
    interactive=sys.stdin.isatty() if interactive is None else interactive
    if interactive and not explicit and '--skip-open-reader-sync' not in argv:
        prompt=input if prompt is None else prompt
        print('What changed in Open Reader?\n'
              '  1) Current comic only\n'
              '  2) Homepage, Your Journey, Add Comic or other shared routes only\n'
              '  3) Full library synchronization / audit',flush=True)
        answer=prompt('Choose publication workflow [default '+('1' if scope=='comic' else '3')+']: ').strip().lower()
        choices={'1':'comic','comic':'comic','2':'site','site':'site','3':'full','full':'full','':scope}
        if answer not in choices: raise SystemExit('Invalid publication choice; nothing changed.')
        scope=choices[answer]
    # Explicit focused commands never ask questions that turn them into a
    # full-library audit. Full sync remains available as a deliberate choice.
    return scope, scope != 'full' or '--skip-initial-github-check' in argv, scope=='full'


def _initial_github_check_choice(args, *, interactive=None, prompt=None):
    """Ask once about optional *full* startup checks for this interactive run.

    A no skips slow test suites and historical GitHub reconciliation, but the
    release/manifest compatibility contract is ALWAYS verified. New uploads
    retain their mandatory remote verification and safe local cleanup gates.
    """
    args = list(args)
    if '--skip-initial-github-check' in args:
        # Explicit flag only skips remote reconciliation, not local tests.
        print('Initial full GitHub archive check skipped (explicit command-line choice).', flush=True)
        return args, True
    # The normal no-arg invocation is effectively --resume.
    if not args:
        args = ['--resume']
    if not ({'--archive', '--resume'} & set(args)):
        return args, True
    interactive = sys.stdin.isatty() if interactive is None else interactive
    if not interactive:
        return args, True  # Unattended mode retains all checks.
    prompt = input if prompt is None else prompt
    try:
        answer = prompt('Run full startup checks (regression tests + GitHub history audit)? [Y/n]: ').strip().lower()
    except EOFError:
        answer = ''
    if answer in ('n', 'no'):
        args.append('--skip-initial-github-check')
        print('Skipping optional regression suites and old GitHub manifest scan for THIS run. '
              'Required compatibility checks and new-upload verification remain enforced.', flush=True)
        return args, False
    print('Full startup checks enabled.', flush=True)
    return args, True


# Fail-closed, always-on safety gate for automatic Comic Bridge runs.
# Keep this in run.py: a partial ZIP must not silently skip regression tests.
# Tests are local and simulated; they never download, publish, or shut down Windows.
_PREFLIGHT_RELEASE = '1.5.17'
_PREFLIGHT_PYTHON = (
    ('test_browser_autobootstrap.py', 2),
    ('test_regression_release_v154.py', 3),
    ('test_streaming_order.py', 7),
    ('test_optimized_bridge.py', 4),
    ('test_native_dialog_recovery.py', 3),
    ('test_image_checkpoint_resume.py', 8),
    ('test_native_chapter_download.py', 3),
    ('test_site_separation.py', 3),
    ('test_github_fast_verification.py', 5),
    ('test_challenge_passive_resume.py', 6),
    ('test_startup_compatibility_and_check_choice.py', 5),
    ('test_normal_chrome_autolaunch.py', 8),
    ('test_browser_release_dependency_contract.py', 3),
    ('test_scroll_stability.py', 2),
    ('test_strict_completion_barrier.py', 7),
    ('test_historical_lazy_loading_baseline.py', 4),
    ('test_source_server_fault_policy.py', 6),
    ('test_reader_issue_feed.py', 4),
    ('test_confirmed_source_placeholders.py', 3),
    ('test_managed_tab_recycle_resume.py', 2),
    ('test_bridge_resume_target_and_reconnect.py', 14),
    ('test_resume_deferred_and_reader_host.py', 8),
    ('test_open_reader_bell_integration.py', 4),
    ('test_partial_chapter_streaming.py', 4),
    ('test_open_reader_journey.py', 3),
    ('test_open_reader_site_auth.py', 3),
    ('test_skip_open_reader_sync.py', 7),
    ('test_open_reader_scoped_updates.py', 8),
)
_PREFLIGHT_JAVASCRIPT = (
    'extension_persistent_autoconnect.js',
    'extension_native_chapter_download.js',
    'extension_screenshot_permission_fallback.js',
    'extension_fast_path_and_watchdog.js',
    'extension_tile_stall_recovery.js',
    'extension_next_chapter_recovery.js',
    'extension_passive_recaptcha.js',
    'extension_auto_tab_launch.js',
    'extension_resume_commit_race.js',
    'extension_managed_tab_isolation.js',
    'extension_recovery_transport_fallback.js',
    'extension_scroll_stability.js',
    'extension_exact_image_recovery.js',
    'extension_probe_additive_compat.js',
    'extension_blob_reader.js',
    'extension_loaded_blob_exact.js',
    'reader_final_chapter_overview.js',
    'extension_fetch_exception_screenshot_fallback.js',
    'extension_same_url_reload.js',
    'extension_managed_tab_recycle.js',
    'open_reader_worker.test.mjs',
    'open_reader_journey.test.mjs',
    'open_reader_site_auth.test.mjs',
)


def _run_preflight(*, run_tests=True) -> None:
    """Check release compatibility and run every required regression before work."""
    def fail(problem: str) -> None:
        print('\nPREFLIGHT FAILED: ' + problem, file=sys.stderr, flush=True)
        print('Archiving, GitHub publishing, Cloudflare deployment, and shutdown '
              'have NOT started.', file=sys.stderr, flush=True)
        raise SystemExit(3)

    print('\nComic Archiver: verifying installed release and running startup tests...', flush=True)
    # Installed manifests are generated from the current adapter, never copied
    # from another provider's extension ZIP. Re-run on every launch so provider
    # switches cannot retain stale permissions or chapter URL patterns.
    try:
        from site_specific import site_adapter
        from reusable.bridge_manifest import generate_installed_manifests
        # Use the same port-bearing API that source_extension_context() uses;
        # a portless preflight previously missed incompatible installed files.
        from reusable.browser_bridge import BRIDGE_PORT
        port = int(os.environ.get('COMIC_ARCHIVER_BRIDGE_PORT') or BRIDGE_PORT)
        generated = generate_installed_manifests(ROOT, site_adapter, port=port)
        if generated:
            print('  Regenerated site-specific manifests: ' + ', '.join(generated) +
                  ' (reload this unpacked extension in Chrome/Firefox)', flush=True)
    except Exception as exc:
        fail('site adapter / extension manifest generation failed: '+str(exc))
    try:
        bridge = (ROOT / 'reusable' / 'browser_bridge.py').read_text(encoding='utf-8')
        engine = (ROOT / 'reusable' / 'engine.py').read_text(encoding='utf-8')
        session = (ROOT / 'reusable' / 'source_session.py').read_text(encoding='utf-8')
        launcher = (ROOT / 'reusable' / 'normal_browser_launch.py').read_text(encoding='utf-8')
        background = (ROOT / 'reusable' / 'browser_bridge_extension' / 'background.js').read_bytes()
        content = (ROOT / 'reusable' / 'browser_bridge_extension' / 'content.js').read_bytes()
        for rel in ('reusable/browser_bridge.py', 'reusable/engine.py',
                    'reusable/source_session.py', 'site_specific/site_adapter.py'):
            ast.parse((ROOT / rel).read_text(encoding='utf-8'), filename=rel)
        # Detect missing/corrupt prerequisite files, and accidental old-protocol
        # overlays before they can start a 96-chapter run or touch remote archives.
        required_bridge = ('X-Comic-Bridge-Bootstrap', 'X-Comic-Bridge-Client',
                           'extension_client', 'def recover_unloaded_image',
                           "'startup_url': bridge.initial_chapter_url")
        required_engine = ('ChapterImageCheckpoint(', 'checkpoint=checkpoint',
                           'IMAGE_REUSED_FROM_CHECKPOINT',
                           'on_progress=save_as_scroll_reveals',
                           'def scan_browser_images(', 'on_progress=None')
        required_background = (b'bridgeContentProtocol===6', b'RECOVER_IMAGE',
                               b"'X-Comic-Bridge-Bootstrap':'1'",
                               b"'X-Comic-Bridge-Client':chrome.runtime.id",
                               b"screenshotBackend !== 'debugger'",
                           b"pickComicTab(config.site,config.startup_url,config.startup_nonce||'')",
                           b"chrome.tabs.onCreated?.addListener(()=>autoConnect())")
        for marker in required_bridge:
            if marker not in bridge:
                fail('Python bridge missing compatibility feature: ' + marker)
        # A partial update can contain a new run.py/background.js yet an old
        # Python bridge or session module. All three hands-free components must
        # be installed together before entering any archiving workflow.
        if 'initial_chapter_url=initial_chapter_url' not in session:
            fail('Python source session does not forward the startup chapter')
        if 'def launch_normal_chrome(' not in launcher or '--new-tab' not in launcher:
            fail('normal Chrome launcher missing or incompatible')
        if not any(marker in launcher for marker in ("command.append('about:blank')", "command.append('about:blank#comicarchiver-'")):
            fail('normal Chrome launcher must not create a second matching chapter tab')
        if 'require_managed_tab=True' not in bridge or 'tab_ownership' not in bridge:
            fail('Python must reject old extension workers that reuse manual tabs')
        if 'comicBridgeManagedTabId' not in background.decode('utf-8'):
            fail('auto startup can select an old manually opened matching tab')
        if 'launch_normal_chrome(bridge.initial_chapter_url, startup_nonce=bridge.startup_nonce)' not in bridge:
            fail('Python bridge does not launch the selected chapter in normal Chrome')
        if 'Bootstrap requires a browser extension Origin' in bridge:
            fail('old Python bootstrap handler reintroduced; 403 regression detected')
        for marker in required_engine:
            if marker not in engine:
                fail('one-pass downloader missing: ' + marker)
        for marker in required_background:
            if marker not in background:
                fail('extension missing compatibility feature: ' + marker.decode('utf-8'))
        if b'async function recycleManagedChapterTab()' not in background or b'transport_reset:true' not in background:
            fail('extension lacks managed tab recycling on stalled scroll')
        if 'BrowserManagedTabRecycled' not in bridge or 'except BrowserManagedTabRecycled:' not in engine:
            fail('Python lacks checkpoint-safe restart after tab recycling')
        if b'recover_image existing-listener fallback' not in background:
            fail('extension lacks fallback when Chrome recovery injection stalls')
        if 'SOURCE_IMAGE_RECOVERY_DEFERRED' not in engine:
            fail('scanner would abort on a transient single-image recovery error')
        if b'RECOVER_IMAGE' not in content:
            fail('extension missing targeted per-image recovery')
        if b'function waitForPaintOrTimer(' not in content or b'paintReady=await waitForPaintOrTimer()' not in content:
            fail('extension lacks the required nonblocking image-tile paint recovery')
        if b"const tile=payload?.type==='CAPTURE_IMAGE_TILE'" not in background:
            fail('extension lacks selected-tab tile message rescue')
        if b"if(payload?.type==='RECOVER_IMAGE' && chrome.scripting?.executeScript)" not in background:
            fail('extension lacks next-chapter one-shot targeted recovery')
        if b'const paintReady=await waitForPaintOrTimer();' not in content or b'await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))' in content:
            fail('targeted image recovery can hang forever waiting for animation frames')
        if b"type:'RESTORE_SCROLL'" in background or b'oldY,behavior' in content:
            fail('browser contains per-image scroll restoration; repeated bottom/page teleports')
        if b'Math.floor(innerHeight*.85)' not in content:
            fail('normal scroll has reverted to oversized viewport jumps')
        if 'pending_key = next((key for key in slot_order if key not in saved_keys), None)' not in engine:
            fail('resume lacks forward-only ordered recovery')
        if b'__comicBridgeContentLoadedVersion === 10' not in content:
            fail('old content-script version guard would preserve a stale page handler')

        # One editable provider adapter; generated binaries must come from the
        # reusable extension source, not a stale/replaced generated copy.
        src = ROOT / 'reusable' / 'browser_bridge_extension'
        version = json.loads((src / 'manifest.chrome.json').read_text(encoding='utf-8'))['version']
        if version != _PREFLIGHT_RELEASE:
            fail(f'expected bridge release {_PREFLIGHT_RELEASE}, found {version}')
        for browser in ('chrome', 'firefox'):
            manifest_source = json.loads((src / f'manifest.{browser}.json').read_text(encoding='utf-8'))
            installed = ROOT / 'browser_bridge' / browser
            manifest_installed = json.loads((installed / 'manifest.json').read_text(encoding='utf-8'))
            if manifest_source['version'] != version or manifest_installed['version'] != version:
                fail(f'{browser} extension manifest/version mismatch')
            if f'http://127.0.0.1:{port}/*' not in (manifest_installed.get('host_permissions', [])
                                                    + manifest_installed.get('permissions', [])):
                fail(f'{browser} extension missing loopback host permission')
            if browser == 'chrome' and 'debugger' not in manifest_installed.get('permissions', []):
                fail('Chrome debugger screenshot fallback permission missing')
            if manifest_installed['content_scripts'][0]['matches'] != list(site_adapter.EXTENSION_MATCHES):
                fail(f'{browser} extension site patterns differ from site_specific/site_adapter.py')
            for asset in ('background.js', 'content.js', 'popup.html', 'popup.js'):
                if (src / asset).read_bytes() != (installed / asset).read_bytes():
                    fail(f'{browser}/{asset} is stale or out of sync with reusable source')
        print('  PASS release contracts and generated extension parity', flush=True)
    except (OSError, ValueError, KeyError, SyntaxError) as exc:
        fail('missing, broken, or incompatible source file: ' + str(exc))

    if not run_tests:
        print('PREFLIGHT COMPATIBILITY PASSED: regression suites skipped for focused work.\n', flush=True)
        return

    # Always run the short, provider-neutral regression for the live blob
    # handler revision and exact-image fail-closed behavior. Skipping the long
    # historical suites must not disable this required release contract.
    required = 'test_blob_transfer_runtime_gate.py'
    if not (ROOT / 'tests' / required).is_file():
        fail('mandatory live-blob runtime regression missing: tests/' + required)
    # Missing Pillow is handled by the project's existing first-run dependency
    # bootstrap. Never block that bootstrap solely because this test needs PIL.
    try:
        import PIL  # noqa: F401
    except ImportError:
        print('  NOTE: mandatory blob test deferred until Python dependencies are installed', flush=True)
    else:
        try:
            result = subprocess.run([sys.executable, '-m', 'unittest', 'discover',
                                     '-s', 'tests', '-p', required, '-v'],
                                    cwd=ROOT, capture_output=True, text=True,
                                    timeout=45, encoding='utf-8', errors='replace')
        except (OSError, subprocess.TimeoutExpired) as exc:
            fail('mandatory live-blob regression did not run: ' + str(exc))
        count = re.search(r'Ran (\d+) tests?', result.stdout + result.stderr)
        if result.returncode != 0 or not count or int(count.group(1)) < 6:
            print((result.stdout + result.stderr)[-9000:], file=sys.stderr, flush=True)
            fail('mandatory live-blob runtime regression failed')
        print('  PASS mandatory live-blob runtime regression (' + count.group(1) + ' tests)', flush=True)

    # Always verify the resume target and bounded reconnect policy, even when
    # the optional historical suites were skipped for an archive-only run.
    resume_test = 'test_bridge_resume_target_and_reconnect.py'
    if not (ROOT / 'tests' / resume_test).is_file():
        fail('mandatory resume/reconnect regression missing: tests/' + resume_test)
    try:
        resume_result = subprocess.run(
            [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests',
             '-p', resume_test, '-v'], cwd=ROOT, capture_output=True, text=True,
            timeout=45, encoding='utf-8', errors='replace')
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail('mandatory resume/reconnect tests did not complete: ' + str(exc))
    resume_count = re.search(r'Ran (\d+) tests?',resume_result.stdout+resume_result.stderr)
    if resume_result.returncode != 0 or not resume_count or int(resume_count.group(1)) < 14:
        print((resume_result.stdout+resume_result.stderr)[-9000:],file=sys.stderr,flush=True)
        fail('mandatory resume/reconnect regression failed')
    print('  PASS mandatory resume/reconnect regressions (' + resume_count.group(1) + ' tests)',flush=True)

    # The complete authenticated publication path is mandatory, even when
    # optional tests are skipped. Replaces the duplicate live-blob test run.
    completion_test = 'test_publication_completion.py'
    if not (ROOT / 'tests' / completion_test).is_file():
        fail('mandatory publication completion test missing: tests/' + completion_test)
    try:
        completion_result = subprocess.run(
            [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests',
             '-p', completion_test, '-v'], cwd=ROOT, capture_output=True,
            text=True, timeout=45, encoding='utf-8', errors='replace')
    except (OSError, subprocess.TimeoutExpired) as exc:
        fail('mandatory publication completion tests did not complete: ' + str(exc))
    completion_count = re.search(r'Ran (\d+) tests?', completion_result.stdout + completion_result.stderr)
    if completion_result.returncode != 0 or not completion_count or int(completion_count.group(1)) < 18:
        print((completion_result.stdout + completion_result.stderr)[-9000:], file=sys.stderr, flush=True)
        fail('mandatory publication completion regression failed')
    print('  PASS mandatory publication completion regressions (' + completion_count.group(1) + ' tests)', flush=True)

    if not run_tests:
        print('PREFLIGHT COMPATIBILITY PASSED: optional regression suites skipped by user.\n', flush=True)
        return

    node = shutil.which('node')
    if node is None:
        fail('Node.js is required for extension regression tests (node not on PATH)')

    # subprocess (not in-process unittest) prevents test mocks and monkeypatches
    # from leaking into the real downloader; nonzero status is always fatal.
    for filename, minimum in _PREFLIGHT_PYTHON:
        if not (ROOT / 'tests' / filename).is_file():
            fail('required Python test is missing: tests/' + filename)
        print('  TEST ' + filename, flush=True)
        try:
            result = subprocess.run(
                [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests',
                 '-p', filename, '-v'], cwd=ROOT, capture_output=True,
                text=True, timeout=90, encoding='utf-8', errors='replace')
        except (OSError, subprocess.TimeoutExpired) as exc:
            fail(f'test could not complete: {filename}: {exc}')
        count = re.search(r'Ran (\d+) tests?', result.stdout + result.stderr)
        if result.returncode != 0 or not count or int(count.group(1)) < minimum:
            print((result.stdout + result.stderr)[-9000:], file=sys.stderr, flush=True)
            fail(f'Python regression tests failed or did not run: {filename}')
        print(f'    PASS ({count.group(1)} tests)', flush=True)

    for filename in _PREFLIGHT_JAVASCRIPT:
        if not (ROOT / 'tests' / filename).is_file():
            fail('required extension test is missing: tests/' + filename)
        print('  TEST ' + filename, flush=True)
        try:
            result = subprocess.run(
                [node, str(ROOT / 'tests' / filename)], cwd=ROOT,
                capture_output=True, text=True, timeout=60,
                encoding='utf-8', errors='replace')
        except (OSError, subprocess.TimeoutExpired) as exc:
            fail(f'test could not complete: {filename}: {exc}')
        if result.returncode != 0 or 'PASS' not in result.stdout:
            print((result.stdout + result.stderr)[-9000:], file=sys.stderr, flush=True)
            fail(f'extension regression test failed: {filename}')
        print('    PASS', flush=True)

    print('PREFLIGHT PASSED: safe to enter normal archiver startup.\n', flush=True)



# Process-level recovery is deliberately separate from the engine's existing
# per-chapter reconnect budget. Each attempt starts with fresh Python objects,
# while the engine's durable SQLite/image checkpoints remain authoritative.
_RETRY_CHILD_FLAG = '--_archive-retry-child'
_RETRY_CHILD_CODE = 75
# Preserve a longer delay when a child explicitly returns the historical
# source-pause code. No exception-class dependency is required.
_RETRY_MANUAL_STOP_CODE = 76
# Windows console interruption may be reported as signed or unsigned NTSTATUS.
_RETRY_INTERRUPT_CODES = {130, -2, -1073741510, 3221225786}


def _archive_retry_child(args):
    # Permanent supervisor contract: never import optional acquisition-specific
    # exception classes or classify failures here. Any uncaught exception exits
    # nonzero and the parent restarts it, regardless of installed adapter mode
    # or reusable module revision. The engine retains its own safety checks.
    sys.argv = ['comic_archiver.py', *args]
    try:
        import reusable.engine as engine
        engine.main()
    except KeyboardInterrupt:
        raise SystemExit(130) from None


def _archive_retry_enabled(args, scope):
    # Never turn inspection, account maintenance or bounded test runs into jobs.
    maintenance = {'--status', '--archive-needed', '--inspect', '--audit-resources',
                   '--github-login', '--github-logout', '--github-account',
                   '--github-switch-account', '--default-source-url',
                   '--refresh-extension', '--self-test-only', '--library-audit',
                   '--source-login', '--repair-reader-readmes', '--help', '-h'}
    flags = {arg.split('=', 1)[0] for arg in args}
    return (scope != 'site' and bool(flags & {'--archive', '--resume'})
            and not flags.intersection(maintenance | {'--max-chapters', '--open-reader-url'}))


def _run_archive_retry_loop(args, *, call=None, sleep=None):
    call = subprocess.call if call is None else call
    sleep = time.sleep if sleep is None else sleep
    current = list(args)
    attempt = 0
    print('ARCHIVE_AUTO_RETRY_ENABLED: every failed archive child restarts automatically; '
          'only success or Ctrl+C stops the supervisor.', flush=True)
    while True:
        try:
            code = call([sys.executable, '-u', str(ROOT / 'run.py'),
                         _RETRY_CHILD_FLAG, *current], cwd=ROOT)
        except OSError as exc:
            print(f'ARCHIVE_CHILD_LAUNCH_FAILED: {exc}', file=sys.stderr, flush=True)
            code = _RETRY_CHILD_CODE
        except KeyboardInterrupt:
            print('ARCHIVE_RETRY_STOPPED: Ctrl+C; saved checkpoints retained.', flush=True)
            raise SystemExit(130) from None
        if code == 0:
            # The engine alone decides whether publication is verified and
            # whether an explicitly authorized shutdown may be scheduled.
            return
        if code in _RETRY_INTERRUPT_CODES:
            print('ARCHIVE_RETRY_STOPPED: child interrupted; saved checkpoints retained.', flush=True)
            raise SystemExit(130)
        # Do NOT allowlist exception messages or error codes. An ordinary
        # traceback (exit 1), an unknown browser error or a child crash must
        # restart just like a known recoverable transport error (exit 75).
        # Every child still enforces all existing verification and access gates.
        attempt += 1
        delay = min(60, 5 * 2 ** min(attempt - 1, 4))
        # An access pause still retries indefinitely, but give the operator and
        # source a longer interval; never bypass the engine's access checks.
        if code == _RETRY_MANUAL_STOP_CODE:
            delay = max(delay, 300)
        print(f'ARCHIVE_AUTO_RESTART attempt={attempt} exit_code={code} wait_seconds={delay} '
              'checkpoint_retained=True historical_github_check=False; '
              'Ctrl+C stops the retry loop.', flush=True)
        if '--skip-initial-github-check' not in current:
            current.append('--skip-initial-github-check')
        # Preserve explicit refresh requests; ordinary resume already uses the
        # cached catalog. Do not implicitly authorize any additional work.
        try:
            sleep(delay)
        except KeyboardInterrupt:
            print('ARCHIVE_RETRY_STOPPED: Ctrl+C; saved checkpoints retained.', flush=True)
            raise SystemExit(130) from None


def main() -> None:
    os.chdir(ROOT)
    _relaunch_project_venv()
    if sys.argv[1:2] == [_RETRY_CHILD_FLAG]:
        _archive_retry_child(sys.argv[2:])
        return
    no_auto_retry = '--no-auto-retry' in sys.argv[1:]
    if no_auto_retry:
        sys.argv.remove('--no-auto-retry')
    if '--repair-reader-readmes' in sys.argv[1:]:
        if sys.argv[1:] != ['--repair-reader-readmes']:
            raise SystemExit('--repair-reader-readmes must be used alone')
        # This is a post-publication recovery operation: no Wrangler, archive,
        # workflow prompts, bootstrap, deployment, or shutdown.
        import reusable.engine as engine
        engine.main()
        return
    # Always run quick, fail-closed release/manifest contract checks. The
    # expensive local suites and old GitHub audit may be explicitly skipped
    # for this interactive run; --self-test-only ALWAYS runs all tests.
    self_test_only = '--self-test-only' in sys.argv[1:]
    scope, skip_old, run_full_tests = (('full', False, True) if self_test_only else
                                        _reader_workflow_choices(sys.argv[1:]))
    chosen = list(sys.argv[1:])
    _run_preflight(run_tests=run_full_tests)
    if '--self-test-only' in sys.argv[1:]:
        if len(sys.argv) != 2:
            raise SystemExit('--self-test-only cannot be combined with other arguments')
        return
    # The bootstrap must also provision the deployment CLI and Git, not just
    # Python imports. Otherwise a brand-new ZIP could fail midway through the
    # first Cloudflare run despite requests/playwright already being installed.
    wrangler = ROOT / 'node_modules' / '.bin' / ('wrangler.cmd' if os.name == 'nt' else 'wrangler')
    if not _check_dependencies() or not wrangler.exists() or shutil.which('git') is None:
        _bootstrap()
    import reusable.engine as engine
    args = sys.argv[1:]
    if not args:
        _preferences()
        args = ['--resume', '--authorized']
    if '--open-reader-update-scope' not in args and '--skip-open-reader-sync' not in args:
        args.extend(['--open-reader-update-scope', scope])
    if (skip_old or '--skip-initial-github-check' in chosen) and '--skip-initial-github-check' not in args:
        args.append('--skip-initial-github-check')
    # Also cover explicit `python run.py --deploy --authorized`: the old code
    # silently skipped the shutdown question whenever command-line args existed.
    # Archiving-only runs cannot satisfy the publish-and-verify shutdown gate.
    if '--skip-open-reader-sync' not in args and scope != 'site':
        args = _shutdown_choice(args)
    elif '--shutdown-on-complete' in args:
        print('Automatic shutdown suppressed: shared-reader publication was skipped.', flush=True)
        args = [value for value in args if value != '--shutdown-on-complete']
    if not no_auto_retry and _archive_retry_enabled(args, scope):
        _run_archive_retry_loop(args)
        return
    sys.argv = ['comic_archiver.py', *args]
    engine.main()


if __name__ == '__main__':
    main()
