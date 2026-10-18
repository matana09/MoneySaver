// Invented regression data only. This generator never reads a database or customer document.
import { writeFileSync } from 'node:fs';
const money = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const reversed = (n) => { const [whole, cents] = money(n).split('.'); return `${cents}\t.\t${whole}`; };
const total = (...values) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
const rows = [
  { year: 2017, p: 11000.11, cp: 75.22, i: 15000.33, ci: 125.44, o: 1300.55, bp: 450000.11, bc: 2500.22, ba: 900.33 },
  { year: 2020, p: 14000.16, cp: 650.27, i: 18000.38, ci: 850.49, o: 0, bp: 420000.14, bc: 22000.25, ba: 1100.36 },
  { year: 2023, p: 15500.21, cp: 1250.32, i: 20500.43, ci: 1750.54, o: 0, bp: 395000.31, bc: 43000.42, ba: 1000.53 },
];
const blocks = rows.map((r, idx) => {
  const fmt = idx === 0 ? reversed : money;
  const principal = idx === 1 ? '14, 6' : fmt(r.p);
  const balance = idx === 1 ? '420, 4' : fmt(r.bp);
  const heading = idx === 1 ? `מצב\tחשבון\tמתומצת\tלשנת\t${r.year}` : `מצב חשבון מתומצת לשנת ${r.year}`;
  return `${heading} - בשקלים חדשים\nא. ריכוז התשלומים שנתקבלו בשנת ${r.year}:\nב. ריכוז מרכיבי התשלומים שלעיל:\nקרן\t${principal} הצמדת\tקרן\t${fmt(r.cp)} ריבית\t${fmt(r.i)} הצמדת\tריבית\t${fmt(r.ci)}${r.o ? ` הוצאות\tאחרות\t)פירוט בהמשך(\t${fmt(r.o)}` : ''} סה"כ\t${fmt(total(r.p, r.cp, r.i, r.ci, r.o))}\nג. אופן ביצוע התשלומים בהלוואות:\nד. ריכוז יתרות תיקי הלוואות ליום 31.12.${r.year}:\nיתרות\tקרן\t${balance} הפרשי\tהצמדה\t${fmt(r.bc)} ריבית\tשהצטברה\tוטרם\tחויבה עד\t31/12/${r.year}\t${fmt(r.ba)} סה"כ\tיתרות\t${fmt(total(r.bp, r.bc, r.ba))}\nה. ביטוח חיים:`;
});
writeFileSync(new URL('../tests/fixtures/mortgage-annual.txt', import.meta.url), 'נתוני בדיקה מומצאים בלבד\n\n' + blocks.join('\n\n') + '\n');
console.log('Generated three invented annual mortgage statements.');
