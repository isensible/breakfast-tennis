# Breakfast Tennis court bookings — setup

A small web app for the admin team to record court bookings and attendance for Breakfast Tennis sessions. Each session shows one lane per court on a time axis, with the published session times marked, so it's easy to see which courts are covered for the whole session, partly covered, or free. Data is stored in a Google Sheet; the page is served by Google Apps Script.

Bookings are individual time slots: a court can have several in one session (for example 06:00–07:00 and 07:00–08:30), and a booking may start before or finish after the session's published times, as long as it overlaps the session.

## Files

- `Code.gs` — server code (reads and writes the sheet, enforces the rules)
- `Index.html` — the page
- `appsscript.json` — project settings (London time zone, sign-in and access)

## Setup (about 10 minutes)

1. Create a new Google Sheet (or open your existing tracker). The app adds four tabs, **Settings**, **Players**, **Bookings** and **Attendance**, and never touches other tabs.
2. In the sheet: **Extensions → Apps Script**.
3. Replace the contents of `Code.gs` with this `Code.gs`.
4. Click **+ → HTML**, name it `Index` (exactly), and paste in `Index.html`.
5. **Project Settings (gear) → tick "Show appsscript.json manifest file in editor"**, then paste in `appsscript.json`.
6. Back in the editor, choose the `setup` function and click **Run**. Approve the permissions. This creates the tabs.
7. **Deploy → New deployment → Web app**. Check it shows *Execute as: User accessing the web app* and *Who has access: Anyone with a Google account*. Click **Deploy** and copy the web app URL.
8. Share the **Google Sheet** with each admin as an **Editor**. Send them the web app URL.

## Using it

- **Add a booking:** tap **+** at the end of a court's lane (it starts at the court's first uncovered time and picks a length that fills the gap), or tap an empty spot on the lane to start at that time.
- **Change or delete a booking:** tap the green block.
- The form shows the finish time, notes when a booking starts before or runs past the session, and won't save if it clashes with another booking on that court.
- Court numbers are coloured by coverage of the published session: green = covered, yellow = partly, dashed = free.

### Players

The **Players** view lists everyone who books courts, plays on a booking or comes to sessions. Each player has a fixed ID (P0001, P0002 …) that bookings and attendance use, so renaming a player updates them everywhere.

- **Booker**: tick for the people who book courts. Only bookers appear under "Booked by" in the booking form.
- **Rename** and **Remove**: a player who is on a booking or an attendance record can't be removed; untick Booker instead.
- Names must be unique; add an initial to tell two people apart.

### Players on a booking and booking status

- Besides the booker, each booking can name **up to 3 players**, picked from the Players list. You don't need to name everyone who'll play. Add new people on the Players view first.
- A booking with at least one player named is **Confirmed**.
- A booking with no players named, made **more than 72 hours ahead**, starts as **Provisional** (hatched, "Prov" tag), with the deadline for naming players. One made **inside 72 hours** starts as **Confirmed**. The 72 comes from **Confirm players (hours before)** in Settings.
- When no players are named you can switch the status between Provisional and Confirmed yourself, for example once you've checked the club system.
- A provisional booking still with no players named at the deadline is flagged **"Cancelled?"** (orange), because the club may have cancelled it. Nothing is blocked: check the club system, then name the players, mark it confirmed, or delete it.
- The **Needs players** list at the top of the Sessions view shows "Cancelled?" bookings and any provisional booking whose deadline is within 2 days. Tap one to open it.

### Attendance and black marks

- Each session has an **Attendance** section (tap to open). It lists everyone named on that session's bookings, as booker or player.
- Mark each person **Attended** or **No-show**; tap again to clear. **Mark the rest attended** fills in everyone not yet checked.
- **Add a player who came** adds someone from the Players list who wasn't on a booking; they're marked attended. Remove them with ×.
- A **No-show** by someone named on a booking is a **black mark**: one per booking they were on that session. The Players view lists black marks from the last 12 months, and shows each player's count.

## Settings tab

Change these in the sheet; the app picks them up the next time anyone loads or refreshes the page. No code changes or redeploy needed.

