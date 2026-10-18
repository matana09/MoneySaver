# -*- coding: utf-8 -*-
"""בדיקות קבלה (Acceptance) מול הגדרת הסיום של ה-PRD + בדיקות שפיות (Sanity).

רץ מול שרת בדיקות מבודד (MS_BASE) — לעולם לא מול נתוני האמת.
"""
import io
import json
import os
import sys
import time
import urllib.request
import urllib.error
from urllib.parse import quote, urlparse

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
BASE = os.environ.get("MS_BASE", "http://127.0.0.1:3100")
PORT = urlparse(BASE).port or 80

results = []


def call(method, path, body=None, raw=None, ctype="application/json", base=BASE):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw_body = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw_body)
        except json.JSONDecodeError:
            return e.code, {"_raw": raw_body[:200]}
    except Exception as exc:  # noqa: BLE001
        return -1, {"_exc": str(exc)}


def multipart(path, filename, file_bytes, ctype="text/csv"):
    b = "----msboundary"
    body = (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; "
            f"filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n").encode() \
           + file_bytes + f"\r\n--{b}--\r\n".encode()
    return call("POST", path, raw=body, ctype=f"multipart/form-data; boundary={b}")


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    mark = "✅" if cond else "❌"
    print(f"{mark} {name}" + (f"  — {detail}" if detail else ""))


def tx(body):
    return call("POST", "/api/transactions", body)


print("========== בדיקות קבלה ==========\n")

# --- A1: השרת חי ---
st, d = call("GET", "/api/health")
check("A1  השרת חי ועונה", st == 200 and d.get("ok"))

# --- A2: עסקה ידנית — CRUD מלא ב-SQLite ---
st, t = tx({"date": "2026-07-06", "amount": 100, "merchant": "בדיקת קבלה"})
ok_create = st == 201 and t.get("id")
st2, upd = call("PUT", f"/api/transactions/{t['id']}", {"amount": 150})
st3, lst = call("GET", "/api/transactions?q=" + quote("בדיקת קבלה"))
found = any(x["id"] == t["id"] and x["amount"] == 150 for x in lst.get("transactions", []))
check("A2  עסקה ידנית: יצירה + עדכון + שליפה", ok_create and st2 == 200 and found)

# --- A2b: מיון לפי סכום/תאריך (sort param, allowlist) ---
tx({"date": "2026-06-02", "amount": 500, "merchant": "מיון בדיקה זהב"})
tx({"date": "2026-06-20", "amount": 300, "merchant": "מיון בדיקה זהב"})
qs = "q=" + quote("מיון בדיקה זהב")
_, hi = call("GET", f"/api/transactions?{qs}&sort=amount_desc")
_, lo = call("GET", f"/api/transactions?{qs}&sort=amount_asc")
_, old = call("GET", f"/api/transactions?{qs}&sort=date_asc")
amt_hi = [x["amount"] for x in hi.get("transactions", [])]
amt_lo = [x["amount"] for x in lo.get("transactions", [])]
dates_old = [x["date"] for x in old.get("transactions", [])]
check("A2b מיון סכום גבוה→נמוך", amt_hi[:2] == [500, 300], f"{amt_hi[:2]}")
check("A2b מיון סכום נמוך→גבוה", amt_lo[:2] == [300, 500], f"{amt_lo[:2]}")
check("A2b מיון תאריך ישן→חדש", dates_old[:2] == ["2026-06-02", "2026-06-20"], f"{dates_old[:2]}")

# --- A2c: פילטר "ללא קטגוריה" (category_id=none → IS NULL) ---
_, tn = tx({"date": "2026-06-03", "amount": 77, "merchant": "ללא קטגוריה בדיקה זהב"})
call("PUT", f"/api/transactions/{tn['id']}", {"category_id": None})  # לוודא NULL מפורש
_, none_res = call("GET", "/api/transactions?category_id=none&q=" + quote("ללא קטגוריה בדיקה זהב"))
ids_none = [x["id"] for x in none_res.get("transactions", [])]
check("A2c פילטר ללא-קטגוריה מחזיר עסקה לא מסווגת", tn["id"] in ids_none)
_, tc = tx({"date": "2026-06-03", "amount": 88, "merchant": "עם קטגוריה בדיקה זהב", "category_id": 1})
_, none2 = call("GET", "/api/transactions?category_id=none&q=" + quote("עם קטגוריה בדיקה זהב"))
check("A2c עסקה מסווגת לא מופיעה בפילטר ללא-קטגוריה", all(x["id"] != tc["id"] for x in none2.get("transactions", [])))

