# Apple Health → The System

The Home Screen app keeps its own saved data, separate from Safari. A shortcut that uses **Open URLs** opens Safari, not the Home Screen app, so the numbers would land in the wrong place.

This shortcut copies one line to the clipboard instead. You then open **The System** from the Home Screen icon and tap **Sync Apple Health**.

The line looks like this:

```
SYSTEM-HEALTH:{"v":1,"date":"2026-10-09","steps":6234,"weight":329.4,"sleep":6.8,"glucose":142,"glucoseType":"fasting","waist":null,"activeMin":22}
```

Commas and units are fine (`6,234`, `329.4 lb`, `6,8 h`). Use `null` when you don't have a value. No comments and no curly quotes.

Action names below match current iOS. A few labels differ on older versions; those spots say so.

## 1. Create the shortcut

1. Open the **Shortcuts** app.
2. On the **Shortcuts** tab, tap **+** in the top corner.
3. Tap the title at the top and name it **Sync Health to The System**.
4. To add any action below, use the search field at the bottom. It is labeled **Search Actions** or **Add Action**, depending on your iOS version.

### Date

5. Add **Current Date**.
6. Add **Format Date**. It should already be attached to Current Date. Set Date Format to **Custom**. In the format box (sometimes labeled **Format String**) type `yyyy-MM-dd`. Do not choose ISO 8601; that includes the time.

### Steps (today's total)

7. Add **Find Health Samples**. Set Type to **Steps**. Tap **Add Filter**, choose **Start Date**, then **is**, then **today**. Sort by can stay **Start Date**. Leave Limit off so every sample today is included.
8. The action title often changes to **Find All Health Samples where Type is Steps and Start Date is today**. That is the same action, not a second one.
9. Add **Calculate Statistics**. Set the input to those step samples (Shortcuts usually wires this for you). Set the statistic to **Sum**. If you do not see **Calculate Statistics**, use the older path: add **Get Details of Health Samples** (some versions say **Get Details of Health Sample**), then add **Calculate Statistics** and choose **Sum**.

### Weight (latest sample)

10. Add another **Find Health Samples**. Set Type to **Weight**. If Weight is not in the list, choose **Body Mass** — the label varies by iOS version. Set Sort by to **Start Date**, Order to **Latest First**, turn **Limit** on, and set it to **1**.
11. Add **Get Details of Health Samples** (or **Get Details of Health Sample**). Set Detail to **Value**, and set the input to that one weight sample. If that action is missing, you can tap the weight variable later inside the Text action and choose **Value** there. Same result.
12. The System expects **pounds**. If your Health app shows kilograms, add **Calculate** and multiply the weight by `2.205`. A kilogram number left as-is is under 80 and will be ignored.

### Sleep (last night, in hours)

13. Add **Find Health Samples**. Set Type to **Sleep Analysis**. Set Start Date to **is in the last** **1 day**. If your iOS version does not offer "in the last", choose **is yesterday**, or **is between** yesterday at 6:00 PM and today at 12:00 PM. Running this in the morning is the best match for last night. A 9:00 PM run usually still sees last night; a long nap today can be included.
14. If you see a **Category** filter, count time asleep, not time in bed. On older iOS set Category **is** **Asleep**. On iOS 16 and later, sleep is often split into stages. The names vary: **Asleep**, **Asleep Core**, **Asleep Deep**, **Asleep REM**, and **Asleep Unspecified**. Include the asleep stages and leave out **In Bed** and **Awake**. If the only choice is a single **Asleep** and the total looks too small (under a couple of hours after a full night), the stages are being excluded — widen the filter.
15. Add **Calculate Statistics** on those samples. Statistic: **Sum**. If a second menu appears, choose **Duration**.
16. The payload needs a plain number of **hours**, such as `6.8`. If the sum is already about 5 to 10, use it as-is. If it is a large number (seconds, often 15,000 to 40,000), add **Calculate** and divide by `3600`. If it reads like "6 hours, 48 minutes", tap that variable and pick a numeric form if one is offered; otherwise divide the seconds value by 3600. A sentence in the payload is not reliable.

### Blood glucose (latest today)

17. Add **Find Health Samples**. Set Type to **Blood Glucose**, Start Date **is today**, Sort by **Start Date**, Order **Latest First**, Limit **1**. If Blood Glucose is not in the type list, open the Health app, tap **Browse**, search **Blood Glucose**, and save one reading (a manual one is enough). Return to Shortcuts and the type should appear.
18. Add **Get Details of Health Samples** and set Detail to **Value**. US Health data is usually mg/dL, which is what The System expects. If the number is in mmol/L (typically under 30), multiply by `18` with **Calculate**, or include the unit text `mmol` in the payload and The System will convert it.