| Setting | Default | Meaning |
|---|---|---|
| Book ahead days | 9 | Bookings open this many days before a session. Later sessions are locked, show their opening date, and the server refuses them. |
| Courts | 14 | Number of courts shown for each session. |
| Booking lengths (minutes) | 60, 90, 120 | The lengths offered in the booking form, separated by commas. |
| Confirm players (hours before) | 72 | A booking with no players named is *provisional*. Players must be named this many hours before it starts, or the club cancels it. If this row is missing, 72 is used. An older sheet's "Confirm opponent (hours before)" row also works. |
| Start time step (minutes) | 30 | Start times offered in the form (30 gives 06:00, 06:30, 07:00 …). Use 5, 10, 15, 20, 30 or 60. |

Below that, one row per session day:

| Day | Start | Finish |
|---|---|---|
| Wednesday | 06:30 | 08:00 |
| Friday | 06:30 | 08:00 |
| Sunday | 07:00 | 08:30 |

- **Day** can be written in full or shortened (Wed, Thurs). Each day may appear once.
- **Start** and **Finish** are the published session times, 24-hour. Bookings can go outside them (e.g. a Sunday court kept until 09:00 is just a booking that finishes at 09:00).
- Add a day by adding a row; remove one by deleting its row. The list ends at the first blank row.

If something in the tab doesn't make sense (a misspelt day, Finish before Start), the app shows a message naming the row to fix instead of loading.

## Who can use it

The app runs as the person using it, so access is controlled by the sheet's sharing:

- People the sheet is shared with as Editor can view and change bookings. They sign in with their Google account and approve the app once on first use (Google may show an "unverified app" screen: choose **Advanced → Go to …**).
- Anyone else who opens the link sees a message asking them to get access to the sheet. They can't read or change anything.
- Every booking records the editor's email in the **Updated by** column.

To remove someone, remove them from the sheet's sharing.

### If an admin sees the page but no bookings

The message under the title names the Google account the app is running as, and quotes Google's error:

- **"…can't open the bookings sheet"**: share the sheet with that exact address as an **Editor** (add the address directly; "anyone with the link" isn't enough).
- **"…couldn't tell which of your accounts to use"**: they're signed in to several Google accounts. Open the link in a private/incognito window and sign in with only the account the sheet is shared with.
- Make sure they're using the deployment link ending in `/exec`, not `/dev`.

## Updating the code

After editing, use **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. The URL stays the same.

### Upgrading from the version with a Bookers tab

The first time anyone loads the new version, the sheet is converted automatically:

- Everyone on the **Bookers** tab becomes a player with Booker ticked, and every opponent name on existing bookings becomes a player.
- The **Bookings** tab is rebuilt in the new layout. The old one is kept as **Bookings (before players)**. Bookings that had an opponent become Confirmed; those without become Provisional.
- The old **Bookers** tab is no longer used. Delete it, and the backup, once you're happy.

An older **Settings** tab keeps working.

## Editing the sheet by hand

**Players**: ID | Name | Booker. Leave ID blank on rows you add; the app fills it in. Put `Yes` under Booker for bookers.

**Bookings**: Date | Court | Start | Finish | Minutes | Status | Booker | Players | Booker name | Player names | Updated | Updated by | ID

- Date as `yyyy-mm-dd` (e.g. `2026-11-11`) or `dd/mm/yyyy`; Court as a number; Start as `hh:mm`.
- Fill in either **Minutes** or **Finish**; the app works out the other.
- **Status** is `Provisional` or `Confirmed`.
- **Booker** and **Players** hold player IDs (players separated by commas). On a row you add by hand you can leave them blank and type names under **Booker name** / **Player names** instead; they're matched to the Players list.
- Leave **ID** blank on rows you add; the app fills it in.

**Attendance**: Date | Player | Status | Added | Name | Updated | Updated by. Status is `Attended` or `No-show`; Added is `Yes` for players who weren't on a booking.

## Deployments

### `breakfast-tennis`

#### v1 `AKfycbyTcKlg_Dc93scNIxOrgQYwOzSlj0VQm0JRWcWqw9gXBulBGowHYAedBqDJg-0Nq-lN`

Click here -> https://script.google.com/macros/s/AKfycbyTcKlg_Dc93scNIxOrgQYwOzSlj0VQm0JRWcWqw9gXBulBGowHYAedBqDJg-0Nq-lN/exec

