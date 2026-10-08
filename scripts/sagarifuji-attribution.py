#!/usr/bin/env python3
"""Aggregate an explicitly supplied local SQLite snapshot, without writing it."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3


REF = "sagarifuji-threads"
CHANNEL_ID = "2011217182"
OFFSET_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$"
)
SQLITE_UTC_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")


def timestamp(value, *, tracking=False):
    """Accept explicit offsets; ref_tracking's original UTC SQLite default only."""
    if not isinstance(value, str):
        return None
    if tracking and SQLITE_UTC_TIMESTAMP.fullmatch(value):
        # packages/db/migrations/003_entry_routes.sql: datetime('now') is UTC.
        value = value.replace(" ", "T") + "Z"
    if not OFFSET_TIMESTAMP.fullmatch(value):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def unmeasured(reason):
    return {"status": "unmeasured", "reason": reason,
            "firstRefFriends": None, "consultationsAfterObservedTouch": None,
            "unknownConsultations": None}


def aggregate(db):
    account = db.execute(
        "SELECT id FROM line_accounts WHERE channel_id = ?", (CHANNEL_ID,)
    ).fetchall()
    if len(account) != 1:
        return unmeasured("target_account_unresolved")
    account_id = account[0][0]
    cohort = {row[0] for row in db.execute(
        "SELECT DISTINCT id FROM friends WHERE line_account_id = ? AND ref_code = ?",
        (account_id, REF),
    )}
    earliest = {}
    touch_friends = set()
    invalid_touch_rows = 0
    for friend_id, created_at in db.execute(
        """SELECT rt.friend_id, rt.created_at FROM ref_tracking rt
           JOIN friends f ON f.id = rt.friend_id
           WHERE f.line_account_id = ? AND f.ref_code = ? AND rt.ref_code = ?""",
        (account_id, REF, REF),
    ):
        touch_friends.add(friend_id)
        at = timestamp(created_at, tracking=True)
        if at is None:
            invalid_touch_rows += 1
        elif friend_id not in earliest or at < earliest[friend_id]:
            earliest[friend_id] = at

    known, unknown = set(), set()
    missing_touch, invalid_touch, invalid_consultation = set(), set(), set()
    for consultation_id, friend_id, created_at in db.execute(
        """SELECT DISTINCT c.id, c.friend_id, c.created_at FROM meet_consultations c
           JOIN friends f ON f.id = c.friend_id
           WHERE f.line_account_id = ? AND f.ref_code = ?
             AND c.status IN ('confirmed', 'completed')""",
        (account_id, REF),
    ):
        at = timestamp(created_at)
        touch = earliest.get(friend_id)
        if at is None or touch is None:
            unknown.add(consultation_id)
            if at is None:
                invalid_consultation.add(consultation_id)
            if friend_id not in touch_friends:
                missing_touch.add(consultation_id)
            elif touch is None:
                invalid_touch.add(consultation_id)
        elif at >= touch:
            known.add(consultation_id)

    return {
        "status": "partial" if unknown else "measured",
        "ref": REF, "accountChannelId": CHANNEL_ID,
        "accountMembership": "current",
        "firstRefFriends": len(cohort),
        "consultationsAfterObservedTouch": len(known),
        "unknownConsultations": len(unknown),
        "missing": {
            "cohortFriendsWithoutTouch": len(cohort - touch_friends),
            "cohortFriendsWithoutValidTouch": len(cohort - earliest.keys()),
            "invalidTouchRows": invalid_touch_rows,
            "consultationsWithoutTouch": len(missing_touch),
            "consultationsWithoutValidTouch": len(invalid_touch),
            "consultationsWithInvalidCreatedAt": len(invalid_consultation),
        },
        "unmeasuredMetrics": ["newLineRegistrations", "landingClicks", "revenue", "postConversions"],
    }


def report(path):
    """mode=ro prevents creation/writes; query_only also protects query execution."""
    try:
        db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
        try:
            db.execute("PRAGMA query_only = ON")
            return aggregate(db)
        finally:
            db.close()
    except (sqlite3.Error, OSError, ValueError):
        # Never include a database path, SQL error, or individual row in output.
        return unmeasured("snapshot_unavailable_or_schema_incomplete")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", help="Explicit path to a local SQLite snapshot")
    result = report(parser.parse_args().snapshot)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if result["status"] == "unmeasured" else 0


if __name__ == "__main__":
    raise SystemExit(main())
