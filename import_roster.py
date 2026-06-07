"""
PASS Buddy Check — Velarium Organizing Report ->Roster Import
=============================================================
Reads the standard Velarium "Organizing Report" Excel export and produces:
  1. A CSV file for record-keeping / manual review
  2. SQL statements applied directly to buddy-check-db via wrangler

Usage:
  python import_roster.py                          # converts + applies to REMOTE D1
  python import_roster.py --dry-run                # converts + prints SQL, does not apply
  python import_roster.py --local                  # applies to LOCAL D1 (wrangler dev)
  python import_roster.py --file path/to/file.xlsx # use a specific file

Expected input: standard Velarium Organizing Report .xlsx
No header row. Column layout (0-indexed):
  0  First name
  1  Last name
  2  Chapter code          (e.g. NE3, OK3)
  9  Chapter member #      (sequence within chapter)
  11 Phone A               (work/desk)
  12 Phone B               (cell/personal — PRIMARY)
  17 Status                (Active, Executive, etc.)

Output CSV columns:
  name, phone, phone_work, phone_uncertain, chapter_ref, local_num

phone_uncertain = 1 when:
  - col 12 is empty (no distinct cell on file), OR
  - col 12 == col 11 (only one number; may be a government device)
  Registration flow uses this to surface enhanced gov-device disclosure.
"""

import argparse
import csv
import os
import subprocess
import sys
import uuid
from datetime import date
from pathlib import Path

# ── Column indices (0-based, no header row) ───────────────────────────────────
COL_FIRST      = 0
COL_LAST       = 1
COL_CHAPTER    = 2
COL_SEQ        = 9
COL_PHONE_WORK = 11
COL_PHONE_CELL = 12
COL_STATUS     = 17

# ── Helpers ───────────────────────────────────────────────────────────────────

def normalize_phone(raw):
    """Return E.164 (+1XXXXXXXXXX) or None."""
    if not raw:
        return None
    digits = ''.join(c for c in str(raw) if c.isdigit())
    if len(digits) == 10:
        return f'+1{digits}'
    if len(digits) == 11 and digits[0] == '1':
        return f'+{digits}'
    return None

def sq(val):
    """Escape a value for SQL single-quoted string."""
    if val is None:
        return 'NULL'
    return "'" + str(val).replace("'", "''") + "'"

# ── Core conversion ───────────────────────────────────────────────────────────

def convert(xlsx_path):
    try:
        import openpyxl
    except ImportError:
        print('openpyxl not found. Run: pip install openpyxl')
        sys.exit(1)

    wb = openpyxl.load_workbook(xlsx_path)
    ws = wb.active

    rows = []
    skipped = []

    for row_num, row in enumerate(ws.iter_rows(values_only=True), 1):
        first   = str(row[COL_FIRST]  or '').strip()
        last    = str(row[COL_LAST]   or '').strip()
        chapter = str(row[COL_CHAPTER] or '').strip()
        seq     = str(row[COL_SEQ]    or '').strip()
        raw_work = str(row[COL_PHONE_WORK] or '').strip()
        raw_cell = str(row[COL_PHONE_CELL] or '').strip()
        status   = str(row[COL_STATUS] or '').strip()

        name = f'{first} {last}'.strip()
        if not name:
            skipped.append(f'Row {row_num}: empty name — skipped')
            continue

        cell_e164 = normalize_phone(raw_cell)
        work_e164 = normalize_phone(raw_work)

        # Primary phone: cell if available, fall back to work
        phone = cell_e164 or work_e164
        if not phone:
            skipped.append(f'Row {row_num}: {name} — no valid phone')
            continue

        # Flag: uncertain if no distinct cell, or cell == work
        phone_uncertain = 1 if (not cell_e164 or cell_e164 == work_e164) else 0

        chapter_ref = f'{chapter}-{seq}' if chapter and seq else None

        rows.append({
            'name':            name,
            'phone':           phone,
            'phone_work':      work_e164 or '',
            'phone_uncertain': phone_uncertain,
            'chapter_ref':     chapter_ref or '',
            'local_num':       chapter,
            '_status':         status,   # internal; not written to DB
        })

    return rows, skipped

