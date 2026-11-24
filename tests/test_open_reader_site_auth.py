"""Authoritative regression for authenticated site routing, read-only timeline grouped by contiguous IP runs."""
import json,sqlite3,tempfile,unittest
from pathlib import Path
from reusable import open_reader,open_reader_journey
from reusable.open_reader_journey_ui import JOURNEY_HTML

class AuthTimelineTests(unittest.TestCase):
    def test_worker_first_no_static_bypass(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);stage=root/'stage';stage.mkdir()
            worker=root/'reusable/worker_addon/panel_replacement_worker.mjs';worker.parent.mkdir(parents=True)
            worker.write_text('secure worker')
            cfg=json.loads(open_reader._worker_config(stage,root,root).read_text())
            self.assertIs(cfg['assets']['run_worker_first'],True)
    def test_dynamic_grouping_ip_a_b_a_not_collapsed(self):
        conn=sqlite3.connect(':memory:');conn.row_factory=sqlite3.Row
        conn.execute('CREATE TABLE journey_events(event_id TEXT PRIMARY KEY, created_at TEXT, ip TEXT)')
        address=['203.0.113.1']*300+['198.51.100.4']*10+['203.0.113.1']*200
        for ix,ip in enumerate(address):
            # Tie on timestamp deliberately exercises rowid chronology.
            conn.execute('INSERT INTO journey_events VALUES (?,?,?)',(str(ix),f'2026-11-24T{ix//60:02d}:{ix%60:02d}:00Z',ip))
        rows=conn.execute('''WITH ordered AS (SELECT e.rowid AS n, e.ip, LAG(ip) OVER(ORDER BY created_at,rowid) AS prev FROM journey_events e),
            groups AS (SELECT *,SUM(CASE WHEN prev IS NULL OR prev<>ip THEN 1 ELSE 0 END) OVER(ORDER BY n ROWS UNBOUNDED PRECEDING) g FROM ordered)
            SELECT g,MIN(ip) ip,COUNT(*) count FROM groups GROUP BY g ORDER BY g''').fetchall()
        self.assertEqual([r['count'] for r in rows],[300,10,200]);self.assertEqual(rows[0]['ip'],rows[2]['ip'])
    def test_private_timeline_geometry_and_map(self):
        self.assertIn('id="timeline-svg"',JOURNEY_HTML)
        self.assertIn('height:clamp(',JOURNEY_HTML)
        self.assertIn('overflow:auto',JOURNEY_HTML)
        self.assertIn('fullscreen',JOURNEY_HTML)
        self.assertIn('leaflet@1.9.4',JOURNEY_HTML)
        self.assertIn('/api/journey/period-events',JOURNEY_HTML)
        self.assertIn('createElement',JOURNEY_HTML)
        self.assertIn('© OpenStreetMap contributors',JOURNEY_HTML)
        for token in ('--or-header:#131921','--or-accent:#ff9900','--or-canvas:#eaeded','--or-border:#d5d9d9'):
            self.assertIn(token,JOURNEY_HTML)
        self.assertIn('background:var(--or-navigation)',JOURNEY_HTML)
        self.assertIn('font-family:Arial,Helvetica,system-ui,sans-serif',JOURNEY_HTML)
if __name__=='__main__':unittest.main()
