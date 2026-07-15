# Attendance

Campus attendance for Android. Teachers check in and out with a GPS-verified
selfie; operators record student numbers; admins see a live dashboard and export
months to CSV. All data lives in one Google Sheet you own.

**Total cost: nothing.** No servers, no Firebase, no Play Store fee, no card.

---

## What you need

- A Google account (free)
- A GitHub account (free)

That's it. You don't need Android Studio, a Mac, or a developer licence.

---

## 1 — Create the Sheet and its backend

1. Go to <https://sheets.google.com> and create a blank spreadsheet. Name it
   **Attendance Data**.
2. In that sheet: **Extensions > Apps Script**. A code editor opens.
3. Delete whatever is in `Code.gs`, and paste in the contents of
   `apps-script/Code.gs` from this project.
4. Click **Save**, then pick `setup` from the function dropdown and press **Run**.
   - Google will ask for permission. Click through **Advanced > Go to (project)
     > Allow**. It warns because the script is yours and unverified — that's
     expected.
   - This creates the tabs (`Users`, `Campuses`, `TeacherAttendance`,
     `StudentAttendance`, `Settings`) and a Drive folder for check-in photos.
5. Click **Deploy > New deployment**. Choose type **Web app**, then set:
   - **Execute as:** Me
   - **Who has access:** Anyone
6. Press **Deploy** and copy the **Web app URL**. It ends in `/exec`.

> **On "Anyone":** this only means the URL is reachable without a Google login —
> the app still requires a username and PIN. Don't post the URL publicly.

## 2 — Point the app at your backend

Open `www/app.js`. The first line of real code is:

```js
var API_URL = 'PASTE_YOUR_APPS_SCRIPT_EXEC_URL_HERE';
```

Replace it with the `/exec` URL you just copied. Save.

## 3 — Build the APK

1. Create a new repository on GitHub and upload this whole folder to it
   (drag-and-drop works: **Add file > Upload files**).
2. Open the **Actions** tab. If it asks, click **I understand my workflows,
   enable them**.
3. The build starts on its own. It takes about 4 minutes.
4. When the green tick appears, click the run, scroll to **Artifacts**, and
   download **attendance-apk**. Unzip it to get `attendance.apk`.

To rebuild later, just edit a file and commit — or press **Run workflow**.

## 4 — Install it

Send `attendance.apk` to each phone (WhatsApp, Drive, or USB). Opening it will
prompt *"install unknown apps"* — allow it for whichever app you used to send it.
This is normal for apps not from the Play Store.

On first launch the app asks you to create the admin account. After that:

1. Sign in as admin, open **Campuses**, and rename your campuses.
2. Stand at each campus and tap **Use my location** to pin its GPS point.
   Until you do, check-ins are recorded without distance verification.
3. Under **Rules**, set the late cutoff and how far from campus a check-in may be.
4. Under **Users**, add your teachers and operators. **Write each PIN down as you
   create it — it is hashed immediately and never shown again.**

---

## How it behaves

**Roles.** Teachers only see the check-in screen. Operators get the dashboard and
student attendance. Admins get everything, plus users, campuses and export.

**Offline.** Check-ins, check-outs and student entries save on the phone when
there's no signal and upload themselves once it returns — a red bar at the top
shows how many are waiting. Teachers can also sign in offline if they've signed
in on that phone before. The dashboard shows the last data the phone saw.

**Selfies.** Taken with the front camera on check-in, stored in your Drive folder,
linked from the sheet and shown on the dashboard. Skipping the camera still
records the check-in.

**Reminders.** Teachers get a notification 15 minutes before the late cutoff if
they haven't checked in. It's scheduled on the phone — no push service involved —
and cancels itself once they check in.

**Export.** Admin > Dashboard > Export gives you a CSV of any month: every
check-in with times, late flags, hours, distance and photo link, plus the student
numbers.

---

## Editing it later

- **The screens** are `www/app.js`, plain JavaScript, no build step.
- **The look** is `www/app.css` (design tokens) and `www/shell.css` (layout).
- **The backend** is `apps-script/Code.gs` — paste changes back into the editor
  and **Deploy > Manage deployments > edit > Version: New version**. If you skip
  the new version, your change won't go live.

## If something goes wrong

**"Backend not connected"** — `API_URL` in `www/app.js` is still the placeholder.

**Every request fails** — the deployment's access isn't set to *Anyone*, or you
copied the `/dev` URL instead of `/exec`.

**Changes to Code.gs do nothing** — you didn't deploy a **new version**.

**Location permission denied** — Android > Settings > Apps > Attendance >
Permissions > Location > *Allow only while using the app*.

**The build fails** — open the failed step in Actions; it's almost always a typo
in `www/app.js`. Fix and push again.

---

## Note on security

PINs are hashed (SHA-256) before storage, so nobody — including you in the sheet —
can read them back. This is deliberate: the original version stored them in plain
text and showed every PIN on the admin screen.

That said, a 4-digit PIN is weak by nature, and anyone with the `/exec` URL can
attempt logins against it. That's a reasonable trade for a staff attendance app;
it would not be for anything sensitive. Keep the URL private, and if it ever
leaks, redeploy to get a new one.
