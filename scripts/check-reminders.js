// R.E.I.G.N. reminder checker — Spark-plan friendly version.
//
// This does exactly what functions/index.js does, but as a plain Node
// script instead of a Cloud Function, so it can be triggered by GitHub
// Actions' free scheduler instead of Cloud Scheduler. No Firebase
// billing account needed anywhere.
//
// Because GitHub Actions cron isn't guaranteed to fire on the exact
// minute (and we run it every 5 minutes, not every 1), this checks a
// trailing WINDOW_MINUTES window instead of an exact HH:MM match, so a
// reminder set for 8:03 still fires on the 8:00–8:05 run.
//
// Auth: reads a Firebase service account key from the
// FIREBASE_SERVICE_ACCOUNT_KEY environment variable (the whole JSON,
// as one string — see SETUP.md for how to generate it). Service
// account keys are free on the Spark plan; they're just IAM
// credentials, unrelated to Cloud Functions billing.

const admin = require('firebase-admin');

const WINDOW_MINUTES = 6; // slightly wider than the 5-min cron interval to absorb scheduling jitter

const keyJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
if (!keyJson) {
  console.error('FIREBASE_SERVICE_ACCOUNT_KEY environment variable is not set.');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(keyJson)) });
const db = admin.firestore();
const messaging = admin.messaging();

function minutesSinceMidnight(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}
function timeInZone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  } catch (err) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
}
function dateKeyInZone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
  } catch (err) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(date);
  }
}
// Is `reminderHm` within the last WINDOW_MINUTES minutes ending at `nowHm`?
// (Doesn't handle the midnight-wraparound edge case — a reminder in the
// last few minutes before midnight can be missed once a day, which is an
// acceptable trade-off for a personal habit tracker.)
function inWindow(reminderHm, nowHm) {
  const r = minutesSinceMidnight(reminderHm);
  const n = minutesSinceMidnight(nowHm);
  return r <= n && r > n - WINDOW_MINUTES;
}

async function main() {
  const now = new Date();
  const usersSnap = await db.collection('users').get();
  console.log(`Checking reminders for ${usersSnap.size} user(s) at ${now.toISOString()}`);

  for (const userSnap of usersSnap.docs) {
    const uid = userSnap.id;
    const appRef = db.collection('users').doc(uid).collection('app');

    const stateSnap = await appRef.doc('state').get();
    if (!stateSnap.exists) continue;
    const state = stateSnap.data();
    if (!state.notifsEnabled) continue;

    const tz = state.timezone || 'UTC';
    const nowHm = timeInZone(now, tz);
    const dateKey = dateKeyInZone(now, tz);

    const logRef = appRef.doc('reminderLog');
    const logSnap = await logRef.get();
    let log = logSnap.exists ? logSnap.data() : { date: null, ids: [] };
    if (log.date !== dateKey) log = { date: dateKey, ids: [] };

    const due = [];
    (state.challenges || []).forEach((c) => {
      if (!c.reminder || !inWindow(c.reminder.time, nowHm) || c.done || c.skipped) return;
      const rid = 'h' + c.id;
      if (!log.ids.includes(rid)) due.push({ rid, title: 'Quest due: ' + c.text });
    });
    (state.tasks || []).forEach((t) => {
      if (!t.reminder || !inWindow(t.reminder.time, nowHm) || t.done || t.skipped) return;
      const taskDateKey = dateKeyInZone(new Date(t.dueDate), tz);
      if (taskDateKey !== dateKey) return;
      const rid = 't' + t.id;
      if (!log.ids.includes(rid)) due.push({ rid, title: 'Task due: ' + t.text });
    });

    if (due.length === 0) continue;

    const tokensSnap = await db.collection('users').doc(uid).collection('fcmTokens').get();
    const tokens = tokensSnap.docs.map((d) => d.id);

    if (tokens.length > 0) {
      for (const item of due) {
        try {
          const resp = await messaging.sendEachForMulticast({
            tokens,
            notification: { title: item.title, body: 'Tap into R.E.I.G.N. to check it off.' },
            data: { id: item.rid },
          });
          resp.responses.forEach((r, i) => {
            const code = r.error && r.error.code;
            if (!r.success && (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token')) {
              db.collection('users').doc(uid).collection('fcmTokens').doc(tokens[i]).delete().catch(() => {});
            }
          });
          console.log(`Sent "${item.title}" to ${tokens.length} device(s) for user ${uid}`);
        } catch (err) {
          console.error(`Failed to send reminder ${item.rid} for user ${uid}:`, err);
        }
      }
    }

    due.forEach((item) => log.ids.push(item.rid));
    await logRef.set(log);
  }

  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