### Exercise minutes (optional)

19. Add **Find Health Samples**. Set Type to **Exercise Time**. On some iOS versions the type is labeled **Apple Exercise Time**. Start Date **is today**.
20. Add **Calculate Statistics** and choose **Sum**. That number is `activeMin`. If you skip exercise minutes, use `null` for `activeMin` in the text below.

Waist is not read automatically. Leave `"waist":null` unless you type a number of inches yourself.

### Copy the payload

21. Add **Text**. Focus the text box. Above the keyboard, tap the colored variable tokens to insert them — don't type the numbers by hand. The line should follow this shape, with your variables in place of the names:

```
SYSTEM-HEALTH:{"v":1,"date":"FORMATTED_DATE","steps":STEPS_SUM,"weight":WEIGHT_VALUE,"sleep":SLEEP_HOURS,"glucose":GLUCOSE_VALUE,"glucoseType":"fasting","waist":null,"activeMin":EXERCISE_SUM}
```

Keep the quotes around the date and around `fasting`. Do not put quotes around the numbers. Keep a comma between fields, and no comma after the last field. If this glucose reading is not fasting, change `fasting` to `before meal`, `2h after meal`, or `random`.

22. An empty variable turns the line into broken JSON, like `"weight":,`. For weight, sleep, glucose, and exercise minutes, add an **If** before the Text action: condition **has any value**. Under **Otherwise**, add a **Text** action that contains only `null`, and insert that Text token into the payload instead of the empty sample. **End If**. Steps can stay as the sum (zero is a real total). This If / Otherwise layout is the usual one; older iOS shows the same idea as "If / Otherwise".

23. Add **Copy to Clipboard**. Set the input to the Text from the payload step, not to a single number.
24. Add **Show Notification**. Put this sentence in the title or the body (some iOS versions have one field, some have Title and Body): `Health synced — open The System and tap Sync Apple Health`
25. Tap **Done**. Do not add **Open URLs** or **Open App**. Those open Safari.

## 2. Allow Health access (one time)

26. In the Shortcuts app, open **Sync Health to The System** and run it with the play button. Do this by hand before you rely on the evening automation. The permission question cannot appear from an automation.
27. iOS asks to read Health data the first time. Allow **Steps**, **Weight** (or Body Mass), **Sleep**, **Blood Glucose**, and **Exercise Time** if you included it. The button is **Allow** or **Turn On All**, depending on the iOS version.
28. If you dismissed one: open **Settings → Health → Data Access & Devices → Shortcuts** and turn the types on. On some iOS versions the path is **Settings → Privacy & Security → Health → Shortcuts**.
29. Open **The System** from the **Home Screen icon**, not from a Safari tab. Tap **Sync Apple Health**. If iOS asks to paste, tap **Allow Paste** or **Paste**. A system window lists what was imported.
30. If the paste prompt fails or the clipboard is empty, the app shows a box. Paste the `SYSTEM-HEALTH:` line there and tap **Import Pasted Health**.

## 3. Run it every evening

31. In Shortcuts, open the **Automation** tab.
32. Tap **+**, then **Create Personal Automation**. On newer iOS the first screen may already be the trigger list under **New Automation**.
33. Choose **Time of Day**. Set **9:00 PM** and repeat **Daily**. Continue with **Next** or **Done**, whichever that screen shows.
34. When it asks for the action, add **Run Shortcut** and choose **Sync Health to The System**. If you instead get a list of existing shortcuts, tap that shortcut. The screen varies by iOS version.
35. Turn on **Run Immediately**. On iOS 16 and earlier the switch is labeled **Ask Before Running** — turn that **off**. You want the shortcut to run without an extra tap. The label varies by version; the goal is the same.
36. Tap **Done**. The first few nights, iOS may still flash a short automation notice. That is normal.

## 4. Each night after that

The automation copies today's line at 9:00 PM. Next time you open The System, tap **Sync Apple Health**. The app also shows **Health data ready? Tap Sync** when it has not synced yet today. It will not read the clipboard by itself unless iOS has already allowed clipboard access, so the tap is required.

A Home Screen icon and a Safari tab do not share data. Always sync from the icon you actually use.

Desktop or a normal Safari tab can import the same line with a link: `https://sonofgiants.github.io/the-system/#health=` plus the payload, URL-encoded. That link opens Safari, not the Home Screen app.