# --- A3: ייבוא CSV + כפילויות ---
csv1 = ("תאריך רכישה,שם בית עסק,סכום חיוב\n"
        "01/06/2026,רמי לוי בדיקה,300.00\n"
        "05/06/2026,פז בדיקה,150.00\n"
        "10/06/2026,קפה בדיקה,45.50\n").encode("utf-8")
st, prev = multipart("/api/import/preview", "t.csv", csv1)
ok_prev = st == 200 and prev.get("parsed") == 3
st, com = call("POST", "/api/import/commit", {"source": "csv", "rows": prev["rows"]})
ok_com = st == 200 and com.get("inserted") == 3
st, prev2 = multipart("/api/import/preview", "t.csv", csv1)
ok_dup = prev2.get("duplicates") == 3
check("A3  ייבוא CSV: פרסינג, קליטה, זיהוי כפילויות בייבוא חוזר",
      ok_prev and ok_com and ok_dup,
      f"parsed=3 inserted={com.get('inserted')} dups={prev2.get('duplicates')}")

# --- A3b: CSV ב-windows-1255 ---
csv1255 = ("תאריך,תיאור,סכום\n01/07/2026,חנות קידוד בדיקה,77.70\n").encode("windows-1255")
st, p1255 = multipart("/api/import/preview", "enc.csv", csv1255)
ok_enc = st == 200 and p1255.get("parsed") == 1 and "קידוד" in p1255["rows"][0]["merchant"]
check("A3b קובץ בקידוד windows-1255 מפוענח נכון", ok_enc,
      p1255["rows"][0]["merchant"] if ok_enc else str(p1255)[:80])

# --- A3c: ייבוא מתמונה (JPG/PNG) דרך OCR — אותה קבוצת עסקאות כמו PDF (source='pdf') ---
_fixture_path = os.path.join(os.path.dirname(__file__), "fixtures", "ocr-sample.png")
with open(_fixture_path, "rb") as f:
    img_bytes = f.read()
st, pimg = multipart("/api/import/preview", "statement.png", img_bytes, ctype="image/png")
ok_img_prev = st == 200 and pimg.get("format") == "jpg" and pimg.get("source") == "pdf" and pimg.get("parsed") == 2
st, comimg = call("POST", "/api/import/commit", {"source": "pdf", "rows": pimg.get("rows", [])})
ok_img_com = st == 200 and comimg.get("inserted") == 2
st, pimg2 = multipart("/api/import/preview", "statement.png", img_bytes, ctype="image/png")
ok_img_dup = pimg2.get("duplicates") == 2
check("A3c ייבוא מתמונה (OCR): פרסינג, source=pdf, קליטה, זיהוי כפילויות",
      ok_img_prev and ok_img_com and ok_img_dup,
      f"format={pimg.get('format')} source={pimg.get('source')} parsed={pimg.get('parsed')} inserted={comimg.get('inserted')} dups={pimg2.get('duplicates')}")

# --- A4: SMS — כמה פורמטים ---
sms_cases = [
    'אושרה עסקה בסך 89.90 ש"ח ב-חנות אס-אם-אס אחת בתאריך 05/07',
    "חיוב בסך 45 ₪ בחנות אס-אם-אס שתיים ב-04/07",
    'בכרטיסך המסתיים ב-1234 בוצעה עסקה של 120.50 ש"ח ב-חנות אס-אם-אס שלוש',
]
sms_ok = 0
for s in sms_cases:
    st, d = call("POST", "/api/import/sms", {"text": s})
    if st == 201 and d.get("amount") in (89.9, 45, 120.5):
        sms_ok += 1
check("A4  קליטת SMS: 3 פורמטים בנקאיים", sms_ok == 3, f"{sms_ok}/3")

# --- A5: קטגוריזציה היברידית — דיוק על סט בדיקה ---
st, rule = call("POST", "/api/rules", {"pattern": "חוק-בדיקה", "category_id": 4})
train_set = [
    ("שופרסל דיל חולון", 1), ("שופרסל שלי תל אביב", 1), ("רמי לוי נתניה", 1),
    ("ויקטורי סופר", 1), ("מקדונלדס סינמה", 2), ("ברגר קינג עזריאלי", 2),
    ("קפה קפה ראשון", 2), ("ארומה תל אביב", 2), ("פז חולון", 3),
    ("סונול גדרה", 3), ("דלק מנטה רעננה", 3), ("בזק בינלאומי", 4),
    ("הוט מובייל", 4), ("סופר פארם מרכז", 6), ("בי דראגסטור", 6),
]
for merchant, cat in train_set:
    st, d = tx({"date": "2026-06-15", "amount": 50, "merchant": merchant, "category_id": cat})
