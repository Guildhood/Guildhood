# Phase 1 two-iPad manual test

**Status: not yet run on physical iPads.** The same flows pass automatically in emulated iPads
(Chromium with iPad Pro 11 viewport and real touch events), both on `localhost` and over a
non-localhost address the way iPads reach the computer. Safari on real iPads has not been exercised:
fill in the results table below when you run it.

Setup: follow [RUNNING.md](RUNNING.md) → "Two-iPad test". You need iPad **A** and iPad **B** on the
same Wi-Fi as the computer running `npm run lan`. Use two different email addresses.

| # | Steps | Expected result |
|---|---|---|
| 1 | Open the printed address on both iPads in Safari. Rotate iPad A to portrait, then back. | Portrait shows "Turn your iPad sideways to play Guildhood."; landscape removes it. |
| 2 | Sign in on A (`ada@example.com`) and B (`bo@example.com`) with the codes from the terminal. | Each lands on the home screen: **500 Marks**, **Sprout Hatch** in the garage, a friend code like `ABCD-2345`, neighborhood **Copperleaf Commons**. |
| 3 | On A: tap the name chip, rename to `Ada`, Save. Tap a different paint swatch. Close the Safari tab, reopen the address. | Still signed in; name and paint color kept. |
| 4 | On B: type A's friend code in **Friends → Friend code**, tap **Add**. Watch A without touching it. | Within ~2 s A shows a toast "… sent you a friend request" and an **Accept** button, with no reload. |
| 5 | On A: tap **Accept**. | B's list shows A within ~2 s. |
| 6 | On A: tap **Drive**. | 3D neighborhood appears. Leave, ping, neighborhood name, and Invite sit inside the screen edges (not under rounded corners or the camera). Steering pad bottom-left; BRAKE and GO bottom-right. |
| 7 | On A: hold **GO** with the right thumb while sliding the left thumb across the steering pad. Release GO. Hold **BRAKE**. | Car accelerates and turns immediately; coasts when released; brakes to a stop, then reverses slowly. |
| 8 | On A: tap, double-tap, and long-press around the controls and the 3D view. | No page zoom, scrolling, text selection, magnifier, or callout menu. |
| 9 | On B: look at A in the friends list, tap **Join**. | B shows A with a green dot ("Driving in Copperleaf Commons (1/8)"). After Join, B starts near A; both show **2 drivers here**; each sees the other's car and name tag. |
| 10 | Drive both cars around; drive gently into each other and into a house. | Remote car moves smoothly (no jumping); cars bump each other; nobody drives through houses or out of the neighborhood. |
| 11 | On B: **Leave**. On A: **Invite → Invite** next to B. On B: tap **Join** in the toast. | B gets "Ada invited you to Copperleaf Commons" within ~2 s; Join puts B back in A's session. |
| 12 | On B: open Control Center and turn Wi-Fi **off** for ~5 s, then on. | B shows "Reconnecting…" within ~5 s; A sees B's car fade and stop. After Wi-Fi returns B is back in the same session ("Reconnected"), car where it stopped; A sees it solid again. |
| 13 | On B: Wi-Fi **off for 30 s**, then on. | After ~20 s A shows "… lost connection" and B's car disappears. When Wi-Fi returns B reconnects and rejoins A's session. |
| 14 | On B while driving: go to the Home Screen for ~10 s, then return to Guildhood. | Reconnects automatically into the same session. |
| 15 | On the computer: Ctrl+C, then `npm run lan` again. | Both iPads show "Reconnecting…", then rejoin a new session. Marks, names, and cars are unchanged. |
| 16 | Sign into Bo's account on a third screen (or a second Safari tab) and tap Drive. | The first screen shows "You started driving on another screen"; only one Bo car exists. |
| 17 | On A: **Leave**, **Sign out**, sign in again with the same email. | Same name, 500 Marks, same car and color. |

## Results

| # | iPad A model / iPadOS | iPad B model / iPadOS | Pass / Fail | Notes |
|---|---|---|---|---|
| 1 | | | not run | |
| 2 | | | not run | |
| 3 | | | not run | |
| 4 | | | not run | |
| 5 | | | not run | |
| 6 | | | not run | |
| 7 | | | not run | |
| 8 | | | not run | |
| 9 | | | not run | |
| 10 | | | not run | |
| 11 | | | not run | |
| 12 | | | not run | |
| 13 | | | not run | |
| 14 | | | not run | |
| 15 | | | not run | |
| 16 | | | not run | |
| 17 | | | not run | |

Also note: frame smoothness while driving, how the steering feels, readability of name tags, and
whether anything is hidden by the iPad's rounded corners or Stage Manager windowing.
