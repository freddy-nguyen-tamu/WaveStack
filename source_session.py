"""Backward-compatible import; implementation lives in reusable/source_session.py."""
import sys
from reusable import source_session as _session
sys.modules[__name__] = _session
