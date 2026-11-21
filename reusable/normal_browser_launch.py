"""Launch a normal user-profile Chrome browser (never WebDriver/CDP automation).

Only the installed Comic Bridge extension receives bridge commands. This
module does not inspect or modify browser profiles, cookies, or credentials.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit


def _chromium_candidates():
    override = os.environ.get('COMIC_ARCHIVER_CHROME_EXE', '').strip().strip('"')
    if override:
        yield override
        return
    if os.name == 'nt':
        try:
            import winreg
            for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                for key_name in (r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
                                 r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe'):
                    try:
                        with winreg.OpenKey(hive, key_name) as key:
                            exe, _ = winreg.QueryValueEx(key, '')
                            if exe: yield exe
                    except OSError:
                        pass
        except ImportError:
            pass
        for base in (os.environ.get('LOCALAPPDATA'), os.environ.get('PROGRAMFILES'),
                     os.environ.get('PROGRAMFILES(X86)')):
            if base:
                yield str(Path(base) / 'Google' / 'Chrome' / 'Application' / 'chrome.exe')
                yield str(Path(base) / 'Microsoft' / 'Edge' / 'Application' / 'msedge.exe')
    elif sys.platform == 'darwin':
        yield '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        yield '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    else:
        for name in ('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'):
            yield name


def find_normal_chrome():
    for candidate in _chromium_candidates():
        path = Path(candidate)
        if path.is_file():
            return str(path)
        found = shutil.which(candidate)
        if found:
            return found
    return None


def launch_normal_chrome(chapter_url: str, *, executable=None, popen=subprocess.Popen):
    """Wake the user's normal Chrome; extension creates/owns the chapter tab.

    Do not open chapter_url here: if an older tab has the identical chapter URL,
    the extension could race and select the wrong tab. The installed extension
    creates its own tab from the validated /bootstrap startup_url instead.
    No WebDriver/remote-debugging/automation profile is used.
    """
    parsed = urlsplit(chapter_url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('Normal-browser launch requires a valid HTTPS chapter URL')
    executable = executable or find_normal_chrome()
    if not executable:
        raise RuntimeError('Cannot find Chrome or Edge. Install it, or set COMIC_ARCHIVER_CHROME_EXE '
                           'to the browser executable containing the enabled Comic Bridge extension.')
    command = [str(executable), '--new-tab']
    profile = os.environ.get('COMIC_ARCHIVER_CHROME_PROFILE_DIRECTORY', '').strip()
    if profile:
        if not re.fullmatch(r'(?:Default|Profile [1-9][0-9]*)', profile):
            raise ValueError('COMIC_ARCHIVER_CHROME_PROFILE_DIRECTORY must be Default or Profile N')
        command.append('--profile-directory=' + profile)
    # The URL is carried separately in the authenticated extension bootstrap.
    # Only wake the normal profile here; never create a second matching chapter tab.
    command.append('about:blank')
    options = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL,
               'stderr': subprocess.DEVNULL}
    if os.name == 'nt':
        options['creationflags'] = getattr(subprocess, 'DETACHED_PROCESS', 0) | getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)
    popen(command, **options)
    return command
