from pathlib import Path
import unittest
S = (Path(__file__).resolve().parents[1] / 'setup_and_publish.ps1').read_text(encoding='utf-8')
class BootstrapTests(unittest.TestCase):
    def test_installs_all_missing_prerequisites(self):
        for text in ('Python.Python.3.13','OpenJS.NodeJS.LTS','PortableGit','git-credential-manager.exe','pip install -r requirements.txt','playwright install firefox','npm.cmd install'):
            self.assertIn(text,S)
    def test_does_not_modify_git_config(self):
        for bad in ('git config --global','git config --system','git-credential-manager configure','git-credential-manager unconfigure'):
            self.assertNotIn(bad,S)
    def test_browser_login_after_prerequisites(self):
        self.assertLess(S.index('Get-CompatibleGit'),S.index('STEP 1/3: GITHUB WEBSITE SIGN-IN'))
    def test_portable_git_fallback(self):
        self.assertIn('git-for-windows/git/releases/latest',S)
        self.assertIn('Get-CompatibleGit',S)
if __name__ == '__main__': unittest.main()
