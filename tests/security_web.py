# -*- coding: utf-8 -*-
"""בדיקות אבטחה — צד ה-web (REST API). רץ מול שרת בדיקות מבודד (MS_BASE)."""
import io
import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
BASE = os.environ.get("MS_BASE", "http://127.0.0.1:3100")
results = []


def call(method, path, body=None, raw=None, ctype="application/json"):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except Exception as exc:  # noqa: BLE001
        return -1, str(exc)


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(f"{'✅' if cond else '❌'} {name}" + (f"  — {detail}" if detail else ""))


print("========== אבטחה — WEB ==========\n")

# W1: SQL Injection בשדה חיפוש
payload = "'; DROP TABLE transactions; --"
st, body = call("GET", "/api/transactions?q=" + urllib.parse.quote(payload))
st2, _ = call("GET", "/api/health")
st3, _ = call("POST", "/api/transactions", {"date": "2026-07-06", "amount": 1, "merchant": "sqli-probe"})
check("W1  SQL Injection ב-q לא מפיל את הטבלה", st == 200 and st2 == 200 and st3 == 201)

# W2: SQLi בפרמטר מספרי
st, _ = call("GET", "/api/transactions?category_id=" + urllib.parse.quote("1 OR 1=1"))
check("W2  SQLi ב-category_id לא גורם ל-500", st in (200, 400))

# W3: XSS — נשמר גולמי
st, body = call("POST", "/api/transactions",
                {"date": "2026-07-06", "amount": 2, "merchant": "<img src=x onerror=alert(1)>"})
d = json.loads(body)
check("W3  payload XSS נשמר כטקסט גולמי (לא מסונף/מבוצע)",
      st == 201 and d["merchant"] == "<img src=x onerror=alert(1)>")

# W4: ReDoS
st, body = call("POST", "/api/rules", {"pattern": "(a+)+$", "category_id": 1})
check("W4  regex עם catastrophic backtracking נדחה", st == 400, json.loads(body).get("error", ""))

# W5: regex ארוך
st, _ = call("POST", "/api/rules", {"pattern": "a" * 500, "category_id": 1})
check("W5  regex ארוך מ-200 תווים נדחה", st == 400)

# W6: body ענק
huge = {"date": "2026-07-06", "amount": 5, "merchant": "x" * (300 * 1024)}
st, _ = call("POST", "/api/transactions", huge)
check("W6  body ענק (>256kb) → 413 (לא קריסה)", st == 413)

# W7: merchant ארוך נחתך
st, body = call("POST", "/api/transactions",
                {"date": "2026-07-06", "amount": 3, "merchant": "y" * 5000})
d = json.loads(body) if st == 201 else {}
check("W7  merchant של 5000 תווים נחתך ל-200", st == 201 and len(d.get("merchant", "")) <= 200,
      f"len={len(d.get('merchant',''))}")

# W8: JSON שבור
st, _ = call("POST", "/api/transactions", raw=b"{broken json")
check("W8  JSON שבור → 400", st == 400)

# W9: path traversal
st, _ = call("GET", "/../../server/db.js")
st2, _ = call("GET", "/..%2f..%2fserver%2fdb.js")
check("W9  path traversal לקבצי שרת נחסם", st in (400, 403, 404) and st2 in (400, 403, 404),
      f"{st},{st2}")

# W10: קובץ לא נתמך
st, body = call("POST", "/api/import/preview",
                raw=(b"------b\r\nContent-Disposition: form-data; name=\"file\"; "
                     b"filename=\"x.exe\"\r\nContent-Type: application/octet-stream\r\n\r\n"
                     b"MZ\x90\x00binary\r\n------b--\r\n"),
                ctype="multipart/form-data; boundary=----b")
check("W10 קובץ לא-CSV/PDF (.exe) לא נקלט כעסקאות", st in (200, 422))

# W11: type לא חוקי
st, _ = call("POST", "/api/transactions", {"date": "2026-07-06", "amount": 4, "type": "steal"})
check("W11 type לא חוקי → 400", st == 400)

# W12: מספרים לא סופיים
st, _ = call("POST", "/api/transactions", {"date": "2026-07-06", "amount": "Infinity"})
st2, _ = call("POST", "/api/transactions", {"date": "2026-07-06", "amount": "1e999"})
check("W12 amount לא-סופי (Infinity/1e999) נדחה", st == 400 and st2 == 400)

# W13: Stored XSS דרך icon של קטגוריה — נדחה
st, body = call("POST", "/api/categories",
                {"name": "xss-icon", "icon": "<img src=x onerror=alert(1)>"})
check("W13 icon עם HTML בקטגוריה נדחה (stored XSS)", st == 400, f"status={st}")

# W14: CSS-injection דרך color של קטגוריה — נדחה (רק hex)
st, _ = call("POST", "/api/categories", {"name": "xss-color", "color": "red;background:url(javascript:alert(1))"})
check("W14 color לא-hex בקטגוריה נדחה (CSS-injection)", st == 400, f"status={st}")

# W15: color hex תקין מתקבל
st, _ = call("POST", "/api/categories", {"name": "ok-color-" + str(os.getpid()), "color": "#4caf7d", "icon": "🎯"})
check("W15 קטגוריה עם hex+אימוג'י תקינים מתקבלת", st in (201, 409), f"status={st}")

# W16: name עם HTML בקטגוריה נדחה
st, _ = call("POST", "/api/categories", {"name": "<script>alert(1)</script>"})
check("W16 name עם < > בקטגוריה נדחה", st == 400, f"status={st}")

# W17: כותרות אבטחה קיימות (CSP + nosniff + frame-options)
req = urllib.request.Request(BASE + "/api/health")
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        hdrs = {k.lower(): v for k, v in r.headers.items()}
except Exception:  # noqa: BLE001
    hdrs = {}
csp = hdrs.get("content-security-policy", "")
check("W17 כותרות אבטחה קיימות (CSP script-src, nosniff, frame-options)",
      "script-src" in csp and "'unsafe-inline'" not in csp.split("style-src")[0]
      and hdrs.get("x-content-type-options") == "nosniff"
      and hdrs.get("x-frame-options") == "DENY",
      f"csp={'yes' if csp else 'no'}")

passed = sum(1 for _, ok in results if ok)
print(f"\n========== WEB: {passed}/{len(results)} ==========")
for name, ok in results:
    if not ok:
        print("  ❌", name)
sys.exit(0 if passed == len(results) else 1)
