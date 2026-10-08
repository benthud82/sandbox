# Weekend Planner

A small, locally hosted site for planning a weekend: a 4-day time grid you can
drag events around on, a meal grid that shows your real open windows, a list of
questions to confirm, a packing checklist, and an idea bank you can drop onto
the schedule. No build step, no dependencies.

It ships pre-loaded with the Oct 9–12, 2026 weekend with Channing. Hit
**More → Reset to original handoff** at any time to get back to that.

## Run it

**Option A: Node (recommended, saves to disk)**

```
cd weekend-planner
node server.js
```

Open http://localhost:4747. The plan is saved to `data/plan.json` on every
change (with a `.bak` of the previous version). `PORT=8080 node server.js`
changes the port.

**Option B: Apache / XAMPP / NetBeans with PHP**

Point your web root at this folder (or the repo root and browse to
`/weekend-planner/`). `api.php` handles persistence the same way, writing to
`data/plan.json`. The `data` folder must be writable by the web server.

**Option C: any static server, or just open `index.html`**

```
python3 -m http.server 4747
```

Without an API the planner still works; it saves to the browser's localStorage
and shows "Browser only" in the header. Use **More → Export JSON** to take the
plan somewhere else.

## Using it

| Where | What you can do |
|---|---|
| **Schedule → Grid** | Drag an event to move it (across days too). Drag the bottom edge to resize. Click to edit. Click a green "open" window to add something there. |
| **Event editor** | Title, day, start/end, all-day, location (with autocomplete from past locations), drive time (shows a *leave by* time), who is involved, category, status, notes. ±15m / +1h nudge buttons. Delete and Duplicate. Overlap warnings before you save. |
| **Schedule → List** | Phone-friendly agenda view. Also used for printing. |
| **Meals** | Breakfast / lunch / dinner for each day. The open window is computed from the schedule (including drive time). *Put on schedule* turns a meal into a timed event, and dragging that event updates the meal's time. |
| **Open items** | Questions to confirm, with an answer field and a link to the related event. Any event marked *Needs confirmation* also appears here with a one-click *Mark confirmed*. Checklist grouped by heading. |
| **Ideas** | Things to do. *Schedule* asks which day and drops the idea into the first open window long enough for it. |
| **Notes** | Free text. |
| **Header** | Undo (also Ctrl+Z), Add event (also the `n` key), Export / Import JSON, Print, dark mode, Reset. |

The "Next up" strip shows the next event with its leave-by time, total open
time across the weekend, how many things still need confirming, and any
overlaps between events that share a person.

## Files

```
index.html           page shell
app.js               all behaviour (vanilla JS)
styles.css           styling, dark mode, print, mobile
server.js            zero-dependency Node server + JSON API
api.php              same API for PHP hosting
data/plan.default.json   the seed plan (reset target)
data/plan.json       your live plan (created on first run, git-ignored)
```

### API

```
GET  /api/plan      current plan
PUT  /api/plan      replace plan (JSON body; must contain an events array)
POST /api/reset     reset to plan.default.json
```

## Editing the seed

`data/plan.default.json` is plain JSON. Change `meta.startDate` and
`meta.dayCount` to plan a different weekend, `meta.people` to change who is on
it, and `meta.dayStartHour` / `meta.dayEndHour` to change the grid's hours.