st, tr = call("POST", "/api/settings/train")
ok_train = tr.get("trained") is True
time.sleep(1)
test_set = [
    ("חוק-בדיקה סניף חדש", 4),
    ("שופרסל דיל חולון", 1),
    ("שופרסל אקספרס באר שבע", 1),
    ("מקדונלדס קניון הזהב", 2),
    ("סונול צומת רעננה", 3),
    ("סופר פארם קניון איילון", 6),
    ("ארומה ספיר", 2),
    ("רמי לוי בת ים", 1),
    ("הוט טלקום", 4),
    ("פז אשדוד", 3),
]
hits = 0
misses = []
for merchant, expected in test_set:
    st, d = tx({"date": "2026-07-06", "amount": 30, "merchant": merchant})
    if d.get("category_id") == expected:
        hits += 1
    else:
        misses.append(f"{merchant}→{d.get('category_name')}")
acc = hits / len(test_set) * 100
check(f"A5  קטגוריזציה אוטומטית: דיוק ≥80% (בפועל {acc:.0f}%)", acc >= 80,
      ("פספוסים: " + ", ".join(misses)) if misses else "מודל אומן: " + str(tr))

# --- A6: חיזוי קיים ומתעדכן ---
st, fc1 = call("GET", "/api/forecast/2026-07")
ok_fc = st == 200 and (fc1.get("predicted_expenses") or 0) > 0
st, big = tx({"date": "2026-07-06", "amount": 2000, "merchant": "הוצאה גדולה לבדיקת חיזוי"})
st, fc2 = call("GET", "/api/forecast/2026-07")
updated = (fc2.get("predicted_expenses") or 0) > (fc1.get("predicted_expenses") or 0)
check("A6  חיזוי סוף חודש קיים ומתעדכן אחרי הוצאה",
      ok_fc and updated,
      f"{fc1.get('predicted_expenses')}→{fc2.get('predicted_expenses')} ({fc2.get('method')})")

# --- A7: סטטוס בוט/ML זמינים ---
st, s = call("GET", "/api/settings")
check("A7  סטטוס בוט/ML זמינים בהגדרות", st == 200 and "bot" in s and "ml" in s,
      f"bot.active={s['bot'].get('active')} ml={s['ml'].get('available')}")

# --- A8: נתוני דשבורד ---
st, inc = call("POST", "/api/income", {"name": "משכורת-בדיקה", "amount": 10000})
st, flow = call("GET", "/api/flow/2026-07")
ok_flow = (flow.get("total_income", 0) >= 10000 and flow.get("remaining") is not None
           and len(flow.get("by_category", [])) > 0)
st, fc = call("GET", "/api/forecast/2026-07")
ok_daily = len(fc.get("daily_actual", [])) > 0
check("A8  דשבורד: מחוון 'כמה נשאר' + פילוח קטגוריות + נתוני קו", ok_flow and ok_daily,
      f"remaining={flow.get('remaining')} cats={len(flow.get('by_category', []))}")

# --- A9: dual-stack — הרגרסיה של localhost בדפדפן ---
ok_v4, _ = call("GET", "/api/health", base=f"http://127.0.0.1:{PORT}")
ok_v6, _ = call("GET", "/api/health", base=f"http://[::1]:{PORT}")
check("A9  נגישות dual-stack: IPv4 + IPv6 (::1 של הדפדפן)", ok_v4 == 200 and ok_v6 == 200,
      f"v4={ok_v4} v6={ok_v6}")

# --- A10: PDF לא תקין — שגיאה מסודרת ---
st, d = multipart("/api/import/preview", "bad.pdf", b"not a real pdf", "application/pdf")
check("A10 PDF פגום נדחה עם הודעה ברורה (לא קריסה)", st == 422 and "error" in d,
      d.get("error", "")[:60])

# --- A11: תשלומים — פיצול ל-12 חיובים חודשיים ---
st, d = tx({"date": "2026-07-06", "amount": 1200, "merchant": "טלוויזיה בתשלומים",
            "installments": 12})