# ── Write CSV ─────────────────────────────────────────────────────────────────

CSV_FIELDS = ['name', 'phone', 'phone_work', 'phone_uncertain', 'chapter_ref', 'local_num']

def write_csv(rows, out_path):
    with open(out_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)

# ── Write SQL ─────────────────────────────────────────────────────────────────

def write_sql(rows, out_path):
    with open(out_path, 'w', encoding='utf-8') as f:
        for r in rows:
            row_id = str(uuid.uuid4())
            f.write(
                f"INSERT INTO member_roster "
                f"(id, phone, phone_work, phone_uncertain, name, chapter_ref, local_num, imported_at) "
                f"VALUES ("
                f"{sq(row_id)}, "
                f"{sq(r['phone'])}, "
                f"{sq(r['phone_work']) if r['phone_work'] else 'NULL'}, "
                f"{r['phone_uncertain']}, "
                f"{sq(r['name'])}, "
                f"{sq(r['chapter_ref']) if r['chapter_ref'] else 'NULL'}, "
                f"{sq(r['local_num'])}, "
                f"datetime('now')"
                f") ON CONFLICT(phone) DO UPDATE SET "
                f"phone_work=excluded.phone_work, "
                f"phone_uncertain=excluded.phone_uncertain, "
                f"name=excluded.name, "
                f"chapter_ref=excluded.chapter_ref, "
                f"local_num=excluded.local_num, "
                f"imported_at=excluded.imported_at;\n"
            )

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Import Velarium roster into buddy-check-db')
    parser.add_argument('--file',    default=None,  help='Path to .xlsx file')
    parser.add_argument('--dry-run', action='store_true', help='Print SQL, do not apply')
    parser.add_argument('--local',   action='store_true', help='Apply to local D1 (wrangler dev)')
    args = parser.parse_args()

    # Locate xlsx
    script_dir = Path(__file__).parent
    if args.file:
        xlsx_path = Path(args.file)
    else:
        candidates = sorted((script_dir / 'source-data').glob('*.xlsx'))
        if not candidates:
            print('No .xlsx found in source-data/. Use --file to specify one.')
            sys.exit(1)
        xlsx_path = candidates[-1]  # most recently modified

    print(f'Reading: {xlsx_path}')
    rows, skipped = convert(xlsx_path)

    today     = date.today().strftime('%Y%m%d')
    base_name = f'velarium-roster_v1_{today}'
    out_dir   = script_dir / 'source-data'
    csv_path  = out_dir / f'{base_name}.csv'
    sql_path  = out_dir / f'{base_name}.sql'

    write_csv(rows, csv_path)
    write_sql(rows, sql_path)

    print(f'\nOK {len(rows)} rows converted ({len(skipped)} skipped)')
    print(f'  CSV ->{csv_path}')
    print(f'  SQL ->{sql_path}')

    if skipped:
        print('\nSkipped:')
        for s in skipped:
            print(f'  {s}')

    # Print uncertain-device summary
    uncertain = [r for r in rows if r['phone_uncertain']]
    if uncertain:
        print(f'\nWARN {len(uncertain)} member(s) with uncertain phone (cell = work or missing):')
        for r in uncertain:
            print(f'  {r["name"]:30s}  {r["phone"]}  ({r["chapter_ref"]})')
        print('  Consider reaching out before they register.')

    if args.dry_run:
        print('\n-- DRY RUN: SQL that would be applied --')
        print(sql_path.read_text())
        return

    # Apply via wrangler
    remote_flag = [] if args.local else ['--remote']
    cmd = [
        'npx', 'wrangler', 'd1', 'execute', 'buddy-check-db',
        *remote_flag,
        '--config', str(script_dir / 'wrangler.toml'),
        '--file',   str(sql_path),
    ]
    print(f'\nApplying to {"local" if args.local else "remote"} D1...')
    result = subprocess.run(cmd, capture_output=True, text=True, shell=(os.name == 'nt'))
    if result.returncode == 0:
        print(f'OK {len(rows)} rows applied to buddy-check-db')
    else:
        print('ERROR wrangler error:')
        print(result.stderr or result.stdout)
        sys.exit(1)

if __name__ == '__main__':
    main()
