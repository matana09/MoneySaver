// בדיקות אבטחה — לוגיקת הבוט (הרשאה, ReDoS, פרסרים) + מבנה מקלדת התפריט.
// ה-runner מגדיר MONEYSAVER_DATA_DIR לפני ההרצה — ה-DB שנפתח הוא זמני.
import { authDecision, authDecisionMulti, buildMenu, notifyTransactionAdded } from '../server/bot.js';
import { validateUserRegex, safeTest } from '../server/lib/safeRegex.js';
import { parseSms, looksLikeBankSms } from '../server/lib/smsParser.js';
import { parseTextExpense } from '../server/lib/textExpense.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

console.log('========== אבטחה — בוט טלגרם ==========\n');

const OWNER = '101';
check('B1  owner -> allow', authDecision(OWNER, OWNER, false) === 'allow');
check('B2  stranger -> deny', authDecision('303', OWNER, false) === 'deny');
check('B3  stranger + /start when owner set -> deny', authDecision('303', OWNER, true) === 'deny');
check('B4  no owner + /start -> allow (claim)', authDecision('123', '', true) === 'allow');
check('B5  no owner + message -> claim', authDecision('123', '', false) === 'claim');
check('B6  numeric id vs string owner', authDecision(101, '101', false) === 'allow');
check('B7  undefined from -> deny', authDecision(undefined, OWNER, false) === 'deny');

// authDecisionMulti — שני slots שווי-הרשאות (בני/בנות זוג)
const PARTNER = '202';
check('B7b owner1 -> allow', authDecisionMulti(OWNER, OWNER, '', false) === 'allow');
check('B7c owner2 -> allow', authDecisionMulti(PARTNER, OWNER, PARTNER, false) === 'allow');
check('B7d slot1 ריק + /start -> allow (claim)', authDecisionMulti('123', '', '', true) === 'allow');
check('B7e slot1 ריק + הודעה -> claim', authDecisionMulti('123', '', '', false) === 'claim');
check('B7f slot1 תפוס, slot2 ריק, זר + /start -> allow (claim slot2)', authDecisionMulti(PARTNER, OWNER, '', true) === 'allow');
check('B7g slot1 תפוס, slot2 ריק, זר + הודעה -> deny (לא ניתן לתבוע בלי /start)', authDecisionMulti(PARTNER, OWNER, '', false) === 'deny');
check('B7h שני ה-slots תפוסים, זר שלישי -> deny', authDecisionMulti('303', OWNER, PARTNER, false) === 'deny');
check('B7i שני ה-slots תפוסים, זר שלישי + /start -> deny', authDecisionMulti('303', OWNER, PARTNER, true) === 'deny');

check('B8  (a+)+ rejected', validateUserRegex('(a+)+').ok === false);
check('B9  (.*)* rejected', validateUserRegex('(.*)*').ok === false);
check('B10 valid regex accepted', validateUserRegex('שופרסל|רמי לוי').ok === true);
check('B11 invalid regex rejected', validateUserRegex('[unclosed').ok === false);
check('B12 safeTest caps huge input', (() => {
  const t0 = Date.now();
  safeTest('שופרסל', 'x'.repeat(100000));
  return Date.now() - t0 < 500;
})());

check('B13 empty SMS -> null', parseSms('') === null);
check('B14 text without amount -> null', parseTextExpense('בלי מספר') === null);
check('B15 large SMS amount', (() => {
  const r = parseSms('אושרה עסקה בסך 999999.99 ש"ח ב-חנות בתאריך 01/07');
  return r && r.amount === 999999.99;
})());
check('B16 control char does not crash parser', (() => {
  const r = parseTextExpense('קפה ‮ 25');
  return r !== null && r.amount === 25;
})());
check('B17 SMS vs normal message', looksLikeBankSms('חיוב בסך 50 ש"ח בחנות') === true
  && looksLikeBankSms('קפה גרג 25') === false);

// buildMenu — is_persistent רק כשהדגל menu_persistent פעיל (כלל ברזל 4:
// persistent ישיר אסור; רק דרך הדגל, ברירת מחדל כבוי)
check('B18 buildMenu(false) בלי is_persistent', buildMenu(false).is_persistent !== true);
check('B19 buildMenu(true) עם is_persistent', buildMenu(true).is_persistent === true);
check('B20 ברירת מחדל (בלי setting) — לא persistent', buildMenu().is_persistent !== true);

// notifyTransactionAdded — התראה לבן/בת הזוג על עסקה חדשה (web+בוט). בלי בוט
// מחובר (מצב הבדיקות) חוזרת false בשקט — לא זורקת ולא תלויה ברשת.
check('B21 notifyTransactionAdded בלי בוט פעיל — false בלי שגיאה', await notifyTransactionAdded(
  { type: 'expense', merchant: 'טסט', amount: 10, category_name: null }
) === false);
check('B22 notifyTransactionAdded עם excludeChatId — לא זורקת', await notifyTransactionAdded(
  { type: 'income', merchant: 'טסט', amount: 20 }, { excludeChatId: '123' }
) === false);

console.log(`\n========== bot: ${pass}/${pass + fail} ==========`);
process.exit(fail === 0 ? 0 : 1);
