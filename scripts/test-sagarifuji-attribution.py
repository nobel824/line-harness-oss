import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "sagarifuji_attribution", Path(__file__).with_name("sagarifuji-attribution.py")
)
attribution = importlib.util.module_from_spec(spec)
spec.loader.exec_module(attribution)


class AttributionTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript("""
            CREATE TABLE line_accounts (id TEXT, channel_id TEXT);
            INSERT INTO line_accounts VALUES ('saga', '2011217182'), ('other', 'other');
            CREATE TABLE friends (id TEXT, line_account_id TEXT, ref_code TEXT);
            CREATE TABLE ref_tracking (friend_id TEXT, ref_code TEXT, created_at TEXT);
            CREATE TABLE meet_consultations (id TEXT, friend_id TEXT, status TEXT, created_at TEXT);
        """)

    def tearDown(self):
        self.db.close()

    def friend(self, key, account="saga", ref=attribution.REF):
        self.db.execute("INSERT INTO friends VALUES (?, ?, ?)", (key, account, ref))

    def touch(self, key, at="2026-10-08T09:00:00+09:00", ref=attribution.REF):
        self.db.execute("INSERT INTO ref_tracking VALUES (?, ?, ?)", (key, ref, at))

    def consultation(self, key, friend, at="2026-10-08T00:00:00Z", status="confirmed"):
        self.db.execute("INSERT INTO meet_consultations VALUES (?, ?, ?, ?)", (key, friend, status, at))

    def test_account_cohort_time_status_and_duplicates(self):
        self.friend("valid")
        self.friend("other-account", account="other")
        self.friend("other-ref", ref="dashboard")
        self.touch("valid", "2026-10-08T10:00:00+09:00")
        self.touch("valid")  # earliest, not latest, determines eligibility
        self.touch("valid")  # duplicate tracking must not multiply consultations
        self.touch("other-account")
        self.touch("other-ref")
        self.consultation("equal", "valid")
        self.consultation("equal", "valid")  # repeated joined row remains one consultation
        self.consultation("after", "valid", "2026-10-08T01:00:00Z", "completed")
        self.consultation("before", "valid", "2026-10-07T23:59:59Z")
        self.consultation("cancelled", "valid", status="cancelled")
        self.consultation("other-account", "other-account")
        self.consultation("other-ref", "other-ref")
        result = attribution.aggregate(self.db)
        self.assertEqual(result["firstRefFriends"], 1)
        self.assertEqual(result["consultationsAfterObservedTouch"], 2)
        self.assertEqual(result["unknownConsultations"], 0)
        self.assertEqual(result["status"], "measured")

    def test_unknown_is_separate_from_known_zero(self):
        self.friend("missing")
        self.friend("bad-touch")
        self.friend("bad-consultation")
        self.touch("missing", ref="other-ref")
        self.touch("bad-touch", "2026-02-30T00:00:00Z")
        self.touch("bad-consultation")
        self.consultation("missing", "missing")
        self.consultation("bad-touch", "bad-touch")
        self.consultation("bad-time", "bad-consultation", "2026-10-08T00:00:00")
        self.consultation("cancelled-unknown", "missing", status="cancelled")
        result = attribution.aggregate(self.db)
        self.assertEqual(result["consultationsAfterObservedTouch"], 0)
        self.assertEqual(result["unknownConsultations"], 3)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["missing"]["consultationsWithoutTouch"], 1)
        self.assertEqual(result["missing"]["consultationsWithoutValidTouch"], 1)
        self.assertEqual(result["missing"]["consultationsWithInvalidCreatedAt"], 1)

    def test_original_tracking_default_is_utc_but_consultation_naive_is_unknown(self):
        self.assertEqual(attribution.timestamp("2026-10-08 00:00:00", tracking=True),
                         attribution.timestamp("2026-10-08T09:00:00+09:00"))
        self.assertIsNone(attribution.timestamp("2026-10-08 00:00:00"))
        self.assertIsNone(attribution.timestamp("2026-10-08T00:00:00"))
        self.assertIsNone(attribution.timestamp("invalid", tracking=True))

    def test_read_only_snapshot_and_unmeasured_are_not_zero(self):
        self.friend("valid")
        self.touch("valid")
        self.consultation("equal", "valid")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.sqlite"
            destination = sqlite3.connect(path)
            self.db.commit()
            self.db.backup(destination)
            destination.close()
            before = path.read_bytes()
            self.assertEqual(attribution.report(path)["consultationsAfterObservedTouch"], 1)
            self.assertEqual(path.read_bytes(), before)
            missing_path = Path(directory) / "missing.sqlite"
            result = attribution.report(missing_path)
            self.assertEqual(result["status"], "unmeasured")
            self.assertIsNone(result["consultationsAfterObservedTouch"])
            self.assertFalse(missing_path.exists())

    def test_missing_account_is_unmeasured(self):
        self.db.execute("DELETE FROM line_accounts WHERE id = 'saga'")
        result = attribution.aggregate(self.db)
        self.assertEqual(result["status"], "unmeasured")
        self.assertIsNone(result["firstRefFriends"])


if __name__ == "__main__":
    unittest.main()
