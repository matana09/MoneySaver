# -*- coding: utf-8 -*-
"""MoneySaver ML service — קטגוריזציה (TF-IDF + LogisticRegression) וחיזוי סוף חודש.

רץ כ-child process של שרת ה-Node ומאזין על 127.0.0.1 בלבד.
"""
import json
import sys
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    import joblib
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import Pipeline
except ImportError:
    print("SKLEARN_MISSING", flush=True)
    sys.exit(1)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8300
# MONEYSAVER_DATA_DIR — override לבדיקות (עקבי עם server/db.js)
_DATA_DIR = os.environ.get("MONEYSAVER_DATA_DIR") or os.path.join(os.path.dirname(__file__), "..", "data")
MODEL_PATH = os.path.join(_DATA_DIR, "ml_model.joblib")

model = None
if os.path.exists(MODEL_PATH):
    try:
        model = joblib.load(MODEL_PATH)
    except Exception:
        model = None


def train(data):
    """data: [{merchant, category_id}] — מאמן ושומר מודל."""
    global model
    merchants = [d["merchant"] for d in data]
    labels = [d["category_id"] for d in data]
    if len(set(labels)) < 2 or len(merchants) < 8:
        return {"trained": False, "reason": "not_enough_data", "samples": len(merchants)}
    pipeline = Pipeline([
        # n-grams של תווים — עמיד לסניפים ("שופרסל דיל רמת גן" ≈ "שופרסל אקספרס")
        ("tfidf", TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), min_df=1)),
        ("clf", LogisticRegression(max_iter=1000, C=10.0)),
    ])
    pipeline.fit(merchants, labels)
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    joblib.dump(pipeline, MODEL_PATH)
    model = pipeline
    return {"trained": True, "samples": len(merchants), "classes": len(set(labels))}


def categorize(merchant):
    if model is None or not merchant:
        return {"category_id": None, "confidence": 0.0}
    proba = model.predict_proba([merchant])[0]
    best = proba.argmax()
    return {
        "category_id": int(model.classes_[best]),
        "confidence": round(float(proba[best]), 3),
    }


def forecast(payload):
    """חיזוי סוף חודש לפי עקומת ההוצאה המצטברת הממוצעת מחודשים קודמים."""
    history = payload["history"]          # [{month, day, daily}]
    month = payload["month"]
    day_now = payload["day_now"]
    days_in_month = payload["days_in_month"]

    # בניית מצטבר לכל חודש
    months = {}
    for row in history:
        months.setdefault(row["month"], {})[row["day"]] = row["daily"]

    current = months.pop(month, {})
    spent_now = sum(v for d, v in current.items() if d <= day_now)

    # עקומת שיעור-מצטבר ממוצעת מחודשים מלאים קודמים
    fractions = []
    for m, days in months.items():
        if m >= month:
            continue
        total = sum(days.values())
        if total <= 0:
            continue
        cum = sum(v for d, v in days.items() if d <= day_now)
        fractions.append(cum / total)

    if not fractions:
        return {"predicted_expenses": None}  # Node יפעיל fallback

    avg_fraction = sum(fractions) / len(fractions)
    avg_fraction = max(avg_fraction, day_now / days_in_month * 0.5, 0.05)
    predicted = spent_now / avg_fraction if spent_now > 0 else 0

    # רצפה: לא פחות ממה שכבר הוצא
    predicted = max(predicted, spent_now)
    return {
        "predicted_expenses": round(predicted),
        "spent": round(spent_now, 2),
        "months_used": len(fractions),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
            if self.path == "/categorize":
                self._json(200, categorize(payload.get("merchant", "")))
            elif self.path == "/train":
                self._json(200, train(payload.get("data", [])))
            elif self.path == "/forecast":
                self._json(200, forecast(payload))
            else:
                self._json(404, {"error": "not found"})
        except Exception as exc:  # noqa: BLE001
            self._json(500, {"error": str(exc)})


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print("ML_READY", flush=True)
    server.serve_forever()
