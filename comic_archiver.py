#!/usr/bin/env python3
"""Stable CLI and backward-compatible import: the implementation lives in reusable/.

To support a different comic website, edit ONLY site_specific/site_adapter.py.
"""
import sys
from reusable import engine as _engine
sys.modules[__name__] = _engine
if __name__ == "__main__":
    _engine.main()
