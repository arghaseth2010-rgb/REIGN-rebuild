// R.E.I.G.N. reminder engine.
//
// Runs every minute. For every signed-in user with reminders turned on,
// it checks their habits/tasks against the current time *in that user's
// own timezone* (captured client-side and stored on their state doc),
// and sends a push notification through Firebase Cloud Messaging to
// every device they've registered (Windows + Android alike).
//
// Data model this expects (matches the client exactly):
//   users/{uid}/app/state        -> the same JSON blob the app keeps locally
//   users/{uid}/app/reminderLog  -> { date: "YYYY-MM-DD", ids: [...] } — written
//                                    only by this function, never by the client,
//                                    so the two writers can't stomp on each other.
//   users/{uid}/fcmTokens/{token}-> one doc per device registered for push

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

function timeInZone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  } catch (err) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
}
function dateKeyInZone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date); // YYYY-MM-DD
  } catch (err) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(date);
  }
}

exports.checkReminders = onSchedule('every 1 minutes', async () => {
  const now = new Date();
  const usersSnap = await db.collection('users').get();

  for (const userSnap of usersSnap.docs) {
    const uid = userSnap.id;
    const appRef = db.collection('users').doc(uid).collection('app');

    const stateSnap = await appRef.doc('state').get();
    if (!stateSnap.exists) continue;
    const state = stateSnap.data();
    if (!state.notifsEnabled) continue;

    const tz = state.timezone || 'UTC';
    const hm = timeInZone(now, tz);
    const dateKey = dateKeyInZone(now, tz);

    const logRef = appRef.doc('reminderLog');
    const logSnap = await logRef.get();
    let log = logSnap.exists ? logSnap.data() : { date: null, ids: [] };
    if (log.date !== dateKey) log = { date: dateKey, ids: [] };

    const due = [];
    (state.challenges || []).forEach((c) => {
      if (!c.reminder || c.reminder.time !== hm || c.done || c.skipped) return;
      const rid = 'h' + c.id;
      if (!log.ids.includes(rid)) due.push({ rid, title: 'Quest due: ' + c.text });
    });
    (state.tasks || []).forEach((t) => {
      if (!t.reminder || t.reminder.time !== hm || t.done || t.skipped) return;
      // Tasks store dueDate as a JS toDateString() string; re-derive its
      // date key in the user's own timezone so "today" means the same
      // thing here as it does on their device.
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
        } catch (err) {
          console.error(`Failed to send reminder ${item.rid} for user ${uid}:`, err);
        }
      }
    }

    due.forEach((item) => log.ids.push(item.rid));
    await logRef.set(log);
  }
});
