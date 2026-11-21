"""Console progress reporting with honest determinate/indeterminate states.

Only label a job with a percentage when the denominator is measured.  While
waiting on Wrangler/Git, use elapsed time and a live heartbeat instead of
inventing a completion percentage.  No terminal-specific dependencies.
"""
from __future__ import annotations

import sys
import time


def duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, remaining = divmod(seconds, 3600)
    minutes, seconds = divmod(remaining, 60)
    return f"{hours:d}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes:02d}:{seconds:02d}"


class Progress:
    def __init__(self, label: str, total: int | None = None, unit: str = "files",
                 *, clock=None, output=None, interval: float = 5.0):
        self.label = label
        self.total = total if total and total > 0 else None
        self.unit = unit
        self.clock = clock or time.monotonic
        self.output = output or sys.stdout
        self.interval = interval
        self.start = self.clock()
        self.last_render = -float('inf')
        self.last_percent = -1
        self.current = 0
        self.last_detail = ''
        self.finished = False
        self.tty = bool(getattr(self.output, 'isatty', lambda: False)())
        self._line_len = 0
        self.heartbeat(force=True)

    def _render(self, *, final=False, detail=''):
        now = self.clock()
        done = self.current
        if self.total is not None:
            fraction = min(1., max(0., done / self.total))
            filled = int(fraction * 22)
            bar = '[' + '#' * filled + '-' * (22 - filled) + ']'
            msg = f'{self.label} {bar} {fraction:5.1%} ({done:,}/{self.total:,} {self.unit})'
            current_percent = int(fraction * 100)
        else:
            spinner = '|/-\\'[int((now-self.start)*2) % 4]
            msg = f'{self.label} [{spinner} working; completion % unavailable]'
            current_percent = None
        msg += f'  elapsed {duration(now - self.start)}'
        if detail:
            msg += f'  {detail[:90]}'
        if final:
            msg += '  DONE'
        if self.tty:
            padded = msg.ljust(self._line_len)
            self.output.write('\r' + padded + ('\n' if final else ''))
            self._line_len = len(msg)
        elif final or now-self.last_render >= self.interval or (
                current_percent is not None and current_percent != self.last_percent and
                (current_percent // 10 > self.last_percent // 10)):
            self.output.write(msg + '\n')
        else:
            return
        self.output.flush()
        self.last_render = now
        if current_percent is not None:
            self.last_percent = current_percent

    def update(self, done: int, detail: str = ''):
        self.current = max(0, int(done))
        self.last_detail = detail
        self._render(detail=detail)

    def heartbeat(self, *, force=False, detail: str = ''):
        if force or self.clock() - self.last_render >= self.interval:
            self._render(detail=detail or self.last_detail)

    def complete(self, detail: str = ''):
        if not self.finished:
            if self.total is not None:
                self.current = self.total
            self._render(final=True, detail=detail)
            self.finished = True


def stop_progress(progress: Progress, outcome: str = 'STOPPED'):
    """End a progress indicator without pretending it reached its target."""
    if not progress.finished:
        progress._render(final=True, detail=outcome)
        progress.finished = True
