import unittest
from reusable.github_cooldown import git_size_rejected, cloudflare_retry_delay
class Limits(unittest.TestCase):
 def test_explicit_size_only(self):
  self.assertTrue(git_size_rejected('remote: fatal: pack exceeds maximum allowed size (2.00 GiB)'))
  self.assertTrue(git_size_rejected('HTTP 413'))
  self.assertFalse(git_size_rejected('file exceeds maximum file size'))
  self.assertFalse(git_size_rejected('403 permission denied'))
 def test_daily_and_rate_wait(self):
  self.assertEqual(cloudflare_retry_delay('HTTP 429 Retry-After: 120',0,86390),120)
  self.assertEqual(cloudflare_retry_delay('daily row write limit',0,86390),60)
  self.assertEqual(cloudflare_retry_delay('daily request limit',0,43200),43205)
  self.assertIsNone(cloudflare_retry_delay('maximum storage capacity exceeded'))
  self.assertIsNone(cloudflare_retry_delay('403 Forbidden'))
