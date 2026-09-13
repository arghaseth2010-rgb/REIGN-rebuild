# R.E.I.G.N. — PWA + Firebase sync + real push reminders (no Blaze plan needed)

This turns REIGN into an installable app on Windows and Android that:
- syncs your habits/tasks/XP across both devices through one Google account
- sends a real push notification at each quest's reminder time — even if
  the app is fully closed

Firebase's Spark (free) plan covers everything here — Auth, Firestore,
Hosting, and Cloud Messaging are all free with no billing account
required. The one thing that *does* require Firebase's paid Blaze plan
is Cloud Functions (even at $0 usage, Google requires a linked billing
account just to deploy one). So instead of a Cloud Function, the
reminder check runs as a small script on **GitHub Actions' free
scheduler** — completely free, no card anywhere.

## How it fits together

```
index.html    → the app itself. Handles sign-in and read/write to Firestore.
manifest.json → makes it installable as a PWA on Windows/Android.
sw.js         → service worker: offline caching + receives push while closed.
scripts/      → check-reminders.js — the reminder engine. Runs every 5
                minutes via GitHub Actions (see .github/workflows/reminders.yml),
                reads Firestore, and sends pushes through Firebase Cloud
                Messaging. This is what lets pushes fire while your
                phone/PC app is fully closed — it's not running on your
                device at all, it's running on GitHub's servers.
firestore.rules → makes sure only you can read/write your own data.
functions/    → an equivalent Cloud Function, kept here in case you ever
                upgrade to Blaze and would rather use Firebase's own
                scheduler instead of GitHub Actions. Not needed otherwise.
```

Data lives at `users/{your-uid}/app/state` in Firestore — the exact same
JSON your browser used to keep in `localStorage`, just mirrored to the
cloud so both devices see the same thing.

**Trade-off of skipping Blaze:** GitHub's scheduler runs every 5 minutes
rather than every 1, and isn't guaranteed to fire on the exact minute —
so a reminder set for 8:03 typically fires somewhere between 8:00 and
8:10, not at 8:03 sharp. For a habit tracker that's usually fine; if you
want to-the-minute precision later, upgrading to Blaze and switching to
`functions/` gets you that (see the note at the bottom).

---

## 1. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → name it (e.g. "reign-habits") → finish the wizard (Analytics is optional, skip it if you don't want it).
2. Stay on the **Spark (free)** plan — don't click anything that offers to upgrade to Blaze.

## 2. Turn on the services you need

In the Firebase console, inside your new project:

- **Build → Authentication → Get started → Sign-in method** → enable **Google**. Pick a support email when prompted.
- **Build → Firestore Database → Create database** → start in **production mode** → pick a region close to you.
- **Build → Messaging** — nothing to click yet, but note the tab exists; you'll come back for a key in step 4.

## 3. Register a Web App and copy the config

1. Project settings (gear icon, top left) → scroll to **Your apps** → click the **</>** (web) icon.
2. Give it a nickname (e.g. "reign-web"), skip Firebase Hosting setup in this wizard (we'll do it via CLI), click **Register app**.
3. Firebase shows you a `firebaseConfig` object like:
   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "reign-habits.firebaseapp.com",
     projectId: "reign-habits",
     storageBucket: "reign-habits.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abcdef",
   };
   ```
4. Copy those six values into **two places** in this project — they must match exactly in both:
   - `index.html` — search for `firebaseConfig` near the top of the `<script>` block.
   - `sw.js` — search for `firebase.initializeApp` near the bottom.

## 4. Generate a Web Push (VAPID) key

1. Project settings → **Cloud Messaging** tab → scroll to **Web configuration** → **Web Push certificates** → **Generate key pair**.
2. Copy the long key string it gives you.
3. In `index.html`, find `const FCM_VAPID_KEY = "TODO_VAPID_KEY";` and paste it in.

## 5. Generate a service account key (for the reminder checker)

This is what lets the GitHub Actions script read Firestore and send
pushes on your behalf. It's free and doesn't touch billing at all.

1. Project settings → **Service accounts** tab → **Generate new private key** → confirm. This downloads a `.json` file — keep it safe, it grants full access to your project.
2. You'll paste its entire contents into a GitHub secret in step 7 — don't commit this file to the repo.

## 6. Deploy Hosting and Firestore rules with the CLI

On your computer, with [Node.js](https://nodejs.org) installed:

```bash
npm install -g firebase-tools
firebase login

cd path/to/reign-pwa
firebase use --add          # pick your project, alias it "default"
firebase deploy --only hosting,firestore
```

`--only hosting,firestore` deliberately skips `functions/`, since that
folder needs Blaze — this deploys just the app and the security rules.
The command output gives you your live URL, something like
`https://reign-habits.web.app`.

## 7. Set up the GitHub Actions reminder checker

1. Push this project to a GitHub repository. **Making the repo public is the easiest option** — public repos get unlimited free Actions minutes, and there's no personal data in the repo itself (your habit data lives in Firestore, not here). If you'd rather keep it private, that's fine too — private repos get 2,000 free Actions minutes/month, which comfortably covers checking every 5 minutes.
2. In the repo, go to **Settings → Secrets and variables → Actions → New repository secret**.
3. Name it `FIREBASE_SERVICE_ACCOUNT_KEY`, and paste the **entire contents** of the service account JSON file from step 5 as the value.
4. The workflow at `.github/workflows/reminders.yml` is already set up to run every 5 minutes automatically once it's on GitHub's default branch. You can also trigger it manually any time from the repo's **Actions** tab → "R.E.I.G.N. quest reminders" → **Run workflow**, which is the fastest way to test it.

## 8. Install it on Windows

1. Open the deployed URL in Chrome or Edge.
2. Click the install icon in the address bar (or menu → **Install R.E.I.G.N.**).
3. Sign in with Google when the app prompts you.
4. Go to the **Profile** tab → **Quest Reminders** → flip the toggle on, and allow notifications when the browser asks.

## 9. Install it on Android

1. Open the same URL in Chrome on your phone.
2. Tap the menu → **Add to Home screen** / **Install app**.
3. Open it from the home screen, sign in with the **same** Google account.
4. Profile tab → **Quest Reminders** → toggle on → allow notifications.

Once both devices have signed in and turned reminders on, each one
registers its own push token — so a single reminder time on a habit will
notify both your PC and your phone.

---

## Things worth knowing

- **Timezone**: your device's timezone is captured automatically and saved with your data. The reminder check runs in *that* timezone, not UTC. If you travel, opening the app in the new timezone updates it.
- **Reminder precision**: as noted above, expect reminders within a window after their set time (typically a few minutes, occasionally more if GitHub's scheduler is under load), not to-the-second.
- **Sync conflicts**: this uses simple last-write-wins syncing (whichever device saved most recently). Making changes offline on two devices at once and reconnecting both could occasionally drop one side's very latest edit — a non-issue for normal single-person use, but not built for true multi-editor conflict resolution.
- **iOS**: Apple's Safari/PWA push support is limited and version-dependent. This is built and tested against the Windows + Android path you asked for; iOS may partially work or may not, depending on your iOS version.
- **Local-only fallback**: if you ever open `index.html` without deploying Firebase (i.e. the placeholder config is still in place), sign-in will fail — swap back to the previous non-Firebase version of the file if you want to use it purely offline.
- **If you later upgrade to Blaze anyway**: the `functions/` folder has an equivalent `checkReminders` Cloud Function that runs every 1 minute via Firebase's own scheduler — more precise, and one less moving part (no GitHub dependency). Deploy it with `firebase deploy --only functions` and disable/delete the GitHub Actions workflow so the two don't both fire.

