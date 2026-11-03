# Breakfast Tennis court bookings — setup

A small web app for the admin team to record court bookings for Breakfast Tennis sessions. Each session shows one lane per court on a time axis, with the published session times marked, so it's easy to see which courts are covered for the whole session, partly covered, or free. Data is stored in a Google Sheet; the page is served by Google Apps Script.

Bookings are individual time slots: a court can have several in one session (for example 06:00–07:00 and 07:00–08:30), and a booking may start before or finish after the session's published times, as long as it overlaps the session.

## Files

- `Code.gs` — server code (reads and writes the sheet, enforces the rules)
- `Index.html` — the page
- `appsscript.json` — project settings (London time zone, sign-in and access)

## Setup (about 10 minutes)

1. Create a new Google Sheet (or open your existing tracker). The app adds three tabs, **Settings**, **Bookings** and **Bookers**, and never touches other tabs.
2. In the sheet: **Extensions → Apps Script**.
3. Replace the contents of `Code.gs` with this `Code.gs`.
4. Click **+ → HTML**, name it `Index` (exactly), and paste in `Index.html`.
5. **Project Settings (gear) → tick "Show appsscript.json manifest file in editor"**, then paste in `appsscript.json`.
6. Back in the editor, choose the `setup` function and click **Run**. Approve the permissions. This creates the three tabs.
7. **Deploy → New deployment → Web app**. Check it shows *Execute as: User accessing the web app* and *Who has access: Anyone with a Google account*. Click **Deploy** and copy the web app URL.
8. Share the **Google Sheet** with each admin as an **Editor**. Send them the web app URL.

## Using it

- **Add a booking:** tap **+** at the end of a court's lane (it starts at the court's first uncovered time and picks a length that fills the gap), or tap an empty spot on the lane to start at that time.
- **Change or delete a booking:** tap the green block.
- The form shows the finish time, notes when a booking starts before or runs past the session, and won't save if it clashes with another booking on that court.
- Court numbers are coloured by coverage of the published session: green = covered, yellow = partly, dashed = free.

## Settings tab

Change these in the sheet; the app picks them up the next time anyone loads or refreshes the page. No code changes or redeploy needed.

| Setting | Default | Meaning |
|---|---|---|
| Book ahead days | 9 | Bookings open this many days before a session. Later sessions are locked, show their opening date, and the server refuses them. |
| Courts | 14 | Number of courts shown for each session. |
| Booking lengths (minutes) | 60, 90, 120 | The lengths offered in the booking form, separated by commas. |
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

## Updating the code

After editing, use **Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy**. The URL stays the same.

If you set up an earlier version of this app, its **Bookings** tab has a different layout. Rename or delete that tab and reload; the app creates a new one. An older **Settings** tab keeps working (its "Late finish" column is ignored, and booking lengths and start step use the defaults until you add those rows).

## Editing the sheet by hand

The **Bookings** tab columns are: Date | Court | Start | Finish | Minutes | Booker | Updated | Updated by | ID.

- Date as `yyyy-mm-dd` (e.g. `2026-11-11`) or `dd/mm/yyyy`; Court as a number; Start as `hh:mm`.
- Fill in either **Minutes** or **Finish**; the app works out the other.
- Leave **ID** blank on rows you add; the app fills it in.
- Booker names should match a name on the **Bookers** tab.