inst = d.get("installments", {})
ok_split = st == 201 and inst.get("count") == 12 and inst.get("per_amount") == 100
# כל 12 השורות קיימות, הסכום הכולל מדויק, והתאריכים פרוסים על 12 חודשים שונים
st, l = call("GET", "/api/transactions?limit=500&q=" + quote("טלוויזיה בתשלומים"))
rows = l.get("transactions", [])
months = {r["date"][:7] for r in rows}
total = round(sum(r["amount"] for r in rows), 2)
ok_rows = len(rows) == 12 and len(months) == 12 and total == 1200
# מחיקת קבוצה שלמה דרך שורה אחת
first_id = rows[0]["id"] if rows else 0
st, dl = call("DELETE", f"/api/transactions/{first_id}?group=1")
st2, l2 = call("GET", "/api/transactions?limit=500&q=" + quote("טלוויזיה בתשלומים"))
ok_del = dl.get("count") == 12 and l2.get("total") == 0
check("A11 תשלומים: 1,200 ב-12 → 12×100 על 12 חודשים + מחיקת קבוצה",
      ok_split and ok_rows and ok_del,
      f"rows={len(rows)} months={len(months)} total={total} deleted={dl.get('count')}")

# --- A12: מנויים — יצירה, due, חידוש באותו אורך תקופה ---
st, sub = call("POST", "/api/subscriptions", {
    "name": "אינטרנט בדיקה", "amount": 99,
    "start_date": "2026-01-15", "end_date": "2026-07-15",  # מסתיים בעוד ימים ספורים
})
ok_create = st == 201 and sub.get("days_left") is not None and sub["days_left"] <= 14
st, due = call("GET", "/api/subscriptions?due=1")
ok_due = any(s["id"] == sub["id"] for s in due)
st, renewed = call("POST", f"/api/subscriptions/{sub['id']}/renew")
# תקופה של 6 חודשים → החידוש מוסיף 6 חודשים: 2026-07-15 → 2027-01-15
ok_renew = st == 200 and renewed.get("end_date") == "2027-01-15" and renewed.get("start_date") == "2026-07-15"
st, due2 = call("GET", "/api/subscriptions?due=1")
ok_not_due = not any(s["id"] == sub["id"] for s in due2)
call("DELETE", f"/api/subscriptions/{sub['id']}")
check("A12 מנוי: יצירה → מופיע ב-due → חידוש 6 חודשים → יוצא מ-due",
      ok_create and ok_due and ok_renew and ok_not_due,
      f"end={renewed.get('end_date')} due_before={ok_due} due_after={not ok_not_due}")

print("\n========== בדיקות שפיות ==========\n")

st, d = call("POST", "/api/transactions", {"date": "06/07/2026", "amount": 10})
check("S1  תאריך בפורמט שגוי → 400", st == 400)

st, d = call("POST", "/api/transactions", {"date": "2026-07-06", "amount": -5})
check("S2  סכום שלילי → 400", st == 400)

st, d = call("POST", "/api/transactions", {"date": "2026-07-06", "amount": 10, "category_id": 9999})
check("S3  category_id לא קיים → 400", st == 400)

st, d = call("DELETE", "/api/transactions/999999")
check("S4  מחיקת עסקה לא קיימת → 404", st == 404)

st, d = call("GET", "/api/flow/2026-7")
check("S5  חודש בפורמט שגוי → 400", st == 400)

st, d = call("POST", "/api/rules", {"pattern": "[פתוח", "category_id": 1})
check("S6  regex לא תקין בחוק → 400", st == 400)

st, d = call("POST", "/api/transactions", raw=b"{not json", ctype="application/json")
check("S7  JSON שבור → 400 (השרת לא קורס)", st == 400)

st, d = multipart("/api/import/preview", "empty.csv", b"")
check("S8  קובץ ריק → שגיאה מסודרת", st == 422)

st, d = tx({"date": "2026-07-06", "amount": 5, "merchant": "<script>alert(1)</script>"})
ok_xss = st == 201 and d["merchant"] == "<script>alert(1)</script>"
check("S9  merchant עם HTML נשמר כטקסט (escaping בצד לקוח)", ok_xss)

st, d = call("POST", "/api/transactions", {"date": "2026-07-06", "amount": 100, "installments": 50})
check("S11 תשלומים מעל המקסימום (50) → 400", st == 400)

st, d = call("POST", "/api/subscriptions", {"name": "הפוך", "start_date": "2027-01-01", "end_date": "2026-01-01"})
check("S12 מנוי עם end לפני start → 400", st == 400)

st, d = call("GET", "/api/health")
check("S10 השרת עדיין חי אחרי כל הקלטים העוינים", st == 200 and d.get("ok"))

# ========== סיכום ==========
# הערה: אין צורך בניקוי — ה-DB זמני ונמחק על-ידי ה-runner.
passed = sum(1 for _, ok, _ in results if ok)
total = len(results)
print(f"\n========== סיכום: {passed}/{total} עברו ==========")
for name, ok, detail in results:
    if not ok:
        print(f"  ❌ {name} — {detail}")
sys.exit(0 if passed == total else 1)
